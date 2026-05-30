import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyActivityDeployment } from "./deploy-check.js";

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

function startServer(port, env) {
  return spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      BALOOT_SERVER_BIN: "build/baloot-server",
      ACTIVITY_ASSET_VERSION: "deploy-check-test",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((resolve) => {
    server.once("exit", resolve);
    server.kill();
  });
}

test("deployment verifier accepts an explicitly allowed local development server", async () => {
  const port = await reservePort();
  const server = startServer(port, {
    ACTIVITY_ALLOW_INSECURE_DEV: "1"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const report = await verifyActivityDeployment(baseUrl, { allowDev: true, allowHttp: true });
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);
    assert.ok(report.checks.some((check) => check.ok && check.message.includes("versioned JS and CSS")));
  } finally {
    await stopServer(server);
  }
});

test("deployment verifier rejects local development when production is expected", async () => {
  const port = await reservePort();
  const server = startServer(port, {
    ACTIVITY_ALLOW_INSECURE_DEV: "1"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const report = await verifyActivityDeployment(baseUrl, { allowHttp: true });
    assert.equal(report.ok, false);
    assert.match(report.errors.join("\n"), /ACTIVITY_ALLOW_INSECURE_DEV/);
  } finally {
    await stopServer(server);
  }
});

test("deployment verifier accepts production-style config", async () => {
  const port = await reservePort();
  const server = startServer(port, {
    ACTIVITY_ALLOW_INSECURE_DEV: "0",
    DISCORD_CLIENT_ID: "123",
    DISCORD_CLIENT_SECRET: "secret",
    DISCORD_BOT_TOKEN: "bot",
    ACTIVITY_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    ACTIVITY_PUBLIC_URL: "https://activity.example.com"
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    const report = await verifyActivityDeployment(baseUrl, { allowHttp: true });
    assert.equal(report.ok, true);
    assert.match(report.warnings.join("\n"), /proxy request signature checks/i);
  } finally {
    await stopServer(server);
  }
});
