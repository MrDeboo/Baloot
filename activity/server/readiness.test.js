import test from "node:test";
import assert from "node:assert/strict";

import { verifyActivityReadiness } from "./readiness.js";

const validConfig = {
  ok: true,
  errors: [],
  warnings: [],
  config: { production: true }
};

const validEnv = {
  ACTIVITY_PUBLIC_URL: "https://baloot.example",
  DISCORD_CLIENT_ID: "app-1",
  DISCORD_BOT_TOKEN: "bot-token"
};

test("readiness combines config, deployment, and Entry Point checks", async () => {
  const calls = [];
  const report = await verifyActivityReadiness(validEnv, {
    validateConfig: () => validConfig,
    verifyDeployment: async (url, options) => {
      calls.push({ kind: "deployment", url, options });
      return {
        ok: true,
        checks: [{ ok: true, message: "Activity root returns HTTP 200." }],
        errors: [],
        warnings: []
      };
    },
    verifyEntrypoint: async (options) => {
      calls.push({ kind: "entrypoint", options });
      return {
        ok: true,
        reason: "Entry Point command launches the Activity through Discord.",
        command: { id: "cmd-1" }
      };
    }
  });

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.sections.map((section) => section.name),
    ["preflight", "deployment", "entrypoint"]
  );
  assert.equal(calls[0].url, "https://baloot.example");
  assert.equal(calls[1].options.clientId, "app-1");
});

test("readiness does not pass blank Discord API base overrides", async () => {
  const calls = [];
  const report = await verifyActivityReadiness(
    { ...validEnv, DISCORD_API_BASE_URL: "" },
    {
      validateConfig: () => validConfig,
      verifyDeployment: async () => ({ ok: true, checks: [], errors: [], warnings: [] }),
      verifyEntrypoint: async (options) => {
        calls.push(options);
        return {
          ok: true,
          reason: "Entry Point command launches the Activity through Discord.",
          command: { id: "cmd-1" }
        };
      }
    }
  );

  assert.equal(report.ok, true);
  assert.equal(calls[0].apiBase, undefined);
});

test("readiness fails closed when deployment URL and Entry Point credentials are missing", async () => {
  const report = await verifyActivityReadiness(
    {},
    {
      validateConfig: () => validConfig,
      verifyDeployment: async () => {
        throw new Error("deployment should not run without a URL");
      },
      verifyEntrypoint: async () => {
        throw new Error("entrypoint should not run without credentials");
      }
    }
  );

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /ACTIVITY_PUBLIC_URL/);
  assert.match(report.errors.join("\n"), /DISCORD_CLIENT_ID, DISCORD_BOT_TOKEN/);
});

test("readiness can intentionally skip live deployment and Entry Point checks", async () => {
  const report = await verifyActivityReadiness(
    {},
    {
      skipDeployment: true,
      skipEntrypoint: true,
      validateConfig: () => validConfig,
      verifyDeployment: async () => {
        throw new Error("deployment should be skipped");
      },
      verifyEntrypoint: async () => {
        throw new Error("entrypoint should be skipped");
      }
    }
  );

  assert.equal(report.ok, true);
  assert.deepEqual(
    report.sections.map((section) => section.name),
    ["preflight"]
  );
});

test("readiness surfaces config, deployment, and Entry Point failures", async () => {
  const report = await verifyActivityReadiness(validEnv, {
    validateConfig: () => ({
      ok: false,
      errors: ["ACTIVITY_SESSION_SECRET must be a long random secret in production."],
      warnings: [],
      config: { production: true }
    }),
    verifyDeployment: async () => ({
      ok: false,
      checks: [{ ok: false, message: "Activity health endpoint returns ok." }],
      errors: ["/api/health must return JSON { ok: true }."],
      warnings: ["Discord proxy request signature checks are not enabled for this deployment."]
    }),
    verifyEntrypoint: async () => ({
      ok: false,
      reason: "No PRIMARY_ENTRY_POINT command is registered.",
      command: null
    })
  });

  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /ACTIVITY_SESSION_SECRET/);
  assert.match(report.errors.join("\n"), /api\/health/);
  assert.match(report.errors.join("\n"), /PRIMARY_ENTRY_POINT/);
  assert.match(report.warnings.join("\n"), /proxy request signature/);
});
