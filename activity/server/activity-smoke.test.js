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
    this.heartbeats = 0;
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
      if (block.startsWith(":")) {
        this.heartbeats += 1;
      }
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

async function driveHumanSubmittedMatch(room, responses) {
  let submitted = 0;
  while (true) {
    const result = await waitFor(() => {
      const state = latest(responses[0]);
      if (state?.status === "ended") return { ended: true, state };
      if (state?.status === "error") throw new Error(state.error || "Activity entered error state.");
      if (state?.currentTurn) return { turn: state.currentTurn };
      return null;
    }, 30000);

    if (result.ended) return { submitted, final: result.state };

    const { turn } = result;
    const response = responses.find((item) => latest(item)?.self.seat === turn.actorId);
    const snapshot = response ? latest(response) : null;
    if (!snapshot) throw new Error(`No player snapshot for seat ${turn.actorId}.`);

    if (turn.kind === "BUY_CALL") {
      const call = turn.phase === "1" || turn.phase === "2" ? "SUN" : "BAS";
      room.submitAction(`player-${turn.actorId}`, { kind: "BUY_CALL", call });
      submitted += 1;
      continue;
    }

    if (turn.kind === "PLAY_CARD") {
      const card = snapshot.self.legalCards[0] ?? snapshot.self.hand[0];
      if (!card) throw new Error(`Seat ${turn.actorId} has no card to play.`);
      room.submitAction(`player-${turn.actorId}`, { kind: "PLAY_CARD", card });
      submitted += 1;
      continue;
    }

    throw new Error(`Unsupported Activity turn kind ${turn.kind}.`);
  }
}

test("Activity room keeps SSE streams warm with comment heartbeats", async () => {
  const hub = new ActivityHub({ engineBin: "/missing-baloot-server", sseHeartbeatMs: 5 });
  const room = hub.getRoom(`heartbeat-${Date.now()}`);

  try {
    const response = connect(room, "player-1");
    await waitFor(() => response.heartbeats > 0, 500);

    response.end();
    const finalHeartbeats = response.heartbeats;
    await sleep(25);

    assert.equal(response.heartbeats, finalHeartbeats);
  } finally {
    hub.closeAll();
  }
});

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

test("Activity start is gated by the Discord instance participant verifier", async () => {
  const verifierCalls = [];
  const hub = new ActivityHub({
    engineBin: "/missing-baloot-server",
    verifyPlayersReady: async (details) => {
      verifierCalls.push(details);
      return {
        verified: false,
        reason: "not all seated users are still in the Activity instance",
        missing: ["player-1"]
      };
    }
  });
  const room = hub.getRoom(`verify-${Date.now()}`);

  try {
    const players = [1, 2, 3, 4].map((seat) => connect(room, `player-${seat}`));
    const lobby = await waitFor(() => latest(players[1])?.players.length === 3 && latest(players[1]));

    assert.equal(room.engine, null);
    assert.equal(lobby.status, "lobby");
    assert.match(lobby.error, /Activity instance verification failed/i);
    assert.deepEqual(lobby.players.map((player) => player.id), ["player-2", "player-3", "player-4"]);
    assert.equal(latest(players[0]).self.role, "spectator");
    assert.equal(verifierCalls.length, 1);
    assert.equal(verifierCalls[0].roomId, room.id);
    assert.deepEqual(verifierCalls[0].userIds, ["player-1", "player-2", "player-3", "player-4"]);
  } finally {
    hub.closeAll();
  }
});

test("Activity start enters error on unrecoverable participant verifier failures", async () => {
  const hub = new ActivityHub({
    engineBin: "/missing-baloot-server",
    verifyPlayersReady: async () => ({ verified: false, reason: "Discord returned 500" })
  });
  const room = hub.getRoom(`verify-error-${Date.now()}`);

  try {
    const players = [1, 2, 3, 4].map((seat) => connect(room, `player-${seat}`));
    const error = await waitFor(() => latest(players[0])?.status === "error" && latest(players[0]));

    assert.equal(room.engine, null);
    assert.match(error.error, /Discord returned 500/);
    assert.equal(error.players.length, 4);
  } finally {
    hub.closeAll();
  }
});

