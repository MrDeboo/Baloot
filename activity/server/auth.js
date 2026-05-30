import crypto from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function headerValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function publicKeyFromDiscordHex(value) {
  const raw = Buffer.from(String(value || ""), "hex");
  if (raw.length !== 32) throw new Error("Discord proxy public key must be a 32-byte hex string.");
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki"
  });
}

export function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function signSession({ user, instanceId = "" }, { secret, ttlSeconds = 24 * 60 * 60, nowSeconds } = {}) {
  const now = Number(nowSeconds ?? Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    user,
    instanceId,
    exp: now + ttlSeconds
  });
  const encoded = base64url(payload);
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifySession(token, { secret, nowSeconds } = {}) {
  try {
    if (!secret || !token || typeof token !== "string" || !token.includes(".")) return null;
    const [encoded, signature] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
    if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const now = Number(nowSeconds ?? Math.floor(Date.now() / 1000));
    if (!payload.exp || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function verifyDiscordProxyRequestHeaders(headers, { publicKey, clientId = "", nowSeconds } = {}) {
  if (!publicKey) {
    return { verified: true, skipped: true, reason: "proxy verification not configured" };
  }

  try {
    const signature = headerValue(headers, "x-signature-ed25519");
    const timestamp = headerValue(headers, "x-signature-timestamp");
    const encodedPayload = headerValue(headers, "x-discord-proxy-payload");
    if (!signature || !timestamp || !encodedPayload) {
      return { verified: false, reason: "missing Discord proxy signature headers" };
    }

    const payloadBytes = Buffer.from(String(encodedPayload), "base64");
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    if (String(payload.created_at) !== String(timestamp)) {
      return { verified: false, reason: "Discord proxy timestamp mismatch" };
    }

    const now = Number(nowSeconds ?? Math.floor(Date.now() / 1000));
    if (!Number.isFinite(Number(payload.expires_at)) || Number(payload.expires_at) < now) {
      return { verified: false, reason: "Discord proxy token expired" };
    }
    if (clientId && payload.application_id && String(payload.application_id) !== String(clientId)) {
      return { verified: false, reason: "Discord proxy application mismatch" };
    }

    const verified = crypto.verify(
      null,
      payloadBytes,
      publicKeyFromDiscordHex(publicKey),
      Buffer.from(String(signature), "base64")
    );
    return verified
      ? { verified: true, skipped: false, payload }
      : { verified: false, reason: "invalid Discord proxy signature" };
  } catch (error) {
    return { verified: false, reason: error.message || "invalid Discord proxy signature" };
  }
}
