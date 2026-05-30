import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

    const config = await fetch(`${baseUrl}/.proxy/api/config`).then((response) => response.json());
    assert.equal(config.allowInsecureDev, false);
    assert.equal(config.requiresActivityInstanceVerification, true);
    assert.equal(config.hasActivityInstanceVerifier, false);

    const events = await fetch(`${baseUrl}/.proxy/api/events?room=prod&name=mock&userId=mock`);
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

    const config = await fetch(`${baseUrl}/.proxy/api/config`);
    assert.equal(config.status, 401);
    assert.match(await config.text(), /proxy request verification failed/i);
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
      BALOOT_SERVER_BIN: "build/baloot-server"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const response = await fetch(`${baseUrl}/vendor/discord-embedded-app-sdk/output/index.mjs`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
    assert.match(await response.text(), /DiscordSDK/);
  } finally {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
});
