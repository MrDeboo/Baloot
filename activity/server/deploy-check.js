import { pathToFileURL } from "node:url";

import { loadEnvFile } from "./env.js";

const SDK_PATH = "/vendor/discord-embedded-app-sdk/output/index.mjs";
const CDN_PATTERN = /https:\/\/(?:esm\.sh|cdn|unpkg\.com|cdn\.jsdelivr\.net|jsdelivr\.net)/i;

function makeUrl(baseUrl, path) {
  const base = new URL(baseUrl);
  return new URL(path, `${base.origin}/`).toString();
}

async function readResponse(baseUrl, path) {
  const response = await fetch(makeUrl(baseUrl, path));
  const text = await response.text();
  return { response, text };
}

function contentType(response) {
  return response.headers.get("content-type") ?? "";
}

function cacheControl(response) {
  return response.headers.get("cache-control") ?? "";
}

function addCheck(checks, ok, message) {
  checks.push({ ok, message });
}

async function checkJson(baseUrl, path) {
  const { response, text } = await readResponse(baseUrl, path);
  try {
    return { response, json: JSON.parse(text), text };
  } catch {
    return { response, json: null, text };
  }
}

export async function verifyActivityDeployment(baseUrl, options = {}) {
  const errors = [];
  const warnings = [];
  const checks = [];
  const allowHttp = Boolean(options.allowHttp);
  const allowDev = Boolean(options.allowDev);
  const allowSignedApi = Boolean(options.allowSignedApi);

  let parsedUrl = null;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    errors.push("Activity URL is not a valid URL.");
    return { ok: false, errors, warnings, checks };
  }

  if (parsedUrl.protocol !== "https:" && !allowHttp) {
    errors.push("Activity URL must use https:// unless --allow-http is set.");
  }

  const html = await readResponse(parsedUrl.toString(), "/");
  addCheck(checks, html.response.ok, "Activity root returns HTTP 200.");
  if (!html.response.ok) errors.push(`Activity root returned ${html.response.status}.`);
  if (!contentType(html.response).includes("text/html")) {
    errors.push("Activity root must serve text/html.");
  }
  const hasVersionedAssets = html.text.includes("main.js?v=") && html.text.includes("styles.css?v=");
  addCheck(checks, hasVersionedAssets, "Activity HTML includes versioned JS and CSS asset URLs.");
  if (!hasVersionedAssets) {
    errors.push("Activity HTML must include versioned JS and CSS asset URLs.");
  }
  if (html.text.includes("%ACTIVITY_ASSET_VERSION%")) {
    errors.push("Activity HTML still contains the asset version placeholder.");
  }

  const health = await checkJson(parsedUrl.toString(), "/api/health");
  addCheck(checks, health.response.ok && health.json?.ok === true, "Activity health endpoint returns ok.");
  if (!health.response.ok || health.json?.ok !== true) {
    errors.push("/api/health must return JSON { ok: true }.");
  }

  const config = await checkJson(parsedUrl.toString(), "/api/config");
  if (config.response.status === 401 && allowSignedApi) {
    warnings.push("/api/config requires Discord proxy signatures, so direct deployment config checks were skipped.");
  } else if (!config.response.ok || !config.json) {
    errors.push(`/api/config must return JSON configuration; got HTTP ${config.response.status}.`);
  } else {
    addCheck(checks, config.json.proxyPrefix === "", "Activity config uses canonical same-origin API paths.");
    if (config.json.proxyPrefix !== "") errors.push("Activity config proxyPrefix must be an empty string.");
    if (!allowDev) {
      if (config.json.allowInsecureDev) errors.push("Production deployment has ACTIVITY_ALLOW_INSECURE_DEV enabled.");
      if (!config.json.clientId) errors.push("Production deployment did not expose DISCORD_CLIENT_ID.");
      if (!config.json.requiresActivityInstanceVerification) {
        errors.push("Production deployment must require Discord Activity instance verification.");
      }
      if (!config.json.hasActivityInstanceVerifier) {
        errors.push("Production deployment must have DISCORD_BOT_TOKEN configured for instance verification.");
      }
      if (!config.json.requiresProxyRequestSignature) {
        warnings.push("Discord proxy request signature checks are not enabled for this deployment.");
      }
    }
  }

  const main = await readResponse(parsedUrl.toString(), "/main.js");
  addCheck(checks, main.response.ok, "Activity main.js is reachable.");
  if (!main.response.ok) errors.push(`main.js returned ${main.response.status}.`);
  if (!contentType(main.response).includes("javascript")) errors.push("main.js must be served as JavaScript.");
  if (!cacheControl(main.response).includes("no-store")) errors.push("main.js must be served with Cache-Control: no-store.");
  if (!main.text.includes("vendor/discord-embedded-app-sdk/output/index.mjs")) {
    errors.push("main.js must import the vendored Discord Embedded App SDK.");
  }
  if (CDN_PATTERN.test(main.text)) {
    errors.push("main.js must not import Activity runtime code from an external CDN.");
  }

  const styles = await readResponse(parsedUrl.toString(), "/styles.css");
  addCheck(checks, styles.response.ok, "Activity styles.css is reachable.");
  if (!styles.response.ok) errors.push(`styles.css returned ${styles.response.status}.`);
  if (!contentType(styles.response).includes("text/css")) errors.push("styles.css must be served as text/css.");
  if (!cacheControl(styles.response).includes("no-store")) {
    errors.push("styles.css must be served with Cache-Control: no-store.");
  }

  const sdk = await readResponse(parsedUrl.toString(), SDK_PATH);
  addCheck(checks, sdk.response.ok, "Vendored Discord SDK asset is reachable.");
  if (!sdk.response.ok) errors.push(`Vendored Discord SDK returned ${sdk.response.status}.`);
  if (!contentType(sdk.response).includes("javascript")) {
    errors.push("Vendored Discord SDK must be served as JavaScript.");
  }
  if (!cacheControl(sdk.response).includes("no-store")) {
    errors.push("Vendored Discord SDK must be served with Cache-Control: no-store.");
  }
  if (!sdk.text.includes("DiscordSDK")) errors.push("Vendored Discord SDK asset does not look like the SDK bundle.");

  const legacyHealth = await checkJson(parsedUrl.toString(), "/.proxy/api/health");
  addCheck(checks, legacyHealth.response.ok && legacyHealth.json?.ok === true, "Legacy .proxy health alias still works.");
  if (!legacyHealth.response.ok || legacyHealth.json?.ok !== true) {
    errors.push("Legacy /.proxy/api/health alias must remain available.");
  }

  return { ok: errors.length === 0, errors, warnings, checks };
}

