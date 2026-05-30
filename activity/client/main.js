const qs = new URLSearchParams(location.search);
const els = {
  roomStatus: document.querySelector("#roomStatus"),
  selfBadge: document.querySelector("#selfBadge"),
  playerList: document.querySelector("#playerList"),
  spectatorList: document.querySelector("#spectatorList"),
  seats: {
    initiator: document.querySelector("#seatBottom"),
    nitwit: document.querySelector("#seatLeft"),
    cutter: document.querySelector("#seatTop"),
    dealer: document.querySelector("#seatRight")
  },
  scoreA: document.querySelector("#scoreA"),
  scoreB: document.querySelector("#scoreB"),
  contractLabel: document.querySelector("#contractLabel"),
  trickCards: document.querySelector("#trickCards"),
  turnLabel: document.querySelector("#turnLabel"),
  handStatus: document.querySelector("#handStatus"),
  handCards: document.querySelector("#handCards"),
  actionForm: document.querySelector("#actionForm"),
  buyControls: document.querySelector("#buyControls"),
  playControls: document.querySelector("#playControls"),
  buyCall: document.querySelector("#buyCall"),
  trumpSuit: document.querySelector("#trumpSuit"),
  ikkahFlag: document.querySelector("#ikkahFlag"),
  balootFlag: document.querySelector("#balootFlag"),
  projectKind: document.querySelector("#projectKind"),
  projectCards: document.querySelector("#projectCards"),
  submitAction: document.querySelector("#submitAction"),
  matchLog: document.querySelector("#matchLog")
};

let roomId = qs.get("room") || "local";
let user = null;
let session = "";
let eventSource = null;
let snapshot = null;
let selectedCard = "";
let discordSdk = null;
let apiPrefix = "";

function cardColor(card) {
  return card.endsWith("H") || card.endsWith("D") ? "red" : "black";
}

function cardHtml(card) {
  return `<button class="card ${cardColor(card)}" type="button" data-card="${escapeHtml(card)}" aria-label="${escapeHtml(card)}">${escapeHtml(card)}</button>`;
}

