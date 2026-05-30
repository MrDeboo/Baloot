import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { validateActivityConfig } from "./preflight.js";
import { resolveEngineBinary } from "./room.js";

const repoRoot = path.resolve("/repo");
const cwd = path.join(repoRoot, "activity");
const enginePath = path.join(repoRoot, "build", "baloot-server");

function exists(candidate) {
  return candidate === enginePath;
}

test("preflight fails closed for incomplete production config", () => {
  const report = validateActivityConfig(
    {
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      ACTIVITY_SESSION_SECRET: "local-dev-secret",
      ACTIVITY_PUBLIC_URL: "http://127.0.0.1:3000",
      BALOOT_SERVER_BIN: "../build/baloot-server"
    },
    { exists, cwd, repoRoot, nodeVersion: "24.0.0" }
  );

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /DISCORD_CLIENT_ID/);
  assert.match(report.errors.join("\n"), /DISCORD_CLIENT_SECRET/);
  assert.match(report.errors.join("\n"), /DISCORD_BOT_TOKEN/);
  assert.match(report.errors.join("\n"), /long random secret/);
  assert.match(report.errors.join("\n"), /https/);
  assert.match(report.errors.join("\n"), /loopback/);
});

test("preflight accepts complete production config", () => {
  const report = validateActivityConfig(
    {
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      DISCORD_CLIENT_ID: "123",
      DISCORD_CLIENT_SECRET: "secret",
      DISCORD_BOT_TOKEN: "bot",
      ACTIVITY_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      ACTIVITY_PUBLIC_URL: "https://activity.example.com",
      ACTIVITY_PORT: "3000",
      BALOOT_SERVER_BIN: "../build/baloot-server"
    },
    { exists, cwd, repoRoot, nodeVersion: "24.0.0" }
  );

  assert.equal(report.ok, true);
  assert.equal(report.config.production, true);
  assert.equal(report.config.engineBin, enginePath);
});

test("preflight rejects malformed Discord proxy public keys", () => {
  const report = validateActivityConfig(
    {
      ACTIVITY_ALLOW_INSECURE_DEV: "0",
      DISCORD_CLIENT_ID: "123",
      DISCORD_CLIENT_SECRET: "secret",
      DISCORD_BOT_TOKEN: "bot",
      DISCORD_PROXY_PUBLIC_KEY: "not-hex",
      ACTIVITY_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      ACTIVITY_PUBLIC_URL: "https://activity.example.com",
      BALOOT_SERVER_BIN: "../build/baloot-server"
    },
    { exists, cwd, repoRoot, nodeVersion: "24.0.0" }
  );

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /DISCORD_PROXY_PUBLIC_KEY/);
});

test("preflight allows local dev without Discord credentials but still requires engine", () => {
  const report = validateActivityConfig(
    {
      ACTIVITY_ALLOW_INSECURE_DEV: "1",
      ACTIVITY_PUBLIC_URL: "http://127.0.0.1:3000",
      BALOOT_SERVER_BIN: "../build/baloot-server"
    },
    { exists, cwd, repoRoot, nodeVersion: "24.0.0" }
  );

  assert.equal(report.ok, true);
  assert.match(report.warnings.join("\n"), /mock local users/);
});

test("engine binary resolver handles Activity-relative env paths", () => {
  const resolved = resolveEngineBinary("../build/baloot-server", { exists, cwd: repoRoot, root: repoRoot });
  assert.equal(resolved, enginePath);
});
