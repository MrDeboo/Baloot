import test from "node:test";
import assert from "node:assert/strict";

import { fetchDiscordApi } from "./discord-api.js";

test("Discord API fetch retries 429s using Retry-After seconds", async () => {
  const calls = [];
  const delays = [];
  const responses = [
    new Response(JSON.stringify({ message: "rate limited", retry_after: 99 }), {
      status: 429,
      headers: { "Retry-After": "0.125", "Content-Type": "application/json" }
    }),
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
  ];

  const response = await fetchDiscordApi(
    "https://discord.com/api/example",
    { headers: { Authorization: "Bot token" } },
    {
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return responses.shift();
      },
      sleepFn: async (delay) => delays.push(delay),
      maxRetryDelayMs: 1000
    }
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [125]);
  assert.equal(calls[0].url, "https://discord.com/api/example");
  assert.equal(new Headers(calls[0].options.headers).get("authorization"), "Bot token");
  assert.equal(
    new Headers(calls[0].options.headers).get("user-agent"),
    "DiscordBot (https://github.com/MrDeboo/Baloot, 1.0)"
  );
});

test("Discord API fetch preserves a custom User-Agent", async () => {
  const calls = [];
  const response = await fetchDiscordApi(
    "https://discord.com/api/example",
    { headers: { "User-Agent": "DiscordBot (https://example.com, 9.9)" } },
    {
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return new Response("ok", { status: 200 });
      }
    }
  );

  assert.equal(response.status, 200);
  assert.equal(new Headers(calls[0].options.headers).get("user-agent"), "DiscordBot (https://example.com, 9.9)");
});

test("Discord API fetch falls back to retry_after JSON body", async () => {
  const delays = [];
  const responses = [
    new Response(JSON.stringify({ retry_after: 0.25 }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    }),
    new Response("done", { status: 200 })
  ];

  const response = await fetchDiscordApi("https://discord.com/api/example", {}, {
    fetchFn: async () => responses.shift(),
    sleepFn: async (delay) => delays.push(delay),
    maxRetryDelayMs: 1000
  });

  assert.equal(response.status, 200);
  assert.deepEqual(delays, [250]);
});

test("Discord API fetch does not retry earlier than the allowed delay", async () => {
  const delays = [];
  let calls = 0;

  const response = await fetchDiscordApi("https://discord.com/api/example", {}, {
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify({ retry_after: 60 }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    },
    sleepFn: async (delay) => delays.push(delay),
    maxRetries: 2,
    maxRetryDelayMs: 500
  });

  assert.equal(response.status, 429);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("Discord API fetch stops after max retries", async () => {
  const delays = [];
  let calls = 0;

  const response = await fetchDiscordApi("https://discord.com/api/example", {}, {
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify({ retry_after: 0.01 }), {
        status: 429,
        headers: { "Content-Type": "application/json" }
      });
    },
    sleepFn: async (delay) => delays.push(delay),
    maxRetries: 2
  });

  assert.equal(response.status, 429);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 10]);
});