function setStatus(text) {
  els.roomStatus.textContent = text;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function apiPath(path) {
  return `${apiPrefix}${path}`;
}

async function fetchJson(paths, options) {
  const candidates = Array.isArray(paths) ? paths : [paths];
  let lastError = null;
  for (const path of candidates) {
    try {
      const response = await fetch(path, options);
      if (!response.ok) {
        lastError = new Error(`${path} returned ${response.status}`);
        continue;
      }
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Request failed");
}

async function authenticate() {
  const config = await fetchJson(["/api/config", "/.proxy/api/config"]);
  const mockMode = config.allowInsecureDev && (qs.get("mock") === "1" || !config.clientId);

  if (mockMode) {
    const name = qs.get("name") || `Player ${Math.floor(Math.random() * 1000)}`;
    user = { id: qs.get("userId") || name, name, avatar: "" };
    setStatus("Local mock mode");
    return;
  }

  if (!config.clientId) {
    throw new Error("Discord client id is missing and local mock mode is disabled.");
  }

  const { DiscordSDK } = await import("https://esm.sh/@discord/embedded-app-sdk@1?bundle");
  discordSdk = new DiscordSDK(config.clientId);
  await discordSdk.ready();
  roomId = discordSdk.instanceId || roomId;
  apiPrefix = config.proxyPrefix || "/.proxy";

  const { code } = await discordSdk.commands.authorize({
    client_id: config.clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"]
  });

  const token = await fetch(apiPath("/api/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, instanceId: roomId })
  }).then((response) => {
    if (!response.ok) throw new Error("Discord auth failed");
    return response.json();
  });

  await discordSdk.commands.authenticate({ access_token: token.access_token });
  user = token.user;
  session = token.session;
  setStatus("Discord Activity connected");
}

function connectEvents() {
  const params = new URLSearchParams({ room: roomId, name: user.name, userId: user.id });
  if (session) params.set("session", session);
  eventSource = new EventSource(`${apiPath("/api/events")}?${params}`);
  eventSource.addEventListener("snapshot", (event) => {
    snapshot = JSON.parse(event.data);
    render();
  });
  eventSource.onerror = () => setStatus("Reconnecting...");
}

function renderPeople(container, people, emptyText) {
  container.innerHTML = people.length
    ? people
        .map((person) => {
          const label = person.seat ? `P${person.seat}` : person.name.slice(0, 1).toUpperCase();
          return `<div class="avatar-chip"><span class="avatar-dot">${escapeHtml(label)}</span>${escapeHtml(person.name)}</div>`;
        })
        .join("")
    : `<span class="avatar-chip">${escapeHtml(emptyText)}</span>`;
}

function renderSeats() {
  const bySeat = new Map(snapshot.players.map((player) => [player.seat, player]));
  const roleBySeat = new Map([
    [snapshot.state.seats.initiator, "initiator"],
    [snapshot.state.seats.nitwit, "nitwit"],
    [snapshot.state.seats.cutter, "cutter"],
    [snapshot.state.seats.dealer, "dealer"]
  ]);
  const fallbackRoles = new Map([
    [1, "initiator"],
    [2, "nitwit"],
    [3, "cutter"],
    [4, "dealer"]
  ]);

  for (const [role, element] of Object.entries(els.seats)) {
    const seat =
      [...roleBySeat.entries()].find((entry) => entry[1] === role)?.[0] ??
      [...fallbackRoles.entries()].find((entry) => entry[1] === role)?.[0];
    const player = bySeat.get(seat);
    const isTurn = snapshot.currentTurn?.actorId === seat;
    element.classList.toggle("is-turn", isTurn);
    element.innerHTML = player
      ? `<div class="seat-name">P${seat} ${escapeHtml(player.name)}</div><div class="seat-role">${escapeHtml(role)}</div>`
      : `<div class="seat-name">Open seat</div><div class="seat-role">${escapeHtml(role)}</div>`;
  }
}

function renderControls() {
  const isPlayerTurn =
    snapshot.self.role === "player" && snapshot.currentTurn?.actorId === snapshot.self.seat;
  els.buyControls.classList.toggle("hidden", !(isPlayerTurn && snapshot.currentTurn.kind === "BUY_CALL"));
  els.playControls.classList.toggle("hidden", !(isPlayerTurn && snapshot.currentTurn.kind === "PLAY_CARD"));
  els.submitAction.disabled =
    !isPlayerTurn ||
    (snapshot.currentTurn.kind === "PLAY_CARD" && !selectedCard);

  if (snapshot.self.role !== "player") {
    els.handStatus.textContent = "You are spectating this Activity.";
  } else if (!snapshot.currentTurn) {
    els.handStatus.textContent = "Waiting for the engine.";
  } else if (isPlayerTurn) {
    els.handStatus.textContent =
      snapshot.currentTurn.kind === "BUY_CALL" ? "Your bid." : "Your play.";
  } else {
    els.handStatus.textContent = `Waiting for P${snapshot.currentTurn.actorId}.`;
  }
}

function render() {
  const statusText = {
    lobby: "Waiting for 4 players",
    starting: "Starting engine",
    playing: "Match in progress",
    ended: "Match ended",
    error: snapshot.error || "Activity error"
  }[snapshot.status] ?? snapshot.status;

  setStatus(`${statusText} - room ${snapshot.roomId}`);
  els.selfBadge.textContent = snapshot.self.role === "player"
    ? `Player ${snapshot.self.seat}`
    : "Spectator";
  renderPeople(els.playerList, snapshot.players, "No players yet");
  renderPeople(els.spectatorList, snapshot.spectators, "No spectators");
  renderSeats();

  els.scoreA.textContent = snapshot.state.scores.A;
  els.scoreB.textContent = snapshot.state.scores.B;
  els.contractLabel.textContent = snapshot.state.contract || (snapshot.state.middle ? `Middle ${snapshot.state.middle}` : "No contract yet");
  els.turnLabel.textContent = snapshot.currentTurn
    ? `P${snapshot.currentTurn.actorId}: ${snapshot.currentTurn.kind}`
    : "No pending turn";
  els.trickCards.innerHTML = snapshot.state.trick
    .map((play) => `<div class="card ${cardColor(play.card)}">P${play.player}<br>${escapeHtml(play.card)}</div>`)
    .join("");
  els.handCards.innerHTML = snapshot.self.hand.map(cardHtml).join("");
  for (const card of els.handCards.querySelectorAll(".card")) {
    card.classList.toggle("is-selected", card.dataset.card === selectedCard);
  }
  els.matchLog.innerHTML = snapshot.state.log.map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  renderControls();
}

els.handCards.addEventListener("click", (event) => {
  const card = event.target.closest("[data-card]");
  if (!card) return;
  selectedCard = card.dataset.card;
  render();
});

els.actionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!snapshot?.currentTurn) return;

  const body = {
    roomId,
    userId: user.id,
    name: user.name,
    session,
    kind: snapshot.currentTurn.kind
  };

  if (snapshot.currentTurn.kind === "BUY_CALL") {
    body.call = els.buyCall.value;
    body.trump = els.trumpSuit.value;
  } else {
    body.card = selectedCard;
    body.ikkah = els.ikkahFlag.checked;
    body.baloot = els.balootFlag.checked;
    if (els.projectKind.value && els.projectCards.value) {
      body.projects = [{ project: els.projectKind.value, cards: els.projectCards.value }];
    }
  }

  const response = await fetch(apiPath("/api/action"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Action failed" }));
    setStatus(error.error);
  }
  selectedCard = "";
});

authenticate()
  .then(connectEvents)
  .catch((error) => setStatus(error.message));
