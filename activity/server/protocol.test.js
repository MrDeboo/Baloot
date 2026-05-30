import test from "node:test";
import assert from "node:assert/strict";

import { encodeFrame, FrameDecoder } from "./protocol.js";
import { TurnTracker } from "./turn-tracker.js";

test("length-prefixed frames decode across chunks", () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame(JSON.stringify({ kind: "HELLO", name: "Ada" }));
  assert.deepEqual(decoder.push(frame.slice(0, 5)), []);
  const frames = decoder.push(frame.slice(5));
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0]).kind, "HELLO");
});

test("turn tracker prompts only the current bidding seat", () => {
  const p1 = new TurnTracker(1);
  const p2 = new TurnTracker(2);
  const newGame = {
    actor_id: 0,
    type: "NEW_GAME",
    data: { game: "1", initiator: "1", nitwit: "2", cutter: "3", dealer: "4" }
  };
  assert.equal(p1.observe([newGame]), null);
  assert.equal(p2.observe([newGame]), null);
  assert.deepEqual(p1.observe([{ actor_id: 0, type: "MIDDLE_CARD", data: { card: "10C" } }]), {
    actorId: 1,
    kind: "BUY_CALL",
    phase: "1"
  });
  assert.equal(p2.observe([{ actor_id: 0, type: "MIDDLE_CARD", data: { card: "10C" } }]), null);
});

test("turn tracker advances to next card player", () => {
  const p2 = new TurnTracker(2);
  p2.observe([
    { actor_id: 0, type: "NEW_GAME", data: { game: "1", initiator: "1", nitwit: "2", cutter: "3", dealer: "4" } },
    { actor_id: 0, type: "MIDDLE_CARD", data: { card: "10C" } },
    { actor_id: 1, type: "BUY_CALL", data: { call: "SUN", phase: "1", trump: "" } },
    { actor_id: 4, type: "BUY_CALL", data: { call: "BAS", phase: "discussion", trump: "" } },
    { actor_id: 3, type: "BUY_CALL", data: { call: "BAS", phase: "discussion", trump: "" } },
    { actor_id: 2, type: "BUY_CALL", data: { call: "BAS", phase: "discussion", trump: "" } },
    { actor_id: 0, type: "DEAL_2", data: { cards: "7C,8C,9C" } }
  ]);
  const prompt = p2.observe([{ actor_id: 1, type: "PLAY_CARD", data: { round: "1", card: "AS" } }]);
  assert.deepEqual(prompt, { actorId: 2, kind: "PLAY_CARD", round: 1 });
});