function parseArgs(argv) {
  const args = {
    url: "",
    allowDev: false,
    allowHttp: false,
    allowSignedApi: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.url = argv[++index] ?? "";
    else if (arg === "--allow-dev") args.allowDev = true;
    else if (arg === "--allow-http") args.allowHttp = true;
    else if (arg === "--allow-signed-api") args.allowSignedApi = true;
    else if (arg === "--json") args.json = true;
    else if (!arg.startsWith("--") && !args.url) args.url = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printReport(report) {
  for (const check of report.checks) {
    console.log(`${check.ok ? "ok" : "fail"}: ${check.message}`);
  }
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  if (!report.ok) {
    console.error("Baloot Activity deployment check failed:");
    for (const error of report.errors) console.error(`- ${error}`);
    return;
  }
  console.log("Baloot Activity deployment check passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  try {
    const args = parseArgs(process.argv.slice(2));
    const url = args.url || process.env.ACTIVITY_PUBLIC_URL || "";
    if (!url) throw new Error("Provide an Activity URL with --url or ACTIVITY_PUBLIC_URL.");
    const report = await verifyActivityDeployment(url, {
      allowDev: args.allowDev,
      allowHttp: args.allowHttp,
      allowSignedApi:
        args.allowSignedApi ||
        Boolean(process.env.DISCORD_PROXY_PUBLIC_KEY || process.env.DISCORD_APPLICATION_PUBLIC_KEY)
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
