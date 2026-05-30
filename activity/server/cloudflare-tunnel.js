import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { loadEnvFile } from "./env.js";

function parseArgs(argv) {
  const args = { origin: "", passthrough: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.origin = argv[++index] ?? "";
    else if (arg === "--") {
      args.passthrough = argv.slice(index + 1);
      break;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function localOrigin(env = process.env) {
  const host = env.ACTIVITY_HOST && env.ACTIVITY_HOST !== "0.0.0.0" ? env.ACTIVITY_HOST : "127.0.0.1";
  const port = env.ACTIVITY_PORT || "3000";
  return `http://${host}:${port}`;
}

function printTunnelHint(text, seen) {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (!match || seen.has(match[0])) return;
  seen.add(match[0]);
  console.log("");
  console.log(`Set ACTIVITY_PUBLIC_URL=${match[0]}`);
  console.log(`In Discord URL Mappings, map / to ${new URL(match[0]).host}`);
  console.log("Restart the Activity server after updating ACTIVITY_PUBLIC_URL so secure cookies match the tunnel.");
  console.log("");
}

export function runCloudflareTunnel(argv = process.argv.slice(2), env = process.env) {
  loadEnvFile();
  const args = parseArgs(argv);
  const origin = args.origin || env.ACTIVITY_TUNNEL_ORIGIN_URL || localOrigin(env);
  const child = spawn("cloudflared", ["tunnel", "--url", origin, ...args.passthrough], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const seen = new Set();

  console.log(`Starting Cloudflare Tunnel for ${origin}`);
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    process.stdout.write(text);
    printTunnelHint(text, seen);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    process.stderr.write(text);
    printTunnelHint(text, seen);
  });
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      console.error(
        "cloudflared was not found on PATH. Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      );
    } else {
      console.error(error.message);
    }
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`cloudflared exited with ${signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = code ?? 0;
    }
  });
  return child;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCloudflareTunnel();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
