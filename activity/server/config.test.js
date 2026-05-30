import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
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
  }
});

test("Activity client serves the vendored Discord SDK without external CDN imports", async () => {
  const main = await fs.readFile(path.join(repoRoot, "activity/client/main.js"), "utf8");
  assert.doesNotMatch(main, /https:\/\/esm\.sh|https:\/\/cdn|unpkg\.com|jsdelivr\.net/);
  assert.match(main, /vendor\/discord-embedded-app-sdk\/output\/index\.mjs/);

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
