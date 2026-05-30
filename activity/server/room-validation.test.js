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

  end() {
    this.emit("close");
  }
}

function makeRoom(options = {}) {
  const room = new ActivityRoom("validation", {
    engineBin: "",
    targetScore: 32,
    readTimeoutMs: 1000,
    disconnectGraceMs: options.disconnectGraceMs ?? 1000
  });
  const sent = [];
  const forfeits = [];
  const response = new MockSseResponse();
  room.connect({
    user: { id: "player-1", name: "Player One", avatar: "" },
    response
  });
  room.status = "playing";
  room.engine = {
    sendActions(seat, actions) {
      sent.push({ seat, actions });
    },
    forfeitSeat(seat) {
      forfeits.push(seat);
    },
    stop() {
      // Test double.
    }
  };
  return { room, sent, forfeits, response };
}

function addPlayer(room, id, seat) {
  room.participants.set(id, {
    user: { id, name: id, avatar: "" },
    connected: true,
    role: "player",
    seat
  });
  room.playersBySeat.set(seat, id);
  room.state.hands.set(seat, []);
}

function seedPlayingTrick(room, { hand, contract, trick = [], round = 1 }) {
  room.currentTurn = { actorId: 1, kind: "PLAY_CARD", round };
  room.state.seats = { initiator: 1, nitwit: 2, cutter: 3, dealer: 4 };
  room.state.round = round;
  room.state.trick = trick.map((play) => ({ round, ...play }));
  room.state.hands.set(1, hand);
  room.contractInfo = contract;
}

function seedSeats(room) {
  room.state.seats = { initiator: 1, nitwit: 2, cutter: 3, dealer: 4 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Activity room rejects malformed buy actions before the engine", () => {
  const { room, sent } = makeRoom();
  seedSeats(room);
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

test("Activity room validates bidding phase calls before the engine", () => {
  const { room, sent } = makeRoom();
  seedSeats(room);
  room.state.middle = "10C";
  room.currentTurn = { actorId: 1, kind: "BUY_CALL", phase: "1" };

  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "ASHKAL" }),
    /ASHKAL is only legal/
  );

  room.currentTurn = { actorId: 1, kind: "BUY_CALL", phase: "2" };
  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "ASHKAL" }),
    /not legal in phase 2/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "HUKUM" }),
    /must choose a trump/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "HUKUM", trump: "C" }),
    /cannot use the middle suit/
  );
  assert.equal(sent.length, 0);

  room.submitAction("player-1", { kind: "BUY_CALL", call: "HUKUM", trump: "S" });
  assert.deepEqual(sent.at(-1).actions, [
    { actor_id: 1, type: "BUY_CALL", data: { call: "HUKUM", trump: "S" } }
  ]);
});

test("Activity room validates discussion calls before the engine", () => {
  let setup = makeRoom();
  seedSeats(setup.room);
  addPlayer(setup.room, "player-2", 2);
  setup.room.currentTurn = { actorId: 2, kind: "BUY_CALL", phase: "discussion" };
  setup.room.contractInfo = { mode: "SUN", trump: "", buyerId: 1, buyerTeam: "A", sourceCall: "SUN", multiplier: 1, closed: false };

  assert.throws(
    () => setup.room.submitAction("player-2", { kind: "BUY_CALL", call: "BET_CLOSE" }),
    /Sun betting can only be open/
  );
  assert.throws(
    () => setup.room.submitAction("player-2", { kind: "BUY_CALL", call: "GABLAK_ASHKAL" }),
    /only legal for cutter or dealer/
  );

  setup.room.submitAction("player-2", { kind: "BUY_CALL", call: "BET_OPEN" });
  assert.deepEqual(setup.sent.at(-1).actions, [
    { actor_id: 2, type: "BUY_CALL", data: { call: "BET_OPEN" } }
  ]);

  setup = makeRoom();
  seedSeats(setup.room);
  addPlayer(setup.room, "player-3", 3);
  setup.room.currentTurn = { actorId: 3, kind: "BUY_CALL", phase: "discussion" };
  setup.room.contractInfo = { mode: "SUN", trump: "", buyerId: 1, buyerTeam: "A", sourceCall: "SUN", multiplier: 1, closed: false };
  assert.throws(
    () => setup.room.submitAction("player-3", { kind: "BUY_CALL", call: "BET_OPEN" }),
    /Buyer team cannot open/
  );
  assert.throws(
    () => setup.room.submitAction("player-3", { kind: "BUY_CALL", call: "GABLAK_SUN" }),
    /Cannot gablak a teammate/
  );

  setup.room.contractInfo.sourceCall = "HUKUM";
  setup.room.submitAction("player-3", { kind: "BUY_CALL", call: "GABLAK_SUN" });
  assert.deepEqual(setup.sent.at(-1).actions, [
    { actor_id: 3, type: "BUY_CALL", data: { call: "GABLAK_SUN" } }
  ]);
});

test("Activity room validates enforce calls before the engine", () => {
  const { room, sent } = makeRoom();
  seedSeats(room);
  room.currentTurn = { actorId: 1, kind: "BUY_CALL", phase: "enforce" };
  room.contractInfo = { mode: "HUKUM", trump: "C", buyerId: 1, buyerTeam: "A", sourceCall: "HUKUM", multiplier: 1, closed: false };

  assert.throws(
    () => room.submitAction("player-1", { kind: "BUY_CALL", call: "SUN" }),
    /not legal during enforce/
  );

  room.submitAction("player-1", { kind: "BUY_CALL", call: "ENFORCE_HUKUM", trump: "S" });
  assert.deepEqual(sent.at(-1).actions, [
    { actor_id: 1, type: "BUY_CALL", data: { call: "ENFORCE_HUKUM", trump: "S" } }
  ]);
});

