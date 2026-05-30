export function encodeFrame(payload) {
  return `${Buffer.byteLength(payload, "utf8")}\n${payload}\n`;
}

export class FrameDecoder {
  constructor(maxFrameBytes = 64 * 1024) {
    this.maxFrameBytes = maxFrameBytes;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk.toString("utf8");
    const frames = [];

    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      if (newline === 0) throw new Error("empty frame length");

      const header = this.buffer.slice(0, newline);
      if (!/^\d+$/.test(header)) throw new Error("frame length contains non-digit");

      const length = Number(header);
      if (!Number.isSafeInteger(length) || length > this.maxFrameBytes) {
        throw new Error("frame length exceeds configured maximum");
      }

      const payloadStart = newline + 1;
      const trailingNewline = payloadStart + length;
      const needed = trailingNewline + 1;
      if (this.buffer.length < needed) break;
      if (this.buffer[trailingNewline] !== "\n") {
        throw new Error("frame payload missing trailing newline");
      }

      frames.push(this.buffer.slice(payloadStart, trailingNewline));
      this.buffer = this.buffer.slice(needed);
    }

    return frames;
  }
}

export function control(kind, fields = {}) {
  return JSON.stringify({ kind, ...fields });
}

export function envelope(seq, matchId, actions) {
  return JSON.stringify({
    kind: "ACTIONS",
    seq,
    match_id: matchId,
    actions
  });
}

export function parseMessage(payload) {
  const message = JSON.parse(payload);
  if (!message || typeof message.kind !== "string") {
    throw new Error("engine message is missing kind");
  }
  return message;
}
