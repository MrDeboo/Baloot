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

function seedPlayingTrick(room, { hand, contract, trick = [], round = 1 }) {
  room.currentTurn = { actorId: 1, kind: "PLAY_CARD", round };
  room.state.seats = { initiator: 1, nitwit: 2, cutter: 3, dealer: 4 };
  room.state.round = round;
  room.state.trick = trick.map((play) => ({ round, ...play }));
  room.state.hands.set(1, hand);
  room.contractInfo = contract;
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

test("Activity room rejects illegal trick cards before the engine", () => {
  const { room, sent } = makeRoom();
  seedPlayingTrick(room, {
    hand: ["AS", "7H"],
    contract: { mode: "SUN", trump: "", closed: false },
    trick: [{ player: 2, card: "10S" }]
  });

  assert.deepEqual(room.snapshotFor("player-1").self.legalCards, ["AS"]);
  assert.throws(
    () => room.submitAction("player-1", { kind: "PLAY_CARD", card: "7H" }),
    /not legal now/
  );
  assert.equal(sent.length, 0);

  room.submitAction("player-1", { kind: "PLAY_CARD", card: "AS" });

  assert.deepEqual(sent.at(-1).actions, [{ actor_id: 1, type: "PLAY_CARD", data: { card: "AS" } }]);
});

test("Activity room mirrors Hukum trump play restrictions", () => {
  let setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["AS", "7H"],
    contract: { mode: "HUKUM", trump: "S", closed: true },
    trick: []
  });
  assert.deepEqual(setup.room.snapshotFor("player-1").self.legalCards, ["7H"]);
  assert.throws(
    () => setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "AS" }),
    /not legal now/
  );

  setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["AS", "7C"],
    contract: { mode: "HUKUM", trump: "S", closed: false },
    trick: [{ player: 2, card: "10H" }]
  });
  assert.deepEqual(setup.room.snapshotFor("player-1").self.legalCards, ["AS"]);
  assert.throws(
    () => setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "7C" }),
    /not legal now/
  );

  setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["JS", "7S", "8C"],
    contract: { mode: "HUKUM", trump: "S", closed: false },
    trick: [
      { player: 4, card: "7H" },
      { player: 2, card: "9S" }
    ]
  });
  assert.deepEqual(setup.room.snapshotFor("player-1").self.legalCards, ["JS"]);
  assert.throws(
    () => setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "7S" }),
    /not legal now/
  );

  setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "JS" });
  assert.deepEqual(setup.sent.at(-1).actions, [{ actor_id: 1, type: "PLAY_CARD", data: { card: "JS" } }]);
});

test("Activity room rejects late project declarations before the engine", () => {
  const { room } = makeRoom();
  seedPlayingTrick(room, {
    hand: ["AS", "10D", "JD", "QD"],
    contract: { mode: "SUN", trump: "", closed: false }
  });
  room.projectClosedSeats.add(1);

  assert.throws(
    () =>
      room.submitAction("player-1", {
        kind: "PLAY_CARD",
        card: "AS",
        projects: [{ project: "SIRA", cards: "10D JD QD" }]
      }),
    /before your first play/
  );
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
