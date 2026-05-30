import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { signSession, verifyDiscordProxyRequestHeaders, verifySession } from "./auth.js";

function discordPublicKeyHex(publicKey) {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return spki.subarray(-32).toString("hex");
}

function signedProxyHeaders(payload, privateKey) {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    "x-signature-ed25519": crypto.sign(null, payloadBytes, privateKey).toString("base64"),
    "x-signature-timestamp": String(payload.created_at),
    "x-discord-proxy-payload": payloadBytes.toString("base64")
  };
}

test("Activity sessions are signed and expire", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const session = signSession(
    { user: { id: "u1", name: "User One" }, instanceId: "instance-1" },
    { secret, ttlSeconds: 60, nowSeconds: 100 }
  );

  assert.deepEqual(verifySession(session, { secret, nowSeconds: 120 })?.user, {
    id: "u1",
    name: "User One"
  });
  assert.equal(verifySession(`${session}x`, { secret, nowSeconds: 120 }), null);
  assert.equal(verifySession(session, { secret, nowSeconds: 200 }), null);
  assert.equal(verifySession(session, { secret: "wrong-secret", nowSeconds: 120 }), null);
});

test("Discord proxy request headers verify Ed25519 signatures", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyHex = discordPublicKeyHex(publicKey);
  const payload = {
    application_id: "app-1",
    created_at: 1000,
    expires_at: 1060,
    user: { id: "u1" }
  };

  const headers = signedProxyHeaders(payload, privateKey);
  const verified = verifyDiscordProxyRequestHeaders(headers, {
    publicKey: publicKeyHex,
    clientId: "app-1",
    nowSeconds: 1010
  });

  assert.equal(verified.verified, true);
  assert.equal(verified.payload.user.id, "u1");

  assert.equal(
    verifyDiscordProxyRequestHeaders(
      { ...headers, "x-signature-timestamp": "999" },
      { publicKey: publicKeyHex, clientId: "app-1", nowSeconds: 1010 }
    ).verified,
    false
  );
  assert.match(
    verifyDiscordProxyRequestHeaders(headers, { publicKey: publicKeyHex, clientId: "other", nowSeconds: 1010 }).reason,
    /application mismatch/
  );
  assert.match(
    verifyDiscordProxyRequestHeaders(headers, { publicKey: publicKeyHex, clientId: "app-1", nowSeconds: 2000 }).reason,
    /expired/
  );
  assert.match(
    verifyDiscordProxyRequestHeaders(
      { ...headers, "x-signature-ed25519": "bad" },
      { publicKey: publicKeyHex, clientId: "app-1", nowSeconds: 1010 }
    ).reason,
    /invalid/
  );
});

test("Discord proxy request verification is explicit when unconfigured", () => {
  const result = verifyDiscordProxyRequestHeaders({}, {});

  assert.equal(result.verified, true);
  assert.equal(result.skipped, true);
});
