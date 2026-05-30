import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadEnvFile } from "./env.js";
import { engineBinaryCandidates, resolveEngineBinary } from "./room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function hasValue(env, key) {
  return typeof env[key] === "string" && env[key].trim() !== "";
}

function isWeakSecret(value) {
  return !value || value.length < 32 || value === "local-dev-secret" || value.includes("replace-this");
}

function parsePublicUrl(value) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function integerEnv(env, key, fallback) {
  const raw = env[key] ?? String(fallback);
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

export function validateActivityConfig(env = process.env, options = {}) {
  const errors = [];
  const warnings = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(String(nodeVersion).split(".")[0]);
  const production = env.ACTIVITY_ALLOW_INSECURE_DEV !== "1";
  const exists = options.exists ?? fs.existsSync;
  const cwd = options.cwd ?? process.cwd();
  const root = options.repoRoot ?? repoRoot;

  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    errors.push(`Node.js 20 or newer is required; current version is ${nodeVersion}.`);
  }

  const engineBin = resolveEngineBinary(env.BALOOT_SERVER_BIN, { exists, cwd, root });
  const engineCandidates = engineBinaryCandidates(env.BALOOT_SERVER_BIN, { cwd, root });
  if (!exists(engineBin)) {
    errors.push(`BALOOT_SERVER_BIN was not found. Checked: ${engineCandidates.join(", ")}`);
  }

  const port = integerEnv(env, "ACTIVITY_PORT", 3000);
  if (port === null || port <= 0 || port > 65535) errors.push("ACTIVITY_PORT must be a TCP port number.");

  const targetScore = integerEnv(env, "BALOOT_TARGET_SCORE", 152);
  if (targetScore === null || targetScore <= 0) errors.push("BALOOT_TARGET_SCORE must be a positive integer.");

  const readTimeout = integerEnv(env, "BALOOT_READ_TIMEOUT_MS", 900000);
  if (readTimeout === null || readTimeout < 1000) {
    errors.push("BALOOT_READ_TIMEOUT_MS must be an integer of at least 1000.");
  }

  const disconnectGrace = integerEnv(env, "ACTIVITY_DISCONNECT_GRACE_MS", 10000);
  if (disconnectGrace === null || disconnectGrace < 0) {
    errors.push("ACTIVITY_DISCONNECT_GRACE_MS must be an integer of at least 0.");
  }

  const publicUrl = parsePublicUrl(env.ACTIVITY_PUBLIC_URL ?? "");
  if (production) {
    for (const key of ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN"]) {
      if (!hasValue(env, key)) errors.push(`${key} is required when ACTIVITY_ALLOW_INSECURE_DEV is not 1.`);
    }
    if (isWeakSecret(env.ACTIVITY_SESSION_SECRET ?? "")) {
      errors.push("ACTIVITY_SESSION_SECRET must be a long random secret in production.");
    }
    if (!publicUrl) {
      errors.push("ACTIVITY_PUBLIC_URL must be set to your public HTTPS Activity origin.");
    } else {
      if (publicUrl.protocol !== "https:") errors.push("ACTIVITY_PUBLIC_URL must use https:// in production.");
      if (isLoopbackHost(publicUrl.hostname)) {
        errors.push("ACTIVITY_PUBLIC_URL cannot be localhost or loopback in production.");
      }
    }
  } else {
    warnings.push("ACTIVITY_ALLOW_INSECURE_DEV=1 allows mock local users. Do not use this for Discord production.");
  }

  if (production && env.ACTIVITY_HOST === "127.0.0.1") {
    warnings.push("ACTIVITY_HOST=127.0.0.1 is fine behind a local reverse proxy, but containers usually need 0.0.0.0.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    config: {
      production,
      engineBin,
      publicUrl: publicUrl?.toString() ?? "",
      port: port ?? null,
      targetScore: targetScore ?? null,
      readTimeoutMs: readTimeout ?? null,
      disconnectGraceMs: disconnectGrace ?? null
    }
  };
}

function printReport(report) {
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  if (!report.ok) {
    console.error("Baloot Activity preflight failed:");
    for (const error of report.errors) console.error(`- ${error}`);
    return;
  }
  console.log("Baloot Activity preflight passed.");
  console.log(`engine: ${report.config.engineBin}`);
  console.log(`mode: ${report.config.production ? "production" : "local development"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  const report = validateActivityConfig(process.env, { exists: (candidate) => Boolean(candidate) && fs.existsSync(candidate) });
  printReport(report);
  if (!report.ok) process.exitCode = 1;
}
