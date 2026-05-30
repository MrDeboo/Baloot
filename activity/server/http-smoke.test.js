import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const engineBin =
  process.env.BALOOT_SERVER_BIN ||
  [
    path.join(repoRoot, "build/baloot-server"),
    path.join(repoRoot, "build/Release/baloot-server.exe"),
    path.join(repoRoot, "build/baloot-server.exe")
  ].find((candidate) => fs.existsSync(candidate));

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

function waitFor(assertion, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastError = null;
    const tick = () => {
      try {
        const value = assertion();
        if (value) {
          resolve(value);
          return;
        }
      } catch (error) {
        lastError = error;
      }
      if (Date.now() - started > timeoutMs) {
        reject(lastError ?? new Error("Timed out waiting for Activity state."));
      } else {
        setTimeout(tick, 25);
      }
    };
    tick();
  });
}

async function waitForHealth(baseUrl, server, logs) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Activity server exited early.\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server may still be binding.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Activity server health check.\n${logs()}`);
}

function startActivityServer(port) {
  const stdout = [];
  const stderr = [];
  const server = spawn(process.execPath, ["activity/server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACTIVITY_PORT: String(port),
      ACTIVITY_HOST: "127.0.0.1",
      ACTIVITY_ALLOW_INSECURE_DEV: "1",
      BALOOT_SERVER_BIN: engineBin,
      BALOOT_TARGET_SCORE: "1",
      BALOOT_READ_TIMEOUT_MS: "900000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => stdout.push(chunk));
  server.stderr.on("data", (chunk) => stderr.push(chunk));
  return {
    server,
    logs: () => `stdout:\n${stdout.join("")}\nstderr:\n${stderr.join("")}`
  };
}

function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => server.kill("SIGKILL"), 1000);
    server.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    server.kill();
  });
}

async function connectSse(baseUrl, params) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events?${new URLSearchParams(params)}`, {
    signal: controller.signal
  });
  assert.equal(response.status, 200);

  const client = new EventEmitter();
  client.snapshots = [];
  client.error = null;
  client.latest = () => client.snapshots.at(-1);
  client.close = () => controller.abort();
  client.on("error", () => {});

  let buffer = "";
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  client.done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split("\n");
          const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const data = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (event === "snapshot" && data) {
            const snapshot = JSON.parse(data);
            client.snapshots.push(snapshot);
            client.emit("snapshot", snapshot);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        client.error = error;
        client.emit("error", error);
      }
    }
  })();

  await waitFor(() => {
    if (client.error) throw client.error;
    return client.latest();
  });
  return client;
}

