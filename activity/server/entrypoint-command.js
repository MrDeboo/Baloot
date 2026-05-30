import { pathToFileURL } from "node:url";

import { fetchDiscordApi } from "./discord-api.js";
import { loadEnvFile } from "./env.js";

export const PRIMARY_ENTRY_POINT = 4;
export const DISCORD_LAUNCH_ACTIVITY = 2;

function discordApiBase(env = process.env) {
  return env.DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";
}

function botHeaders(botToken) {
  return { Authorization: `Bot ${botToken}` };
}

function entrypointPayload(name = "launch", description = "Launch Baloot") {
  return {
    name,
    description,
    type: PRIMARY_ENTRY_POINT,
    handler: DISCORD_LAUNCH_ACTIVITY,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  };
}

function summarizeCommand(command) {
  return command
    ? {
        id: command.id,
        name: command.name,
        type: command.type,
        handler: command.handler,
        integration_types: command.integration_types ?? [],
        contexts: command.contexts ?? []
      }
    : null;
}

export async function getGlobalCommands({ clientId, botToken, fetchFn, apiBase = discordApiBase() }) {
  const response = await fetchDiscordApi(
    `${apiBase}/applications/${clientId}/commands`,
    { headers: botHeaders(botToken) },
    { fetchFn }
  );
  if (!response.ok) {
    throw new Error(`Discord returned ${response.status} while reading global commands.`);
  }
  const commands = await response.json();
  if (!Array.isArray(commands)) throw new Error("Discord global commands response was not an array.");
  return commands;
}

export function findEntryPointCommand(commands) {
  return commands.find((command) => Number(command.type) === PRIMARY_ENTRY_POINT) ?? null;
}

export function checkEntryPointCommand(commands) {
  const command = findEntryPointCommand(commands);
  if (!command) {
    return {
      ok: false,
      command: null,
      reason: "No PRIMARY_ENTRY_POINT command is registered."
    };
  }
  if (Number(command.handler) !== DISCORD_LAUNCH_ACTIVITY) {
    return {
      ok: false,
      command: summarizeCommand(command),
      reason: "Entry Point command does not use DISCORD_LAUNCH_ACTIVITY handler."
    };
  }
  return {
    ok: true,
    command: summarizeCommand(command),
    reason: "Entry Point command launches the Activity through Discord."
  };
}

export async function createEntryPointCommand({
  clientId,
  botToken,
  fetchFn,
  apiBase = discordApiBase(),
  name = "launch",
  description = "Launch Baloot"
}) {
  const response = await fetchDiscordApi(
    `${apiBase}/applications/${clientId}/commands`,
    {
      method: "POST",
      headers: { ...botHeaders(botToken), "Content-Type": "application/json" },
      body: JSON.stringify(entrypointPayload(name, description))
    },
    { fetchFn }
  );
  if (!response.ok) {
    throw new Error(`Discord returned ${response.status} while creating the Entry Point command.`);
  }
  return response.json();
}

export async function verifyEntryPointCommand(options) {
  const commands = await getGlobalCommands(options);
  const report = checkEntryPointCommand(commands);
  if (report.ok || !options.createIfMissing || report.command) return report;

  const command = await createEntryPointCommand(options);
  return {
    ok: true,
    command: summarizeCommand(command),
    reason: "Created PRIMARY_ENTRY_POINT command with DISCORD_LAUNCH_ACTIVITY handler."
  };
}

function parseArgs(argv) {
  const args = {
    create: false,
    name: "launch",
    description: "Launch Baloot"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--create") args.create = true;
    else if (arg === "--name") args.name = argv[++index] ?? "";
    else if (arg === "--description") args.description = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function requireEnv(env, key) {
  if (!env[key]) throw new Error(`${key} is required.`);
  return env[key];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile();
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await verifyEntryPointCommand({
      clientId: requireEnv(process.env, "DISCORD_CLIENT_ID"),
      botToken: requireEnv(process.env, "DISCORD_BOT_TOKEN"),
      createIfMissing: args.create,
      name: args.name,
      description: args.description,
      apiBase: discordApiBase(process.env)
    });
    console.log(`${report.ok ? "ok" : "fail"}: ${report.reason}`);
    if (report.command) console.log(JSON.stringify(report.command, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
