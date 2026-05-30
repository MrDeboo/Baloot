import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signSession } from "./auth.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server may still be binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Activity server health check.");
}

function discordPublicKeyHex(publicKey) {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return spki.subarray(-32).toString("hex");
}

function signedProxyHeaders(payload, privateKey) {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    "x-signature-ed25519": crypto.sign(null, payloadBytes, privateKey).toString("base64"),
    "x-signature-timestamp": String(payload.created_at),
    "x-discord-proxy-payload": payloadBytes.toString("base64")
  };
}

function proxyPayload(userId) {
  return {
    application_id: "123",
    created_at: 1000,
    expires_at: Math.floor(Date.now() / 1000) + 60,
    user: { id: userId }
  };
}

function activityInstance({ users = ["user-1"], instanceId = "instance-1", applicationId = "123" } = {}) {
  return {
    application_id: applicationId,
    instance_id: instanceId,
    users
  };
}

async function startFakeDiscordApi(handler) {
  const port = await reservePort();
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("production config rejects insecure mock users", async () => {
  const port = await reservePort();
  const server = spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      DISCORD_CLIENT_ID: "",
      DISCORD_CLIENT_SECRET: "",
      DISCORD_BOT_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
    assert.equal(config.allowInsecureDev, false);
    assert.equal(config.proxyPrefix, "");
    assert.equal(config.legacyProxyPrefix, "/.proxy");
    assert.equal(config.requiresActivityInstanceVerification, true);
    assert.equal(config.hasActivityInstanceVerifier, false);

    const events = await fetch(`${baseUrl}/api/events?room=prod&name=mock&userId=mock`);
    assert.equal(events.status, 401);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
});

test("production token exchange rejects Activity instance response mismatches", async () => {
  let instanceResponse = { application_id: "other-app", instance_id: "instance-1", users: ["user-1"] };
  const discord = await startFakeDiscordApi((request, response) => {
    const url = new URL(request.url, "http://discord.test");
    if (request.method === "POST" && url.pathname === "/oauth2/token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ access_token: "access-1", token_type: "Bearer", expires_in: 3600 }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/users/@me") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "user-1", username: "User One" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/applications/123/activity-instances/instance-1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(instanceResponse));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  const port = await reservePort();
  const server = spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      DISCORD_CLIENT_ID: "123",
      DISCORD_CLIENT_SECRET: "secret",
      DISCORD_BOT_TOKEN: "bot",
      DISCORD_API_BASE_URL: discord.baseUrl,
      ACTIVITY_SESSION_SECRET: "0123456789abcdef0123456789abcdef"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const token = await fetch(`${baseUrl}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "code-1", instanceId: "instance-1" })
    });
    assert.equal(token.status, 403);
    assert.match(await token.text(), /application mismatch/);

    instanceResponse = { application_id: "123", instance_id: "other-instance", users: ["user-1"] };
    const wrongInstance = await fetch(`${baseUrl}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "code-2", instanceId: "instance-1" })
    });
    assert.equal(wrongInstance.status, 403);
    assert.match(await wrongInstance.text(), /instance id mismatch/);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await discord.close();
  }
});

test("production API can require Discord proxy signatures", async () => {
  const port = await reservePort();
  const server = spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      DISCORD_CLIENT_ID: "123",
      DISCORD_CLIENT_SECRET: "secret",
      DISCORD_BOT_TOKEN: "bot",
      DISCORD_PROXY_PUBLIC_KEY: "0".repeat(64)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const config = await fetch(`${baseUrl}/api/config`);
    assert.equal(config.status, 401);
    assert.match(await config.text(), /proxy request verification failed/i);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
});