function actionRequest(baseUrl, body) {
  return fetch(`${baseUrl}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function postAction(baseUrl, body) {
  const response = await actionRequest(baseUrl, body);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Action failed ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function driveMatchOverHttp(baseUrl, roomId, clients) {
  let submitted = 0;
  let lastTurnKey = "";
  const turnKeyFor = (snapshot) =>
    JSON.stringify([
      snapshot.currentTurn?.kind,
      snapshot.currentTurn?.actorId,
      snapshot.currentTurn?.phase ?? "",
      snapshot.currentTurn?.round ?? "",
      snapshot.state?.log?.length ?? 0,
      snapshot.state?.trick?.length ?? 0,
      snapshot.state?.scores?.A ?? 0,
      snapshot.state?.scores?.B ?? 0
    ]);

  while (true) {
    const result = await waitFor(() => {
      for (const client of clients) {
        if (client.error) throw client.error;
      }
      const snapshot = clients[0].latest();
      if (!snapshot) return null;
      if (snapshot.status === "error") throw new Error(snapshot.error || "Activity entered error state.");
      if (snapshot.status === "ended") return { ended: true, state: snapshot };
      if (snapshot.currentTurn) {
        const turnKey = turnKeyFor(snapshot);
        if (turnKey !== lastTurnKey) return { turn: snapshot.currentTurn, turnKey };
      }
      return null;
    }, 30000);

    if (result.ended) return { submitted, final: result.state };

    const { turn } = result;
    const { snapshot } = await waitFor(() => {
      const player = clients.find((client) => client.latest()?.self.seat === turn.actorId);
      const playerSnapshot = player?.latest();
      if (
        playerSnapshot?.currentTurn?.actorId === turn.actorId &&
        playerSnapshot?.currentTurn?.kind === turn.kind
      ) {
        return { snapshot: playerSnapshot };
      }
      return null;
    });
    if (!snapshot) throw new Error(`No player snapshot for seat ${turn.actorId}.`);

    const userId = `player-${turn.actorId}`;
    const body = { roomId, userId, name: `Player ${turn.actorId}`, kind: turn.kind };

    if (turn.kind === "BUY_CALL") {
      body.call = turn.phase === "1" || turn.phase === "2" ? "SUN" : "BAS";
      await postAction(baseUrl, body);
      lastTurnKey = result.turnKey;
      submitted += 1;
      continue;
    }

    if (turn.kind === "PLAY_CARD") {
      const card = snapshot.self.legalCards[0] ?? snapshot.self.hand[0];
      if (!card) throw new Error(`Seat ${turn.actorId} has no card to play.`);
      body.card = card;
      await postAction(baseUrl, body);
      lastTurnKey = result.turnKey;
      submitted += 1;
      continue;
    }

    throw new Error(`Unsupported Activity turn kind ${turn.kind}.`);
  }
}

test("HTTP Activity flow starts with four players, keeps extras spectating, and completes a match", { skip: !engineBin }, async () => {
  const roomId = `http-smoke-${Date.now()}`;
  const port = await reservePort();
  const { server, logs } = startActivityServer(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients = [];

  try {
    await waitForHealth(baseUrl, server, logs);

    const p1 = await connectSse(baseUrl, { room: roomId, userId: "player-1", name: "Player 1" });
    const p2 = await connectSse(baseUrl, { room: roomId, userId: "player-2", name: "Player 2" });
    const p3 = await connectSse(baseUrl, { room: roomId, userId: "player-3", name: "Player 3" });
    clients.push(p1, p2, p3);

    await waitFor(() =>
      [p1, p2, p3].every((client) => client.latest()?.status === "lobby" && client.latest()?.players.length === 3)
    );

    const p4 = await connectSse(baseUrl, { room: roomId, userId: "player-4", name: "Player 4" });
    const spectator = await connectSse(baseUrl, { room: roomId, userId: "spectator-1", name: "Spectator 1" });
    clients.push(p4, spectator);

    await waitFor(() =>
      [p1, p2, p3, p4].every((client) => client.latest()?.self.hand.length === 5) &&
      p1.latest()?.status === "playing" &&
      p1.latest()?.currentTurn?.actorId === 1
    );

    assert.equal(spectator.latest().self.role, "spectator");
    assert.equal(spectator.latest().self.seat, null);
    assert.deepEqual(spectator.latest().self.hand, []);
    assert.equal(spectator.latest().players.length, 4);
    assert.equal(spectator.latest().spectators.length, 1);

    const spectatorAction = await actionRequest(baseUrl, {
      roomId,
      userId: "spectator-1",
      name: "Spectator 1",
      kind: "BUY_CALL",
      call: "BAS"
    });
    assert.equal(spectatorAction.status, 400);
    assert.match(await spectatorAction.text(), /Only seated players/);

    const wrongTurnAction = await actionRequest(baseUrl, {
      roomId,
      userId: "player-2",
      name: "Player 2",
      kind: "BUY_CALL",
      call: "BAS"
    });
    assert.equal(wrongTurnAction.status, 400);
    assert.match(await wrongTurnAction.text(), /not your turn/i);

    const result = await driveMatchOverHttp(baseUrl, roomId, [p1, p2, p3, p4]);
    assert.equal(result.final.status, "ended");
    assert.match(result.final.state.log.at(-1), /Match ended/);
    assert.ok(result.final.state.scores.A >= 1 || result.final.state.scores.B >= 1);
    assert.ok(result.submitted >= 8);
  } finally {
    for (const client of clients) client.close();
    await Promise.allSettled(clients.map((client) => client.done));
    await stopServer(server);
  }
});
