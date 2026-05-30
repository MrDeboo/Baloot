import test from "node:test";
import assert from "node:assert/strict";

import {
  checkEntryPointCommand,
  createEntryPointCommand,
  verifyEntryPointCommand
} from "./entrypoint-command.js";

test("Entry Point command check accepts Discord launch handler", () => {
  const report = checkEntryPointCommand([
    { id: "cmd-1", name: "launch", type: 4, handler: 2, integration_types: [0, 1], contexts: [0, 1, 2] }
  ]);

  assert.equal(report.ok, true);
  assert.equal(report.command.id, "cmd-1");
});

test("Entry Point command check rejects missing or app-handled commands", () => {
  assert.equal(checkEntryPointCommand([{ id: "cmd-1", name: "play", type: 1 }]).ok, false);

  const appHandled = checkEntryPointCommand([{ id: "cmd-2", name: "launch", type: 4, handler: 1 }]);
  assert.equal(appHandled.ok, false);
  assert.match(appHandled.reason, /DISCORD_LAUNCH_ACTIVITY/);
});

test("Entry Point command creation sends the launch command payload", async () => {
  const calls = [];
  const command = await createEntryPointCommand({
    clientId: "app-1",
    botToken: "bot-token",
    apiBase: "https://discord.example/api/v10",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ id: "cmd-3", name: "launch", type: 4, handler: 2 }), {
        status: 201,
        headers: { "Content-Type": "application/json" }
      });
    }
  });

  assert.equal(command.id, "cmd-3");
  assert.equal(calls[0].url, "https://discord.example/api/v10/applications/app-1/commands");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(new Headers(calls[0].options.headers).get("authorization"), "Bot bot-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    name: "launch",
    description: "Launch Baloot",
    type: 4,
    handler: 2,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
  });
});

test("Entry Point verifier can create a missing command when requested", async () => {
  const calls = [];
  const report = await verifyEntryPointCommand({
    clientId: "app-1",
    botToken: "bot-token",
    createIfMissing: true,
    apiBase: "https://discord.example/api/v10",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (!options?.method) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ id: "cmd-4", name: "launch", type: 4, handler: 2 }), { status: 201 });
    }
  });

  assert.equal(report.ok, true);
  assert.match(report.reason, /Created/);
  assert.equal(calls.length, 2);
});