test("production API binds signed proxy users to Activity sessions", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const discord = await startFakeDiscordApi((request, response) => {
    const url = new URL(request.url, "http://discord.test");
    if (request.method === "GET" && url.pathname === "/applications/123/activity-instances/instance-1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(activityInstance({ users: ["user-1"] })));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  const port = await reservePort();
  const server = spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      DISCORD_CLIENT_ID: "123",
      DISCORD_CLIENT_SECRET: "secret",
      DISCORD_BOT_TOKEN: "bot",
      ACTIVITY_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      DISCORD_API_BASE_URL: discord.baseUrl,
      DISCORD_PROXY_PUBLIC_KEY: discordPublicKeyHex(publicKey)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const session = signSession(
      { user: { id: "user-1", name: "User One", avatar: "" }, instanceId: "instance-1" },
      { secret: "0123456789abcdef0123456789abcdef" }
    );

    const mismatch = await fetch(`${baseUrl}/api/events?session=${encodeURIComponent(session)}`, {
      headers: signedProxyHeaders(proxyPayload("user-2"), privateKey)
    });
    assert.equal(mismatch.status, 400);
    assert.match(await mismatch.text(), /proxy user does not match/i);

    const match = await fetch(`${baseUrl}/api/events?session=${encodeURIComponent(session)}`, {
      headers: signedProxyHeaders(proxyPayload("user-1"), privateKey)
    });
    assert.equal(match.status, 200);
    await match.body.cancel();
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await discord.close();
  }
});

test("production API revalidates Activity session membership on events and actions", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  let users = [];
  const discord = await startFakeDiscordApi((request, response) => {
    const url = new URL(request.url, "http://discord.test");
    if (request.method === "GET" && url.pathname === "/applications/123/activity-instances/instance-1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(activityInstance({ users })));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  const port = await reservePort();
  const server = spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      DISCORD_CLIENT_ID: "123",
      DISCORD_CLIENT_SECRET: "secret",
      DISCORD_BOT_TOKEN: "bot",
      DISCORD_API_BASE_URL: discord.baseUrl,
      ACTIVITY_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      DISCORD_PROXY_PUBLIC_KEY: discordPublicKeyHex(publicKey)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const session = signSession(
      { user: { id: "user-1", name: "User One", avatar: "" }, instanceId: "instance-1" },
      { secret: "0123456789abcdef0123456789abcdef" }
    );
    const headers = signedProxyHeaders(proxyPayload("user-1"), privateKey);

    const staleEvents = await fetch(`${baseUrl}/api/events?session=${encodeURIComponent(session)}`, { headers });
    assert.equal(staleEvents.status, 403);
    assert.match(await staleEvents.text(), /Activity instance verification failed/);

    const staleAction = await fetch(`${baseUrl}/api/action`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ session, kind: "BUY_CALL", call: "BAS" })
    });
    assert.equal(staleAction.status, 403);
    assert.match(await staleAction.text(), /Activity instance verification failed/);

    users = ["user-1"];
    const activeEvents = await fetch(`${baseUrl}/api/events?session=${encodeURIComponent(session)}`, { headers });
    assert.equal(activeEvents.status, 200);
    await activeEvents.body.cancel();
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
    await discord.close();
  }
});

test("Activity client serves the vendored Discord SDK without external CDN imports", async () => {
  const main = await fs.readFile(path.join(repoRoot, "activity/client/main.js"), "utf8");
  const serverSource = await fs.readFile(path.join(repoRoot, "activity/server/index.js"), "utf8");
  assert.doesNotMatch(main, /https:\/\/esm\.sh|https:\/\/cdn|unpkg\.com|jsdelivr\.net/);
  assert.match(main, /vendor\/discord-embedded-app-sdk\/output\/index\.mjs/);
  assert.match(main, /\bEvents\b/);
  assert.match(main, /getInstanceConnectedParticipants/);
  assert.match(main, /ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE/);
  assert.match(main, /openInviteDialog/);
  assert.match(serverSource, /https:\/\/discord\.com\/api\/v10/);
  assert.doesNotMatch(serverSource, /https:\/\/discord\.com\/api\/(?!v10)/);

  const port = await reservePort();
  const server = spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      ACTIVITY_ALLOW_INSECURE_DEV: "1",
      BALOOT_SERVER_BIN: "build/baloot-server",
      ACTIVITY_ASSET_VERSION: "config-test-version"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const html = await fetch(`${baseUrl}/`).then((response) => response.text());
    assert.match(html, /main\.js\?v=config-test-version/);
    assert.match(html, /styles\.css\?v=config-test-version/);
    assert.doesNotMatch(html, /%ACTIVITY_ASSET_VERSION%/);

    const response = await fetch(`${baseUrl}/vendor/discord-embedded-app-sdk/output/index.mjs`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(await response.text(), /DiscordSDK/);

    const legacyConfig = await fetch(`${baseUrl}/.proxy/api/config`);
    assert.equal(legacyConfig.status, 200);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
});
