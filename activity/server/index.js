import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ActivityHub } from "./room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const activityRoot = path.resolve(__dirname, "..");
const clientRoot = path.join(activityRoot, "client");
const port = Number(process.env.ACTIVITY_PORT ?? 3000);
const publicUrl = process.env.ACTIVITY_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const sessionSecret = process.env.ACTIVITY_SESSION_SECRET ?? "local-dev-secret";
const allowInsecureDev = process.env.ACTIVITY_ALLOW_INSECURE_DEV !== "0";
const hub = new ActivityHub();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
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

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signSession(user) {
  const payload = JSON.stringify({
    user,
    exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60
  });
  const encoded = base64url(payload);
  const signature = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload.user;
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
  const sessionUser = verifySession(session);
  if (sessionUser) return sessionUser;
  if (!allowInsecureDev) return null;

  const id = body.userId ?? url.searchParams.get("userId") ?? url.searchParams.get("name");
  const name = body.name ?? url.searchParams.get("name") ?? "Local Player";
  if (!id) return null;
  return { id: String(id), name: String(name), avatar: "" };
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
    response.writeHead(200, {
      "Content-Type": mimeTypes.get(path.extname(file)) ?? "application/octet-stream"
    });
    response.end(data);
  } catch {
    const fallback = await fs.readFile(path.join(clientRoot, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fallback);
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, publicUrl);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      json(response, 200, {
        clientId: process.env.DISCORD_CLIENT_ID ?? "",
        publicUrl,
        allowInsecureDev
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/token") {
      const body = await readBody(request);
      const token = await exchangeDiscordToken(body.code);
      json(response, 200, { ...token, session: signSession(token.user) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      const user = userFromRequest(url);
      if (!user) {
        json(response, 401, { error: "Missing or invalid Activity session." });
        return;
      }
      const room = hub.getRoom(url.searchParams.get("room"));
      room.connect({ user, response });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/action") {
      const body = await readBody(request);
      const user = userFromRequest(url, body);
      if (!user) {
        json(response, 401, { error: "Missing or invalid Activity session." });
        return;
      }
      const room = hub.getRoom(body.roomId);
      room.submitAction(user.id, body);
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url, response);
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 400, { error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Baloot Activity listening on http://127.0.0.1:${port}`);
});
