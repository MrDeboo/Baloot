import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EngineSeatConnection } from "./engine-client.js";
import { TurnTracker } from "./turn-tracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseCards(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map((card) => card.trim().toUpperCase())
    .filter(Boolean);
}

function defaultEngineBinary() {
  const candidates = [
    path.resolve(repoRoot, "build/baloot-server"),
    path.resolve(repoRoot, "build/Release/baloot-server.exe"),
    path.resolve(repoRoot, "build/baloot-server.exe")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
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
      engineBin: options.engineBin ?? process.env.BALOOT_SERVER_BIN ?? defaultEngineBinary(),
      targetScore: Number(options.targetScore ?? process.env.BALOOT_TARGET_SCORE ?? 152),
      readTimeoutMs: Number(options.readTimeoutMs ?? process.env.BALOOT_READ_TIMEOUT_MS ?? 900000)
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
}

export class ActivityRoom extends EventEmitter {
  constructor(id, options) {
    super();
    this.id = id;
    this.options = options;
    this.status = "lobby";
    this.participants = new Map();
    this.clients = new Set();
    this.engine = null;
    this.playersBySeat = new Map();
    this.publicActionKeys = new Set();
    this.currentTurn = null;
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
    const existing = this.participants.get(user.id);
    if (existing) {
      existing.user = { ...existing.user, ...user };
      existing.connected = true;
      return existing;
    }

    const players = [...this.participants.values()].filter((p) => p.role === "player");
    const asPlayer = this.status === "lobby" && players.length < 4;
    const participant = {
      user,
      connected: true,
      role: asPlayer ? "player" : "spectator",
      seat: asPlayer ? players.length + 1 : null
    };
    this.participants.set(user.id, participant);
    if (participant.role === "player") this.playersBySeat.set(participant.seat, user.id);
    this.state.hands.set(participant.seat, []);
    this.broadcast();
    return participant;
  }

  markDisconnected(userId) {
    const participant = this.participants.get(userId);
    if (!participant) return;
    const stillConnected = [...this.clients].some((client) => client.userId === userId);
    participant.connected = stillConnected;
  }

  maybeStart() {
    const seatedPlayers = [...this.participants.values()].filter((p) => p.role === "player");
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

    const actions = [];
    if (body.kind === "BUY_CALL") {
      const data = { call: String(body.call || "BAS").toUpperCase() };
      if (body.trump) data.trump = String(body.trump).toUpperCase();
      actions.push({ actor_id: participant.seat, type: "BUY_CALL", data });
    } else if (body.kind === "PLAY_CARD") {
      for (const project of body.projects ?? []) {
        if (project.project && project.cards) {
          actions.push({
            actor_id: participant.seat,
            type: "STATE_PROJECT",
            data: { project: String(project.project).toUpperCase(), cards: String(project.cards).toUpperCase() }
          });
        }
      }
      if (body.ikkah) actions.push({ actor_id: participant.seat, type: "IKKAH", data: {} });
      if (body.baloot) actions.push({ actor_id: participant.seat, type: "BALOOT", data: {} });
      actions.push({
        actor_id: participant.seat,
        type: "PLAY_CARD",
        data: { card: String(body.card || "").toUpperCase() }
      });
    } else {
      throw new Error("Unsupported action kind.");
    }

    this.currentTurn = null;
    this.engine.sendActions(participant.seat, actions);
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
        this.state.log.push(`Game ${action.data.game} started`);
        break;
      case "MIDDLE_CARD":
        this.state.middle = action.data.card;
        this.state.log.push(`Middle card ${action.data.card}`);
        break;
      case "BUY_CALL":
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
        this.state.trick.push({ player: action.actor_id, card: action.data.card, round: this.state.round });
        this.state.log.push(`R${this.state.round} P${action.actor_id} played ${action.data.card}`);
        break;
      }
      case "IKKAH":
      case "BALOOT":
        this.state.log.push(`P${action.actor_id} declared ${action.type}`);
        break;
      default:
        break;
    }
    if (this.state.log.length > 80) this.state.log = this.state.log.slice(-80);
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
    return {
      roomId: this.id,
      status: this.status,
      error: this.error,
      self: {
        role: participant?.role ?? "spectator",
        seat,
        hand: seat ? this.state.hands.get(seat) ?? [] : []
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
}