test("Activity retries start verification if the seated lobby roster changes", async () => {
  const verifierCalls = [];
  let resolveFirstVerification = null;
  const firstVerification = new Promise((resolve) => {
    resolveFirstVerification = resolve;
  });
  const hub = new ActivityHub({
    engineBin: "/missing-baloot-server",
    verifyPlayersReady: async (details) => {
      verifierCalls.push(details);
      if (verifierCalls.length === 1) return firstVerification;
      return { verified: false, reason: "retry observed" };
    }
  });
  const room = hub.getRoom(`roster-retry-${Date.now()}`);

  try {
    const p1 = connect(room, "player-1");
    const p2 = connect(room, "player-2");
    const p3 = connect(room, "player-3");
    const p4 = connect(room, "player-4");
    await waitFor(() => verifierCalls.length === 1);

    p1.end();
    await waitFor(() => latest(p2)?.players.length === 3);
    const p5 = connect(room, "player-5");
    assert.equal(latest(p5).self.role, "player");
    assert.equal(latest(p5).self.seat, 4);

    resolveFirstVerification({ verified: true, reason: "old roster verified" });
    const retryError = await waitFor(() => latest(p2)?.status === "error" && latest(p2));

    assert.equal(room.engine, null);
    assert.match(retryError.error, /retry observed/);
    assert.equal(verifierCalls.length, 2);
    assert.deepEqual(verifierCalls[0].userIds, ["player-1", "player-2", "player-3", "player-4"]);
    assert.deepEqual(verifierCalls[1].userIds, ["player-2", "player-3", "player-4", "player-5"]);
  } finally {
    resolveFirstVerification?.({ verified: true });
    hub.closeAll();
  }
});

test("Connected lobby spectators fill seats that open before Activity start", async () => {
  let resolveVerification = null;
  const firstVerification = new Promise((resolve) => {
    resolveVerification = resolve;
  });
  const verifierCalls = [];
  const hub = new ActivityHub({
    engineBin: "/missing-baloot-server",
    verifyPlayersReady: async (details) => {
      verifierCalls.push(details);
      if (verifierCalls.length === 1) return firstVerification;
      return { verified: false, reason: "promotion observed" };
    }
  });
  const room = hub.getRoom(`spectator-promote-${Date.now()}`);

  try {
    const p1 = connect(room, "player-1");
    const p2 = connect(room, "player-2");
    const p3 = connect(room, "player-3");
    const p4 = connect(room, "player-4");
    await waitFor(() => verifierCalls.length === 1);

    const spectator = connect(room, "spectator-1");
    assert.equal(latest(spectator).self.role, "spectator");

    p1.end();
    const promoted = await waitFor(() => latest(spectator)?.self.role === "player" && latest(spectator));
    assert.equal(promoted.self.seat, 4);
    assert.deepEqual(
      promoted.players.map((player) => player.id),
      ["player-2", "player-3", "player-4", "spectator-1"]
    );

    resolveVerification({ verified: true, reason: "old roster verified" });
    const retryError = await waitFor(() => latest(spectator)?.status === "error" && latest(spectator));

    assert.equal(room.engine, null);
    assert.match(retryError.error, /promotion observed/);
    assert.deepEqual(verifierCalls[0].userIds, ["player-1", "player-2", "player-3", "player-4"]);
    assert.deepEqual(verifierCalls[1].userIds, ["player-2", "player-3", "player-4", "spectator-1"]);
  } finally {
    resolveVerification?.({ verified: true });
    hub.closeAll();
  }
});

test("Activity can complete a real-engine match from four player-submitted actions", { skip: !engineBin }, async () => {
  const hub = new ActivityHub({ engineBin, targetScore: 1, readTimeoutMs: 900000 });
  const room = hub.getRoom(`full-match-${Date.now()}`);

  try {
    const players = [1, 2, 3, 4].map((seat) => connect(room, `player-${seat}`));
    await waitFor(() =>
      players.every((response) => latest(response)?.self.hand.length === 5) &&
      latest(players[0])?.status === "playing"
    );

    const result = await driveHumanSubmittedMatch(room, players);
    assert.equal(result.final.status, "ended");
    assert.match(result.final.state.log.at(-1), /Match ended/);
    assert.ok(result.final.state.scores.A >= 1 || result.final.state.scores.B >= 1);
    assert.ok(result.submitted >= 8);
  } finally {
    hub.closeAll();
  }
});

test("Disconnected in-match players forfeit without bot moves", { skip: !engineBin }, async () => {
  const hub = new ActivityHub({ engineBin, targetScore: 32, readTimeoutMs: 900000, disconnectGraceMs: 10 });
  const room = hub.getRoom(`forfeit-${Date.now()}`);

  try {
    const players = [1, 2, 3, 4].map((seat) => connect(room, `player-${seat}`));
    await waitFor(() =>
      players.every((response) => latest(response)?.self.hand.length === 5) &&
      latest(players[0])?.status === "playing" &&
      latest(players[0])?.currentTurn?.actorId === 1
    );

    players[0].end();
    const ended = await waitFor(() => latest(players[1])?.status === "ended" && latest(players[1]), 10000);

    assert.match(ended.state.log.join("\n"), /forfeited after disconnect|network read failed/i);
    assert.equal(ended.state.scores.B, 32);
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
