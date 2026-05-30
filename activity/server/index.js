import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signSession, verifyDiscordProxyRequestHeaders, verifySession } from "./auth.js";
import { ActivityHub } from "./room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const activityRoot = path.resolve(__dirname, "..");
const clientRoot = path.join(activityRoot, "client");
const port = Number(process.env.ACTIVITY_PORT ?? 3000);
const host = process.env.ACTIVITY_HOST ?? "127.0.0.1";
const publicUrl = process.env.ACTIVITY_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const sessionSecret = process.env.ACTIVITY_SESSION_SECRET ?? "local-dev-secret";
const allowInsecureDev = process.env.ACTIVITY_ALLOW_INSECURE_DEV === "1";
const discordBotToken = process.env.DISCORD_BOT_TOKEN ?? "";
const discordProxyPublicKey = process.env.DISCORD_PROXY_PUBLIC_KEY || process.env.DISCORD_APPLICATION_PUBLIC_KEY || "";
const hub = new ActivityHub();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        reject(new Error("Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) resolve({});
      else {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error("Request body must be JSON."));
        }
      }
    });
    request.on("error", reject);
  });
}

async function verifyActivityInstance({ userId, instanceId }) {
  if (!discordBotToken) {
    return {
      verified: allowInsecureDev,
      skipped: allowInsecureDev,
      reason: allowInsecureDev ? "local development mode" : "DISCORD_BOT_TOKEN is required"
    };
  }
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId || !instanceId) {
    return { verified: false, skipped: false, reason: "missing client id or instance id" };
  }

  const response = await fetch(
    `https://discord.com/api/applications/${clientId}/activity-instances/${instanceId}`,
    { headers: { Authorization: `Bot ${discordBotToken}` } }
  );
  if (!response.ok) {
    return { verified: false, skipped: false, reason: `Discord returned ${response.status}` };
  }
  const instance = await response.json();
  return {
    verified: Array.isArray(instance.users) && instance.users.includes(userId),
    skipped: false,
    reason: "verified with Discord Activity Instance API"
  };
}

async function exchangeDiscordToken(code) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required for Discord auth.");
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code
    })
  });
  if (!tokenResponse.ok) {
    throw new Error(`Discord token exchange failed (${tokenResponse.status}).`);
  }
  const token = await tokenResponse.json();

  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `${token.token_type} ${token.access_token}` }
  });
  if (!userResponse.ok) {
    throw new Error(`Discord user lookup failed (${userResponse.status}).`);
  }
  const user = await userResponse.json();
  return {
    access_token: token.access_token,
    token_type: token.token_type,
    expires_in: token.expires_in,
    user: {
      id: user.id,
      name: user.global_name || user.username || `user-${user.id}`,
      avatar: user.avatar || ""
    }
  };
}

function userFromRequest(url, body = {}) {
  const session = body.session ?? url.searchParams.get("session");
  const sessionPayload = verifySession(session, { secret: sessionSecret });
  if (sessionPayload?.user) {
    return { user: sessionPayload.user, instanceId: sessionPayload.instanceId ?? "" };
  }

  if (!allowInsecureDev) return null;
  const id = body.userId ?? url.searchParams.get("userId") ?? url.searchParams.get("name");
  const name = body.name ?? url.searchParams.get("name") ?? "Local Player";
  if (!id) return null;
  return {
    user: { id: String(id), name: String(name), avatar: "" },
    instanceId: body.roomId ?? url.searchParams.get("room") ?? "local"
  };
}

async function serveStatic(url, response) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const resolved = path.resolve(clientRoot, `.${requested}`);
  if (!resolved.startsWith(clientRoot)) {
    json(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const stat = await fs.stat(resolved);
    const file = stat.isDirectory() ? path.join(resolved, "index.html") : resolved;
    const data = await fs.readFile(file);
    const contentType = mimeTypes.get(path.extname(file)) ?? "application/octet-stream";
    const headers = { "Content-Type": contentType };
    if (!contentType.startsWith("text/html")) headers["Cache-Control"] = "no-store";
    response.writeHead(200, headers);
    response.end(data);
  } catch {
    const fallback = await fs.readFile(path.join(clientRoot, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fallback);
  }
}

function verifyProxyRequest(request, requestPath) {
  if (allowInsecureDev || !discordProxyPublicKey || !requestPath.startsWith("/api/") || requestPath === "/api/health") {
    return { verified: true, skipped: true };
  }
  return verifyDiscordProxyRequestHeaders(request.headers, {
    publicKey: discordProxyPublicKey,
    clientId: process.env.DISCORD_CLIENT_ID ?? ""
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, publicUrl);
  const requestPath = url.pathname.startsWith("/.proxy/")
    ? url.pathname.slice("/.proxy".length)
    : url.pathname;

  try {
    const proxy = verifyProxyRequest(request, requestPath);
    if (!proxy.verified) {
      json(response, 401, { error: "Discord proxy request verification failed.", reason: proxy.reason });
      return;
    }

    if (request.method === "GET" && requestPath === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && requestPath === "/api/config") {
      json(response, 200, {
        clientId: process.env.DISCORD_CLIENT_ID ?? "",
        publicUrl,
        allowInsecureDev,
        proxyPrefix: "",
        legacyProxyPrefix: "/.proxy",
        requiresActivityInstanceVerification: !allowInsecureDev || Boolean(discordBotToken),
        hasActivityInstanceVerifier: Boolean(discordBotToken),
        requiresProxyRequestSignature: !allowInsecureDev && Boolean(discordProxyPublicKey)
      });
      return;
    }

    if (request.method === "POST" && requestPath === "/api/token") {
      const body = await readBody(request);
      const token = await exchangeDiscordToken(body.code);
      const instanceId = typeof body.instanceId === "string" ? body.instanceId : "";
      const instance = await verifyActivityInstance({ userId: token.user.id, instanceId });
      if (!instance.verified) {
        json(response, 403, {
          error: "Discord Activity instance verification failed.",
          reason: instance.reason
        });
        return;
      }
      json(response, 200, {
        ...token,
        instance,
        session: signSession({ user: token.user, instanceId }, { secret: sessionSecret })
      });
      return;
    }

    if (request.method === "GET" && requestPath === "/api/events") {
      const auth = userFromRequest(url);
      if (!auth) {
        json(response, 401, { error: "Missing or invalid Activity session." });
        return;
      }
      const room = hub.getRoom(auth.instanceId || url.searchParams.get("room"));
      room.connect({ user: auth.user, response });
      return;
    }

    if (request.method === "POST" && requestPath === "/api/action") {
      const body = await readBody(request);
      const auth = userFromRequest(url, body);
      if (!auth) {
        json(response, 401, { error: "Missing or invalid Activity session." });
        return;
      }
      const room = hub.getRoom(auth.instanceId || body.roomId);
      room.submitAction(auth.user.id, body);
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(new URL(requestPath, publicUrl), response);
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Baloot Activity listening on http://${host}:${port}`);
});
