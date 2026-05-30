import { pathToFileURL } from "node:url";

import { verifyActivityDeployment } from "./deploy-check.js";
import { verifyEntryPointCommand } from "./entrypoint-command.js";
import { loadEnvFile } from "./env.js";
import { validateActivityConfig } from "./preflight.js";

function hasValue(env, key) {
  return typeof env[key] === "string" && env[key].trim() !== "";
}

function signedApiDefault(env) {
  return Boolean(env.DISCORD_PROXY_PUBLIC_KEY || env.DISCORD_APPLICATION_PUBLIC_KEY);
}

function addSection(sections, name, report) {
  sections.push({ name, ...report });
}

function checksFromDeployment(report) {
  return report.checks.map((check) => ({ ok: check.ok, message: check.message }));
}

function checksFromConfig(report) {
  return [
    {
      ok: report.ok,
      message: `config is valid for ${report.config.production ? "production" : "local development"}`
    }
  ];
}

export async function verifyActivityReadiness(env = process.env, options = {}) {
  const sections = [];
  const errors = [];
  const warnings = [];
  const validateConfig = options.validateConfig ?? validateActivityConfig;
  const verifyDeployment = options.verifyDeployment ?? verifyActivityDeployment;
  const verifyEntrypoint = options.verifyEntrypoint ?? verifyEntryPointCommand;

  const config = validateConfig(env, options.configOptions ?? {});
  addSection(sections, "preflight", {
    ok: config.ok,
    checks: checksFromConfig(config),
    errors: config.errors,
    warnings: config.warnings
  });
  errors.push(...config.errors.map((error) => `preflight: ${error}`));
  warnings.push(...config.warnings.map((warning) => `preflight: ${warning}`));

  if (!options.skipDeployment) {
    const url = options.url || env.ACTIVITY_PUBLIC_URL || "";
    if (!url) {
      const message = "ACTIVITY_PUBLIC_URL is required for deployment readiness.";
      addSection(sections, "deployment", { ok: false, checks: [], errors: [message], warnings: [] });
      errors.push(`deployment: ${message}`);
    } else {
      try {
        const deployment = await verifyDeployment(url, {
          allowDev: Boolean(options.allowDev),
          allowHttp: Boolean(options.allowHttp),
          allowSignedApi: options.allowSignedApi ?? signedApiDefault(env)
        });
        addSection(sections, "deployment", {
          ok: deployment.ok,
          checks: checksFromDeployment(deployment),
          errors: deployment.errors,
          warnings: deployment.warnings
        });
        errors.push(...deployment.errors.map((error) => `deployment: ${error}`));
        warnings.push(...deployment.warnings.map((warning) => `deployment: ${warning}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addSection(sections, "deployment", { ok: false, checks: [], errors: [message], warnings: [] });
        errors.push(`deployment: ${message}`);
      }
    }
  }

  if (!options.skipEntrypoint) {
    const missing = ["DISCORD_CLIENT_ID", "DISCORD_BOT_TOKEN"].filter((key) => !hasValue(env, key));
    if (missing.length > 0) {
      const message = `${missing.join(", ")} required for Entry Point readiness.`;
      addSection(sections, "entrypoint", { ok: false, checks: [], errors: [message], warnings: [] });
      errors.push(`entrypoint: ${message}`);
    } else {
      try {
        const entrypoint = await verifyEntrypoint({
          clientId: env.DISCORD_CLIENT_ID,
          botToken: env.DISCORD_BOT_TOKEN,
          apiBase: env.DISCORD_API_BASE_URL,
          createIfMissing: Boolean(options.createEntrypoint),
          name: options.entrypointName ?? "launch",
          description: options.entrypointDescription ?? "Launch Baloot"
        });
        addSection(sections, "entrypoint", {
          ok: entrypoint.ok,
          checks: [{ ok: entrypoint.ok, message: entrypoint.reason }],
          errors: entrypoint.ok ? [] : [entrypoint.reason],
          warnings: []
        });
        if (!entrypoint.ok) errors.push(`entrypoint: ${entrypoint.reason}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addSection(sections, "entrypoint", { ok: false, checks: [], errors: [message], warnings: [] });
        errors.push(`entrypoint: ${message}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    sections,
    errors,
    warnings
  };
}

function parseArgs(argv) {
  const args = {
    url: "",
    allowDev: false,
    allowHttp: false,
    allowSignedApi: undefined,
    createEntrypoint: false,
    skipDeployment: false,
    skipEntrypoint: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") args.url = argv[++index] ?? "";
    else if (arg === "--allow-dev") args.allowDev = true;
    else if (arg === "--allow-http") args.allowHttp = true;
    else if (arg === "--allow-signed-api") args.allowSignedApi = true;
    else if (arg === "--create-entrypoint") args.createEntrypoint = true;
    else if (arg === "--skip-deploy") args.skipDeployment = true;
    else if (arg === "--skip-entrypoint") args.skipEntrypoint = true;
    else if (arg === "--json") args.json = true;
    else if (!arg.startsWith("--") && !args.url) args.url = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printReport(report) {
  for (const section of report.sections) {
    console.log(`${section.ok ? "ok" : "fail"}: ${section.name}`);
    for (const check of section.checks) {
      const prefix = check.warning ? "warning" : check.ok ? "ok" : "fail";
      console.log(`  ${prefix}: ${check.message}`);
    }
    for (const warning of section.warnings) console.warn(`  warning: ${warning}`);
    for (const error of section.errors) console.error(`  error: ${error}`);
  }
  if (!report.ok) {
    console.error("Baloot Activity readiness failed:");
    for (const error of report.errors) console.error(`- ${error}`);
    return;
  }
  console.log("Baloot Activity readiness passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await verifyActivityReadiness(process.env, args);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
