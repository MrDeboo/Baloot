import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EngineSeatConnection } from "./engine-client.js";
import { BUY_CALLS, TurnTracker } from "./turn-tracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const VALID_BUY_CALLS = new Set(BUY_CALLS);
const VALID_SUITS = new Set(["C", "D", "H", "S"]);
const VALID_PROJECTS = new Set(["SIRA", "FIFTY", "HUNDRED", "FOUR_HUNDRED"]);
const BID_PHASE_CALLS = new Set(["BAS", "SUN", "HUKUM", "ASHKAL"]);
const DISCUSSION_CALLS = new Set([
  "BAS",
  "GABLAK_SUN",
  "GABLAK_ASHKAL",
  "BET_OPEN",
  "BET_CLOSE",
  "BET_DOUBLE",
  "BET_TRIPLE",
  "BET_QUADRUPLE",
  "GAHWA"
]);
const BET_CALLS = new Set(["BET_OPEN", "BET_CLOSE", "BET_DOUBLE", "BET_TRIPLE", "BET_QUADRUPLE", "GAHWA"]);
const ENFORCE_CALLS = new Set(["BAS", "ENFORCE_SUN", "ENFORCE_HUKUM"]);
const CARD_PATTERN = /^(?:7|8|9|10|J|Q|K|A)[CDHS]$/;
const SUN_STRENGTH = new Map([
  ["A", 8],
  ["10", 7],
  ["K", 6],
  ["Q", 5],
  ["J", 4],
  ["9", 3],
  ["8", 2],
  ["7", 1]
]);
const HUKUM_TRUMP_STRENGTH = new Map([
  ["J", 8],
  ["9", 7],
  ["A", 6],
  ["10", 5],
  ["K", 4],
  ["Q", 3],
  ["8", 2],
  ["7", 1]
]);

function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseCards(text) {
  const value = Array.isArray(text) ? text.join(",") : text;
  return String(value || "")
    .split(/[,\s]+/)
    .map((card) => card.trim().toUpperCase())
    .filter(Boolean);
}

function normalizeToken(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeCard(value, field = "card") {
  const card = normalizeToken(value);
  if (!CARD_PATTERN.test(card)) {
    throw new Error(`Invalid ${field}.`);
  }
  return card;
}

function cardParts(card) {
  const code = normalizeCard(card);
  return { code, rank: code.slice(0, -1), suit: code.slice(-1) };
}

function normalizeBuyCall(body) {
  const call = normalizeToken(body.call);
  if (!call) throw new Error("BUY_CALL requires a call.");
  if (!VALID_BUY_CALLS.has(call)) throw new Error(`Unsupported BUY_CALL ${call}.`);

  const trump = normalizeToken(body.trump);
  if (trump && !VALID_SUITS.has(trump)) throw new Error("Invalid trump suit.");

  const data = { call };
  if (trump) data.trump = trump;
  return data;
}

function requireCardsInHand(cards, hand, field) {
  for (const card of cards) {
    if (!hand.includes(card)) throw new Error(`${field} ${card} is not in your hand.`);
  }
}

function normalizeProjects(value, hand) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("projects must be an array.");

  return value.map((project, index) => {
    if (!project || typeof project !== "object") {
      throw new Error(`Project ${index + 1} must be an object.`);
    }

    const kind = normalizeToken(project.project);
    if (!VALID_PROJECTS.has(kind)) throw new Error(`Unsupported project ${kind || "(blank)"}.`);

    const cards = parseCards(project.cards).map((card) => normalizeCard(card, "project card"));
    if (cards.length === 0) throw new Error(`Project ${kind} requires cards.`);
    requireCardsInHand(cards, hand, "Project card");

    return { project: kind, cards: cards.join(",") };
  });
}

function optionalBoolean(body, field) {
  if (body[field] == null) return false;
  if (typeof body[field] !== "boolean") throw new Error(`${field} must be a boolean.`);
  return body[field];
}

export function defaultEngineBinaryCandidates(root = repoRoot) {
  return [
    path.resolve(root, "build/baloot-server"),
    path.resolve(root, "build/Release/baloot-server.exe"),
    path.resolve(root, "build/baloot-server.exe")
  ];
}