test("Activity room forfeits disconnected in-match players after grace", async () => {
  const { room, response, forfeits } = makeRoom({ disconnectGraceMs: 0 });

  response.end();

  assert.equal(room.participants.get("player-1").connected, false);
  assert.deepEqual(forfeits, [1]);
  assert.match(room.state.log.join("\n"), /forfeited after disconnect/);
});

test("Activity room cancels disconnect forfeit when a player reconnects", async () => {
  const { room, response, forfeits } = makeRoom({ disconnectGraceMs: 25 });

  response.end();
  assert.equal(room.participants.get("player-1").connected, false);

  room.connect({
    user: { id: "player-1", name: "Player One", avatar: "" },
    response: new MockSseResponse()
  });
  await sleep(50);

  assert.equal(room.participants.get("player-1").connected, true);
  assert.deepEqual(forfeits, []);
  assert.match(room.state.log.join("\n"), /reconnected/);
  room.close();
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
  assert.throws(
    () => room.submitAction("player-1", { kind: "PLAY_CARD", card: "AS", ikkah: "true" }),
    /ikkah must be a boolean/
  );
  assert.throws(
    () => room.submitAction("player-1", { kind: "PLAY_CARD", card: "AS", baloot: true }),
    /BALOOT must be declared/
  );
  assert.equal(sent.length, 0);

  room.submitAction("player-1", {
    kind: "PLAY_CARD",
    card: "as",
    ikkah: false,
    baloot: false,
    projects: [{ project: "sira", cards: "10d jd qd" }]
  });

  assert.equal(room.currentTurn, null);
  assert.deepEqual(sent, [
    {
      seat: 1,
      actions: [
        { actor_id: 1, type: "STATE_PROJECT", data: { project: "SIRA", cards: "10D,JD,QD" } },
        { actor_id: 1, type: "PLAY_CARD", data: { card: "AS" } }
      ]
    }
  ]);
});

test("Activity room validates IKKAH declarations before the engine", () => {
  let setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["AH", "7S"],
    contract: { mode: "SUN", trump: "", closed: false },
    trick: []
  });
  assert.throws(
    () => setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "AH", ikkah: true }),
    /IKKAH requires/
  );

  setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["AS", "7H"],
    contract: { mode: "HUKUM", trump: "S", closed: false },
    trick: []
  });
  assert.throws(
    () => setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "AS", ikkah: true }),
    /IKKAH requires/
  );

  setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["KH", "7S"],
    contract: { mode: "HUKUM", trump: "S", closed: false },
    trick: []
  });
  setup.room.state.hands.set(2, ["AH"]);
  assert.deepEqual(setup.room.snapshotFor("player-1").self.declarations.ikkahCards, []);
  assert.throws(
    () => setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "KH", ikkah: true }),
    /highest remaining/
  );

  setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["AH", "7S"],
    contract: { mode: "HUKUM", trump: "S", closed: false },
    trick: []
  });
  setup.room.state.hands.set(2, ["KH"]);
  assert.deepEqual(setup.room.snapshotFor("player-1").self.declarations.ikkahCards, ["AH"]);
  setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "AH", ikkah: true });
  assert.deepEqual(setup.sent.at(-1).actions, [
    { actor_id: 1, type: "IKKAH", data: {} },
    { actor_id: 1, type: "PLAY_CARD", data: { card: "AH" } }
  ]);
});

test("Activity room validates BALOOT declarations before the engine", () => {
  let setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["KS"],
    contract: { mode: "HUKUM", trump: "S", closed: false },
    trick: []
  });
  assert.deepEqual(setup.room.snapshotFor("player-1").self.declarations.balootCards, []);
  assert.throws(
    () => setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "KS", baloot: true }),
    /second trump K\/Q/
  );

  setup = makeRoom();
  seedPlayingTrick(setup.room, {
    hand: ["QS"],
    contract: { mode: "HUKUM", trump: "S", closed: false },
    trick: []
  });
  setup.room.balootHalfSeenSeats.add(1);
  assert.deepEqual(setup.room.snapshotFor("player-1").self.declarations.balootCards, ["QS"]);
  setup.room.submitAction("player-1", { kind: "PLAY_CARD", card: "QS", baloot: true });
  assert.deepEqual(setup.sent.at(-1).actions, [
    { actor_id: 1, type: "BALOOT", data: {} },
    { actor_id: 1, type: "PLAY_CARD", data: { card: "QS" } }
  ]);

  setup = makeRoom();
  setup.room.contractInfo = { mode: "HUKUM", trump: "S", closed: false };
  setup.room.state.hands.set(1, ["KS"]);
  setup.room.applyPublicAction({ actor_id: 1, type: "PLAY_CARD", data: { card: "KS", round: "1" } });
  assert.equal(setup.room.balootHalfSeenSeats.has(1), true);
  setup.room.applyPublicAction({
    actor_id: 0,
    type: "NEW_GAME",
    data: { game: "2", initiator: "1", nitwit: "2", cutter: "3", dealer: "4" }
  });
  assert.equal(setup.room.balootHalfSeenSeats.size, 0);
});
