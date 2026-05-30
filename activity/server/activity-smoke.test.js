import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ActivityHub } from "./room.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const engineBin =
  process.env.BALOOT_SERVER_BIN ||
  [
    path.join(repoRoot, "build/baloot-server"),
    path.join(repoRoot, "build/Release/baloot-server.exe"),
    path.join(repoRoot, "build/baloot-server.exe")
  ].find((candidate) => fs.existsSync(candidate));

class MockSseResponse extends EventEmitter {
  constructor() {
    super();
    this.buffer = "";
    this.snapshots = [];
    this.headers = null;
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const event = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (event === "snapshot" && data) {
        const snapshot = JSON.parse(data);
        this.snapshots.push(snapshot);
        this.emit("snapshot", snapshot);
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    return true;
  }

  end() {
    this.emit("close");
  }
}

function connect(room, id) {
  const response = new MockSseResponse();
  room.connect({ user: { id, name: id, avatar: "" }, response });
  return response;
}

function latest(response) {
  return response.snapshots.at(-1);
}

function waitFor(assertion, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      try {
        const value = assertion();
        if (value) {
          resolve(value);
          return;
        }
      } catch {
        // Keep polling until timeout so async snapshots can arrive.
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for Activity state."));
      } else {
        setTimeout(tick, 25);
      }
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Activity starts only with four players and makes extras spectators", { skip: !engineBin }, async () => {
  const hub = new ActivityHub({ engineBin, targetScore: 32, readTimeoutMs: 900000 });
  const room = hub.getRoom(`smoke-${Date.now()}`);

  try {
    const p1 = connect(room, "player-1");
    const p2 = connect(room, "player-2");
    const p3 = connect(room, "player-3");

    assert.equal(latest(p1).status, "lobby");
    assert.equal(latest(p2).players.length, 3);
    assert.equal(latest(p3).self.role, "player");
    assert.equal(room.engine, null);

    const p4 = connect(room, "player-4");
    const spectator = connect(room, "spectator-1");

    await waitFor(() =>
      [p1, p2, p3, p4].every((response) => latest(response)?.self.hand.length === 5) &&
      latest(p1)?.status === "playing" &&
      latest(p1)?.currentTurn?.actorId === 1
    );

    assert.equal(latest(spectator).self.role, "spectator");
    assert.equal(latest(spectator).self.seat, null);
    assert.deepEqual(latest(spectator).self.hand, []);
    assert.equal(latest(spectator).players.length, 4);
    assert.equal(latest(spectator).spectators.length, 1);

    assert.throws(
      () => room.submitAction("spectator-1", { kind: "BUY_CALL", call: "BAS" }),
      /Only seated players/
    );
    assert.throws(
      () => room.submitAction("player-2", { kind: "BUY_CALL", call: "BAS" }),
      /not your turn/
    );

    await sleep(150);
    assert.equal(latest(p1).currentTurn.actorId, 1);

    room.submitAction("player-1", { kind: "BUY_CALL", call: "BAS" });
    await waitFor(() => latest(p1)?.currentTurn?.actorId === 2);
    assert.equal(latest(p2).currentTurn.actorId, 2);
  } finally {
    hub.closeAll();
  }
});

test("Disconnected lobby users do not reserve player seats", { skip: !engineBin }, async () => {
  const hub = new ActivityHub({ engineBin, targetScore: 32, readTimeoutMs: 900000 });
  const room = hub.getRoom(`disconnect-${Date.now()}`);

  try {
    const p1 = connect(room, "drop-before-start");
    const p2 = connect(room, "player-2");
    const p3 = connect(room, "player-3");

    p1.end();
    await waitFor(() => latest(p2)?.players.length === 2);
    assert.equal(latest(p2).self.seat, 1);
    assert.equal(latest(p3).self.seat, 2);
    assert.equal(room.engine, null);

    const p4 = connect(room, "player-4");
    assert.equal(latest(p4).self.role, "player");
    assert.equal(latest(p4).self.seat, 3);
    assert.equal(latest(p4).status, "lobby");
    assert.equal(room.engine, null);

    const p5 = connect(room, "player-5");
    await waitFor(() =>
      [p2, p3, p4, p5].every((response) => latest(response)?.self.hand.length === 5) &&
      latest(p2)?.status === "playing"
    );

    assert.equal(latest(p5).self.role, "player");
    assert.equal(latest(p5).self.seat, 4);

    const spectator = connect(room, "late-spectator");
    assert.equal(latest(spectator).self.role, "spectator");
    assert.equal(latest(spectator).self.seat, null);
    assert.deepEqual(latest(spectator).self.hand, []);
  } finally {
    hub.closeAll();
  }
});
