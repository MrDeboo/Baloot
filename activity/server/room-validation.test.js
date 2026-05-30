import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ActivityRoom } from "./room.js";

class MockSseResponse extends EventEmitter {
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  write() {
    return true;
  }
}

function makeRoom() {
  const room = new ActivityRoom("validation", {
    engineBin: "",
    targetScore: 32,
    readTimeoutMs: 1000
  });
  const sent = [];
  room.connect({
    user: { id: "player-1", name: "Player One", avatar: "" },
    response: new MockSseResponse()
  });
  room.status = "playing";
  room.engine = {
    sendActions(seat, actions) {
      sent.push({ seat, actions });
    }
  };
  return { room, sent };
}

test("Activity room rejects malformed buy actions before the engine", () => {
  const { room, sent } = makeRoom();
  room.currentTurn = { actorId: 1, kind: "BUY_CALL", phase: "1" };

  assert.throws(
    () => room.submitAction("player-1", { kind: "PLAY_CARD", card: "AS" }),
    /Expected BUY_CALL/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL" }),
    /requires a call/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "NOPE" }),
    /Unsupported BUY_CALL/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "HUKUM", trump: "Z" }),
    /Invalid trump suit/
  );
  assert.equal(sent.length, 0);
  assert.deepEqual(room.currentTurn, { actorId: 1, kind: "BUY_CALL", phase: "1" });

  room.submitAction("player-1", { kind: "BUY_CALL", call: "HUKUM", trump: "s" });

  assert.equal(room.currentTurn, null);
  assert.deepEqual(sent, [
    {
      seat: 1,
      actions: [{ actor_id: 1, type: "BUY_CALL", data: { call: "HUKUM", trump: "S" } }]
    }
  ]);
});

test("Activity room validates play cards and optional declarations", () => {
  const { room, sent } = makeRoom();
  room.currentTurn = { actorId: 1, kind: "PLAY_CARD", round: 1 };
  room.state.hands.set(1, ["AS", "10D", "JD", "QD", "KD"]);

  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "BAS" }),
    /Expected PLAY_CARD/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "PLAY_CARD" }),
    /Invalid PLAY_CARD card/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "PLAY_CARD", card: "1S" }),
    /Invalid PLAY_CARD card/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "PLAY_CARD", card: "7S" }),
    /Played card 7S is not in your hand/
  );
  assert.throws(
    () =>
      room.submitAction("player-1", {
        kind: "PLAY_CARD",
        card: "AS",
        projects: [{ project: "fake", cards: "10D JD QD" }]
      }),
    /Unsupported project/
  );
  assert.throws(
    () =>
      room.submitAction("player-1", {
        kind: "PLAY_CARD",
        card: "AS",
        projects: [{ project: "SIRA", cards: "10D ZZ QD" }]
      }),
    /Invalid project card/
  );
  assert.throws(
    () =>
      room.submitAction("player-1", {
        kind: "PLAY_CARD",
        card: "AS",
        projects: [{ project: "SIRA", cards: "10D JD QS" }]
      }),
    /Project card QS is not in your hand/
  );
  assert.equal(sent.length, 0);

  room.submitAction("player-1", {
    kind: "PLAY_CARD",
    card: "as",
    ikkah: true,
    baloot: false,
    projects: [{ project: "sira", cards: "10d jd qd" }]
  });

  assert.equal(room.currentTurn, null);
  assert.deepEqual(sent, [
    {
      seat: 1,
      actions: [
        { actor_id: 1, type: "STATE_PROJECT", data: { project: "SIRA", cards: "10D,JD,QD" } },
        { actor_id: 1, type: "IKKAH", data: {} },
        { actor_id: 1, type: "PLAY_CARD", data: { card: "AS" } }
      ]
    }
  ]);
});