export function engineBinaryCandidates(value, { cwd = process.cwd(), root = repoRoot } = {}) {
  if (!value) return defaultEngineBinaryCandidates(root);
  if (path.isAbsolute(value)) return [value];
  return [
    path.resolve(cwd, value),
    path.resolve(root, "activity", value),
    path.resolve(root, value)
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
}

export function resolveEngineBinary(value = "", { exists = fs.existsSync, cwd = process.cwd(), root = repoRoot } = {}) {
  const candidates = engineBinaryCandidates(value, { cwd, root });
  return candidates.find((candidate) => exists(candidate)) ?? candidates[0];
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function publicUser(user, participant) {
  return {
    id: user.id,
    name: user.name,
    avatar: user.avatar ?? "",
    role: participant.role,
    seat: participant.seat
  };
}

export class ActivityHub {
  constructor(options = {}) {
    this.options = {
      engineBin: options.engineBin ?? resolveEngineBinary(process.env.BALOOT_SERVER_BIN),
      targetScore: Number(options.targetScore ?? process.env.BALOOT_TARGET_SCORE ?? 152),
      readTimeoutMs: Number(options.readTimeoutMs ?? process.env.BALOOT_READ_TIMEOUT_MS ?? 900000),
      disconnectGraceMs: Number(options.disconnectGraceMs ?? process.env.ACTIVITY_DISCONNECT_GRACE_MS ?? 10000)
    };
    this.rooms = new Map();
  }

  getRoom(roomId) {
    const id = roomId || "default";
    if (!this.rooms.has(id)) {
      this.rooms.set(id, new ActivityRoom(id, this.options));
    }
    return this.rooms.get(id);
  }

  closeAll() {
    for (const room of this.rooms.values()) {
      room.close();
    }
    this.rooms.clear();
  }
}

export class ActivityRoom extends EventEmitter {
  constructor(id, options) {
    super();
    this.id = id;
    this.options = options;
    this.status = "lobby";
    this.participants = new Map();
    this.clients = new Set();
    this.closed = false;
    this.engine = null;
    this.playersBySeat = new Map();
    this.disconnectTimers = new Map();
    this.publicActionKeys = new Set();
    this.currentTurn = null;
    this.contractInfo = null;
    this.discussionLastRaiserTeam = null;
    this.pendingIkkahSeats = new Set();
    this.balootHalfSeenSeats = new Set();
    this.projectClosedSeats = new Set();
    this.error = "";
    this.state = {
      matchId: "",
      seats: {},
      scores: { A: 0, B: 0 },
      middle: "",
      contract: "",
      round: 0,
      trick: [],
      log: [],
      hands: new Map()
    };
  }

  connect({ user, response }) {
    const participant = this.ensureParticipant(user);
    const client = { id: uniqueId("sse"), userId: user.id, response };
    this.clients.add(client);

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.write("\n");
    this.sendTo(client, "snapshot", this.snapshotFor(user.id));

    response.on("close", () => {
      this.clients.delete(client);
      this.markDisconnected(user.id);
      this.broadcast();
    });

    this.maybeStart();
    return participant;
  }

  ensureParticipant(user) {
    this.pruneLobbyDisconnects();
    const existing = this.participants.get(user.id);
    if (existing) {
      existing.user = { ...existing.user, ...user };
      existing.connected = true;
      this.cancelDisconnectForfeit(user.id, existing);
      if (this.status === "lobby" && existing.role === "spectator") {
        const players = this.connectedPlayers();
        if (players.length < 4) {
          existing.role = "player";
          existing.seat = players.length + 1;
          this.playersBySeat.set(existing.seat, user.id);
          this.state.hands.set(existing.seat, []);
        }
      }
      return existing;
    }

    const players = this.connectedPlayers();
    const asPlayer = this.status === "lobby" && players.length < 4;
    const participant = {
      user,
      connected: true,
      role: asPlayer ? "player" : "spectator",
      seat: asPlayer ? players.length + 1 : null
    };
    this.participants.set(user.id, participant);
    if (participant.role === "player") this.playersBySeat.set(participant.seat, user.id);
    if (participant.seat) this.state.hands.set(participant.seat, []);
    this.broadcast();
    return participant;
  }

  markDisconnected(userId) {
    if (this.closed) return;
    const participant = this.participants.get(userId);
    if (!participant) return;
    const stillConnected = [...this.clients].some((client) => client.userId === userId);
    participant.connected = stillConnected;
    if (this.status === "lobby" && !stillConnected) {
      this.participants.delete(userId);
      this.compactLobbySeats();
      return;
    }
    if ((this.status === "starting" || this.status === "playing") && !stillConnected && participant.role === "player") {
      this.scheduleDisconnectForfeit(userId, participant);
    }
  }

  scheduleDisconnectForfeit(userId, participant) {
    if (this.disconnectTimers.has(userId)) return;
    const graceMs = Math.max(0, Number(this.options.disconnectGraceMs ?? 10000));
    this.state.log.push(
      `P${participant.seat} disconnected; ${graceMs > 0 ? `forfeit in ${Math.ceil(graceMs / 1000)}s` : "forfeiting"}`
    );
    if (this.state.log.length > 80) this.state.log = this.state.log.slice(-80);

    const forfeit = () => {
      this.disconnectTimers.delete(userId);
      const current = this.participants.get(userId);
      if (!current || current.connected || current.role !== "player") return;
      if (this.status !== "starting" && this.status !== "playing") return;
      this.state.log.push(`P${current.seat} forfeited after disconnect`);
      if (this.state.log.length > 80) this.state.log = this.state.log.slice(-80);
      this.currentTurn = null;
      this.engine?.forfeitSeat(current.seat);
      this.broadcast();
    };

    if (graceMs === 0) {
      forfeit();
      return;
    }
    const timer = setTimeout(forfeit, graceMs);
    timer.unref?.();
    this.disconnectTimers.set(userId, timer);
  }

  cancelDisconnectForfeit(userId, participant) {
    const timer = this.disconnectTimers.get(userId);
    if (!timer) return;
    clearTimeout(timer);
    this.disconnectTimers.delete(userId);
    if (participant.role === "player" && (this.status === "starting" || this.status === "playing")) {
      this.state.log.push(`P${participant.seat} reconnected`);
      if (this.state.log.length > 80) this.state.log = this.state.log.slice(-80);
    }
  }

  clearDisconnectTimers() {
    for (const timer of this.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectTimers.clear();
  }

  maybeStart() {
    this.pruneLobbyDisconnects();
    const seatedPlayers = this.connectedPlayers();
    if (this.status !== "lobby" || seatedPlayers.length !== 4) return;
    this.startMatch().catch((error) => {
      this.status = "error";
      this.error = error.message;
      this.broadcast();
    });
  }

  async startMatch() {
    this.status = "starting";
    this.broadcast();
    this.engine = new EngineMatch(this, this.options);
    await this.engine.start();
    this.status = "playing";
    this.broadcast();
  }

  connectedPlayers() {
    return [...this.participants.values()]
      .filter((p) => p.role === "player" && p.connected)
      .sort((a, b) => a.seat - b.seat);
  }

  pruneLobbyDisconnects() {
    if (this.status !== "lobby") return;
    let changed = false;
    for (const [userId, participant] of this.participants) {
      if (!participant.connected) {
        this.participants.delete(userId);
        changed = true;
      }
    }
    if (changed) this.compactLobbySeats();
  }

  compactLobbySeats() {
    this.playersBySeat.clear();
    this.state.hands.clear();
    const players = [...this.participants.values()]
      .filter((p) => p.role === "player" && p.connected)
      .sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
    players.forEach((participant, index) => {
      participant.seat = index + 1;
      this.playersBySeat.set(participant.seat, participant.user.id);
      this.state.hands.set(participant.seat, []);
    });
  }

  submitAction(userId, body) {
    const participant = this.participants.get(userId);
    if (!participant || participant.role !== "player") {
      throw new Error("Only seated players can submit actions.");
    }
    if (this.status !== "playing" || !this.currentTurn) {
      throw new Error("The engine is not waiting for an action.");
    }
    if (participant.seat !== this.currentTurn.actorId) {
      throw new Error("It is not your turn.");
    }

    const kind = normalizeToken(body.kind);
    if (kind !== this.currentTurn.kind) {
      throw new Error(`Expected ${this.currentTurn.kind} action.`);
    }

    const actions = [];
    if (kind === "BUY_CALL") {
      const data = normalizeBuyCall(body);
      this.validateBuyCall(participant.seat, data);
      actions.push({ actor_id: participant.seat, type: "BUY_CALL", data });
    } else if (kind === "PLAY_CARD") {
      const hand = this.state.hands.get(participant.seat) ?? [];
      const card = normalizeCard(body.card, "PLAY_CARD card");
      requireCardsInHand([card], hand, "Played card");
      const legalCards = this.legalCardsForSeat(participant.seat);
      if (legalCards.length > 0 && !legalCards.includes(card)) {
        throw new Error(`Played card ${card} is not legal now. Legal cards: ${legalCards.join(", ")}.`);
      }

      const projects = normalizeProjects(body.projects, hand);
      if (projects.length > 0 && this.projectClosedSeats.has(participant.seat)) {
        throw new Error("Projects must be declared before your first play.");
      }
      const ikkah = optionalBoolean(body, "ikkah");
      const baloot = optionalBoolean(body, "baloot");
      this.validatePlayDeclarations(participant.seat, card, { ikkah, baloot });

      for (const project of projects) {
        actions.push({
          actor_id: participant.seat,
          type: "STATE_PROJECT",
          data: project
        });
      }
      if (ikkah) actions.push({ actor_id: participant.seat, type: "IKKAH", data: {} });
      if (baloot) actions.push({ actor_id: participant.seat, type: "BALOOT", data: {} });
      actions.push({
        actor_id: participant.seat,
        type: "PLAY_CARD",
        data: { card }
      });
    } else {
      throw new Error("Unsupported action kind.");
    }

    this.engine.sendActions(participant.seat, actions);
    this.currentTurn = null;
    this.broadcast();
  }

  applyEngineActions(targetSeat, envelope) {
    const actions = envelope.actions ?? [];
    for (const action of actions) {
      if (action.type === "DEAL_1" || action.type === "DEAL_2") {
        const hand = this.state.hands.get(targetSeat) ?? [];
        hand.push(...parseCards(action.data.cards));
        this.state.hands.set(targetSeat, hand);
        continue;
      }

      const dedupeData =
        action.type === "NEW_SAKKAH"
          ? {}
          : action.type === "NEW_GAME"
            ? {
                game: action.data.game,
                initiator: action.data.initiator,
                nitwit: action.data.nitwit,
                cutter: action.data.cutter,
                dealer: action.data.dealer
              }
            : action.data;
      const publicKey = `${envelope.match_id}:${envelope.seq}:${action.actor_id}:${action.type}:${JSON.stringify(dedupeData)}`;
      if (this.publicActionKeys.has(publicKey)) continue;
      this.publicActionKeys.add(publicKey);
      this.applyPublicAction(action);
    }
    this.broadcast();
  }

  applyPublicAction(action) {
    switch (action.type) {
      case "NEW_SAKKAH":
        this.state.log.push("New sakkah started");
        break;
      case "NEW_GAME":
        this.state.seats = {
          initiator: Number(action.data.initiator),
          nitwit: Number(action.data.nitwit),
          cutter: Number(action.data.cutter),
          dealer: Number(action.data.dealer)
        };
        this.state.middle = "";
        this.state.contract = "";
        this.state.round = 0;
        this.state.trick = [];
        this.contractInfo = null;
        this.discussionLastRaiserTeam = null;
        this.pendingIkkahSeats.clear();
        this.balootHalfSeenSeats.clear();
        this.projectClosedSeats.clear();
        this.state.log.push(`Game ${action.data.game} started`);
        break;
      case "MIDDLE_CARD":
        this.state.middle = action.data.card;
        this.state.log.push(`Middle card ${action.data.card}`);
        break;
      case "BUY_CALL":
        this.updateContractFromBuy(action);
        this.state.contract = `${action.actor_id}: ${action.data.call}${action.data.trump ? ` ${action.data.trump}` : ""}`;
        this.state.log.push(`P${action.actor_id} called ${action.data.call}`);
        break;
      case "STATE_PROJECT":
        this.state.log.push(`P${action.actor_id} declared ${action.data.project}`);
        break;
      case "SHOW_PROJECT":
        this.state.log.push(`P${action.actor_id} showed ${action.data.project} for ${action.data.score}`);
        break;
      case "PLAY_CARD": {
        const hand = this.state.hands.get(action.actor_id) ?? [];
        const index = hand.indexOf(action.data.card);
        if (index !== -1) hand.splice(index, 1);
        this.state.round = Number(action.data.round || this.state.round);
        if (this.state.trick.length >= 4 || this.state.trick.some((p) => p.round !== this.state.round)) {
          this.state.trick = [];
        }
        this.state.trick.push({
          player: action.actor_id,
          card: action.data.card,
          round: this.state.round,
          ikkah: this.pendingIkkahSeats.has(action.actor_id)
        });
        this.rememberBalootHalf(action.actor_id, action.data.card);
        this.pendingIkkahSeats.delete(action.actor_id);
        this.projectClosedSeats.add(action.actor_id);
        this.state.log.push(`R${this.state.round} P${action.actor_id} played ${action.data.card}`);
        break;
      }
      case "IKKAH":
        this.pendingIkkahSeats.add(action.actor_id);
        this.state.log.push(`P${action.actor_id} declared ${action.type}`);
        break;
      case "BALOOT":
        this.state.log.push(`P${action.actor_id} declared ${action.type}`);
        break;
      default:
        break;
    }
    if (this.state.log.length > 80) this.state.log = this.state.log.slice(-80);
  }

  updateContractFromBuy(action) {
    const call = normalizeToken(action.data.call);
    if (call === "BAS") return;

    const trump = normalizeToken(action.data.trump);
    if (call === "ENFORCE_SUN" && this.contractInfo) {
      this.contractInfo.mode = "SUN";
      this.contractInfo.trump = "";
      this.discussionLastRaiserTeam = null;
      return;
    }
    if (call === "ENFORCE_HUKUM" && this.contractInfo) {
      this.contractInfo.mode = "HUKUM";
      this.contractInfo.trump = trump || this.contractInfo.trump || this.middleSuit();
      return;
    }
    if (call === "GABLAK_SUN" || call === "GABLAK_ASHKAL") {
      this.contractInfo = {
        mode: "SUN",
        trump: "",
        buyerId: action.actor_id,
        buyerTeam: this.teamOfSeat(action.actor_id),
        sourceCall: call,
        multiplier: 1,
        closed: false
      };
      this.discussionLastRaiserTeam = null;
      return;
    }
    if (call.startsWith("BET_") || call === "GAHWA") {
      if (!this.contractInfo) return;
      const actorTeam = this.teamOfSeat(action.actor_id);
      if (call === "BET_TRIPLE") this.contractInfo.multiplier = Math.max(this.contractInfo.multiplier, 3);
      else if (call === "BET_QUADRUPLE") this.contractInfo.multiplier = Math.max(this.contractInfo.multiplier, 4);
      else if (call !== "GAHWA") this.contractInfo.multiplier = Math.max(this.contractInfo.multiplier, 2);
      this.contractInfo.closed = call === "BET_CLOSE";
      this.discussionLastRaiserTeam = actorTeam;
      return;
    }
    if (call === "SUN" || call === "ASHKAL" || call === "HUKUM") {
      this.contractInfo = {
        mode: call === "HUKUM" ? "HUKUM" : "SUN",
        trump: call === "HUKUM" ? trump || this.middleSuit() : "",
        buyerId: action.actor_id,
        buyerTeam: this.teamOfSeat(action.actor_id),
        sourceCall: call,
        multiplier: 1,
        closed: false
      };
      this.discussionLastRaiserTeam = null;
    }
  }

  validateBuyCall(seat, data) {
    const call = data.call;
    const phase = String(this.currentTurn?.phase || "");
    const trump = data.trump || "";

    if (trump && call !== "HUKUM" && call !== "ENFORCE_HUKUM") {
      throw new Error("Trump is only valid for HUKUM calls.");
    }

    if (phase === "1" || phase === "2") {
      if (!BID_PHASE_CALLS.has(call)) throw new Error(`BUY_CALL ${call} is not legal in phase ${phase}.`);
      if (call === "ASHKAL") {
        if (phase === "2") throw new Error("ASHKAL is not legal in phase 2.");
        if (!this.isCutterOrDealer(seat)) throw new Error("ASHKAL is only legal for cutter or dealer.");
      }
      if (phase === "2" && call === "HUKUM") {
        if (!trump) throw new Error("Phase 2 HUKUM must choose a trump suit.");
        if (trump === this.middleSuit()) throw new Error("Phase 2 HUKUM cannot use the middle suit.");
      }
      return;
    }

    if (phase === "discussion") {
      if (!DISCUSSION_CALLS.has(call)) throw new Error(`BUY_CALL ${call} is not legal during discussion.`);
      if (call === "BAS") return;
      if (!this.contractInfo) throw new Error("Discussion calls require an active contract.");

      if (call === "GABLAK_SUN" || call === "GABLAK_ASHKAL") {
        if (call === "GABLAK_ASHKAL" && !this.isCutterOrDealer(seat)) {
          throw new Error("GABLAK_ASHKAL is only legal for cutter or dealer.");
        }
        if (this.teamOfSeat(seat) === this.contractInfo.buyerTeam && this.contractInfo.sourceCall !== "HUKUM") {
          throw new Error("Cannot gablak a teammate unless the original buy was HUKUM.");
        }
        return;
      }

      if (BET_CALLS.has(call)) {
        const actorTeam = this.teamOfSeat(seat);
        if (!this.discussionLastRaiserTeam && actorTeam === this.contractInfo.buyerTeam) {
          throw new Error("Buyer team cannot open the bet.");
        }
        if (this.contractInfo.mode === "SUN" && call === "BET_CLOSE") {
          throw new Error("Sun betting can only be open.");
        }
        if (this.discussionLastRaiserTeam && actorTeam === this.discussionLastRaiserTeam) {
          throw new Error("Betting must alternate between teams.");
        }
        const nextMultiplier = this.betMultiplier(call, this.contractInfo.multiplier);
        if (nextMultiplier < this.contractInfo.multiplier) {
          throw new Error("Bet multiplier cannot decrease.");
        }
        return;
      }
    }

    if (phase === "enforce") {
      if (!ENFORCE_CALLS.has(call)) throw new Error(`BUY_CALL ${call} is not legal during enforce.`);
      if (!this.contractInfo || this.contractInfo.mode !== "HUKUM") {
        throw new Error("Enforce calls require an active HUKUM contract.");
      }
      return;
    }

    throw new Error(`Unsupported BUY_CALL phase ${phase || "(unknown)"}.`);
  }

  isCutterOrDealer(seat) {
    if (this.state.seats.cutter || this.state.seats.dealer) {
      return seat === this.state.seats.cutter || seat === this.state.seats.dealer;
    }
    return seat === 3 || seat === 4;
  }

  betMultiplier(call, current) {
    if (call === "BET_TRIPLE") return Math.max(current, 3);
    if (call === "BET_QUADRUPLE") return Math.max(current, 4);
    if (call === "GAHWA") return current;
    return Math.max(current, 2);
  }

  middleSuit() {
    return this.state.middle ? this.state.middle.slice(-1) : "";
  }

  teamOfSeat(seat) {
    if (seat === this.state.seats.initiator || seat === this.state.seats.cutter) return "A";
    if (seat === this.state.seats.nitwit || seat === this.state.seats.dealer) return "B";
    return seat % 2 === 1 ? "A" : "B";
  }

  activeTrickForTurn() {
    if (this.currentTurn?.kind !== "PLAY_CARD") return [];
    const round = Number(this.currentTurn.round || this.state.round);
    if (!round || Number(this.state.round) !== round || this.state.trick.length >= 4) return [];
    return this.state.trick.filter((play) => Number(play.round) === round);
  }

  legalCardsForSeat(seat) {
    const hand = this.state.hands.get(seat) ?? [];
    if (hand.length === 0) return [];
    const contract = this.contractInfo;
    if (!contract) return hand;

    const plays = this.activeTrickForTurn();
    if (plays.length === 0) {
      if (
        contract.mode === "HUKUM" &&
        contract.closed &&
        contract.trump &&
        hand.some((card) => cardParts(card).suit !== contract.trump)
      ) {
        return hand.filter((card) => cardParts(card).suit !== contract.trump);
      }
      return hand;
    }

    const ledSuit = cardParts(plays[0].card).suit;
    const follow = hand.filter((card) => cardParts(card).suit === ledSuit);
    if (follow.length > 0) {
      if (contract.mode === "HUKUM" && contract.trump && ledSuit === contract.trump) {
        const winning = plays[this.winningPlayIndex(plays, contract)];
        if (winning && this.teamOfSeat(winning.player) !== this.teamOfSeat(seat)) {
          const higher = this.higherTrumpsThan(follow, winning.card, contract.trump);
          if (higher.length > 0) return higher;
        }
      }
      return follow;
    }

    if (contract.mode !== "HUKUM" || !contract.trump) return hand;

    const trumps = hand.filter((card) => cardParts(card).suit === contract.trump);
    if (trumps.length === 0) return hand;

    const winning = plays[this.winningPlayIndex(plays, contract)];
    const currentSideWinning = winning && this.teamOfSeat(winning.player) === this.teamOfSeat(seat);
    const playerPosition = plays.length + 1;
    if (currentSideWinning && playerPosition === 4) return hand;

    const partnerIkkah = plays.some((play) => play.ikkah && this.teamOfSeat(play.player) === this.teamOfSeat(seat));
    if (partnerIkkah) return hand;

    if (winning && this.isTrump(winning.card, contract)) {
      if (this.teamOfSeat(winning.player) !== this.teamOfSeat(seat)) {
        const higher = this.higherTrumpsThan(trumps, winning.card, contract.trump);
        if (higher.length > 0) return higher;
        if (playerPosition === 3) return hand;
      }
    }

    return trumps;
  }

  declarationCardsForSeat(seat, legalCards = this.legalCardsForSeat(seat)) {
    return {
      ikkahCards: this.ikkahCardsForSeat(seat, legalCards),
      balootCards: this.balootCardsForSeat(seat, legalCards)
    };
  }

  ikkahCardsForSeat(seat, legalCards) {
    const contract = this.contractInfo;
    if (!contract || contract.mode !== "HUKUM" || !contract.trump) return [];
    if (this.activeTrickForTurn().length !== 0) return [];
    return legalCards.filter((card) => {
      const parsed = cardParts(card);
      return parsed.suit !== contract.trump && this.isHighestRemainingSuitCard(seat, card);
    });
  }

  balootCardsForSeat(seat, legalCards) {
    const contract = this.contractInfo;
    if (!contract || contract.mode !== "HUKUM" || !contract.trump || !this.balootHalfSeenSeats.has(seat)) {
      return [];
    }
    return legalCards.filter((card) => {
      const parsed = cardParts(card);
      return parsed.suit === contract.trump && (parsed.rank === "K" || parsed.rank === "Q");
    });
  }

  validatePlayDeclarations(seat, card, { ikkah, baloot }) {
    if (ikkah && !this.ikkahCardsForSeat(seat, this.legalCardsForSeat(seat)).includes(card)) {
      throw new Error("IKKAH requires a HUKUM trick lead with the highest remaining non-trump suit card.");
    }
    if (baloot && !this.balootCardsForSeat(seat, this.legalCardsForSeat(seat)).includes(card)) {
      throw new Error("BALOOT must be declared on the second trump K/Q in HUKUM.");
    }
  }

  isHighestRemainingSuitCard(seat, playedCard) {
    const played = cardParts(playedCard);
    const playedStrength = SUN_STRENGTH.get(played.rank) ?? 0;
    for (const [otherSeat, hand] of this.state.hands) {
      for (const card of hand) {
        if (otherSeat === seat && card === played.code) continue;
        const parsed = cardParts(card);
        if (parsed.suit === played.suit && (SUN_STRENGTH.get(parsed.rank) ?? 0) > playedStrength) {
          return false;
        }
      }
    }
    return true;
  }

  rememberBalootHalf(seat, card) {
    const contract = this.contractInfo;
    if (!contract || contract.mode !== "HUKUM" || !contract.trump) return;
    const parsed = cardParts(card);
    if (parsed.suit === contract.trump && (parsed.rank === "K" || parsed.rank === "Q")) {
      this.balootHalfSeenSeats.add(seat);
    }
  }

  isTrump(card, contract) {
    return contract.mode === "HUKUM" && contract.trump && cardParts(card).suit === contract.trump;
  }

  cardStrength(card, contract) {
    const parsed = cardParts(card);
    if (this.isTrump(card, contract)) return HUKUM_TRUMP_STRENGTH.get(parsed.rank) ?? 0;
    return SUN_STRENGTH.get(parsed.rank) ?? 0;
  }

  higherTrumpsThan(cards, currentHigh, trump) {
    const contract = { mode: "HUKUM", trump };
    const current = this.cardStrength(currentHigh, contract);
    return cards.filter((card) => cardParts(card).suit === trump && this.cardStrength(card, contract) > current);
  }

  cardBeats(challenger, current, ledSuit, contract) {
    const challengerSuit = cardParts(challenger).suit;
    const currentSuit = cardParts(current).suit;
    const challengerTrump = this.isTrump(challenger, contract);
    const currentTrump = this.isTrump(current, contract);
    if (challengerTrump !== currentTrump) return challengerTrump;
    if (challengerSuit !== currentSuit) {
      if (challengerSuit === ledSuit) return true;
      if (currentSuit === ledSuit) return false;
      return false;
    }
    return this.cardStrength(challenger, contract) > this.cardStrength(current, contract);
  }

  winningPlayIndex(plays, contract) {
    if (plays.length === 0) return -1;
    const ledSuit = cardParts(plays[0].card).suit;
    let winner = 0;
    for (let index = 1; index < plays.length; index += 1) {
      if (this.cardBeats(plays[index].card, plays[winner].card, ledSuit, contract)) winner = index;
    }
    return winner;
  }

  applyControl(message) {
    if (message.kind === "MATCH_FOUND") {
      this.state.matchId = message.match_id;
      return;
    }
    if (message.kind === "MATCH_END") {
      this.status = "ended";
      this.currentTurn = null;
      this.state.scores = {
        A: Number(message.team_a_score || 0),
        B: Number(message.team_b_score || 0)
      };
      this.state.log.push(`Match ended: Team ${message.winner_team} won`);
      this.broadcast();
      return;
    }
    if (message.kind === "ERROR" || message.kind === "GAID") {
      this.state.log.push(message.message || message.kind);
      this.broadcast();
    }
  }

  setTurn(prompt) {
    this.currentTurn = prompt;
    this.broadcast();
  }

  sendTo(client, event, payload) {
    client.response.write(`event: ${event}\n`);
    client.response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcast() {
    for (const client of this.clients) {
      this.sendTo(client, "snapshot", this.snapshotFor(client.userId));
    }
  }

  snapshotFor(userId) {
    const participant = this.participants.get(userId);
    const players = [...this.participants.values()]
      .filter((p) => p.role === "player")
      .sort((a, b) => a.seat - b.seat)
      .map((p) => publicUser(p.user, p));
    const spectators = [...this.participants.values()]
      .filter((p) => p.role === "spectator")
      .map((p) => publicUser(p.user, p));
    const seat = participant?.seat ?? null;
    const legalCards =
      seat && this.currentTurn?.kind === "PLAY_CARD" && this.currentTurn.actorId === seat
        ? this.legalCardsForSeat(seat)
        : [];
    const declarations =
      seat && this.currentTurn?.kind === "PLAY_CARD" && this.currentTurn.actorId === seat
        ? this.declarationCardsForSeat(seat, legalCards)
        : { ikkahCards: [], balootCards: [] };
    return {
      roomId: this.id,
      status: this.status,
      error: this.error,
      self: {
        role: participant?.role ?? "spectator",
        seat,
        hand: seat ? this.state.hands.get(seat) ?? [] : [],
        legalCards,
        declarations
      },
      players,
      spectators,
      currentTurn: this.currentTurn,
      state: {
        matchId: this.state.matchId,
        seats: this.state.seats,
        scores: this.state.scores,
        middle: this.state.middle,
        contract: this.state.contract,
        round: this.state.round,
        trick: this.state.trick,
        log: this.state.log
      }
    };
  }

  close() {
    this.closed = true;
    this.clearDisconnectTimers();
    for (const client of this.clients) {
      client.response.end?.();
    }
    this.clients.clear();
    this.engine?.stop();
  }
}

class EngineMatch {
  constructor(room, options) {
    this.room = room;
    this.options = options;
    this.process = null;
    this.seats = new Map();
    this.trackers = new Map();
  }

  async start() {
    const port = await this.spawnServer();
    const players = [...this.room.participants.values()]
      .filter((p) => p.role === "player")
      .sort((a, b) => a.seat - b.seat);

    for (const player of players) {
      await this.connectSeat(port, player);
    }
  }

  async spawnServer() {
    const port = await reservePort();
    return new Promise((resolve, reject) => {
      const args = [
        "--port",
        String(port),
        "--matches",
        "1",
        "--target-score",
        String(this.options.targetScore),
        "--read-timeout-ms",
        String(this.options.readTimeoutMs),
        "--log-level",
        "quiet"
      ];
      this.process = spawn(this.options.engineBin, args, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let settled = false;
      const startupTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(port);
        }
      }, 100);

      this.process.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) this.room.state.log.push(text);
      });
      this.process.stderr.on("data", (chunk) => {
        this.room.state.log.push(chunk.toString("utf8").trim());
        this.room.broadcast();
      });
      this.process.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          reject(new Error(`baloot-server exited before startup (${code}).`));
        }
      });
      this.process.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          reject(error);
        }
      });
    });
  }

  async connectSeat(port, participant) {
    const connection = new EngineSeatConnection({
      port,
      name: participant.user.name
    });
    this.seats.set(participant.seat, connection);
    this.trackers.set(participant.seat, new TurnTracker(participant.seat));

    connection.on("message", (message) => this.handleMessage(participant.seat, message));
    connection.on("error", (error) => {
      this.room.state.log.push(`Seat ${participant.seat} engine error: ${error.message}`);
      this.room.broadcast();
    });

    const joined = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Seat ${participant.seat} did not join lobby.`)), 5000);
      connection.once("joined_lobby", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    await connection.connect();
    await joined;
  }

  handleMessage(seat, message) {
    if (message.kind === "WELCOME") {
      this.seats.get(seat).joinLobby().catch((error) => {
        this.room.state.log.push(`Seat ${seat} lobby error: ${error.message}`);
        this.room.broadcast();
      });
      return;
    }
    if (message.kind === "PING") {
      this.seats.get(seat).writeControl("PONG", { nonce: message.nonce ?? "" }).catch(() => {});
      return;
    }
    if (message.kind === "MATCH_FOUND") {
      if (Number(message.self_id) !== seat) {
        this.room.status = "error";
        this.room.error = `Engine assigned seat ${message.self_id} to Activity seat ${seat}.`;
      }
      this.room.applyControl(message);
      return;
    }
    if (message.kind === "ACTIONS") {
      this.room.applyEngineActions(seat, message);
      const prompt = this.trackers.get(seat).observe(message.actions ?? []);
      if (prompt) this.room.setTurn(prompt);
      return;
    }
    this.room.applyControl(message);
  }

  sendActions(seat, actions) {
    const connection = this.seats.get(seat);
    if (!connection) throw new Error("Engine seat is not connected.");
    connection.sendActions(actions);
  }

  forfeitSeat(seat) {
    const connection = this.seats.get(seat);
    if (!connection) return;
    connection.close();
  }

  stop() {
    for (const connection of this.seats.values()) {
      connection.close();
    }
    this.seats.clear();
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}
