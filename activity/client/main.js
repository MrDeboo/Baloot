const qs = new URLSearchParams(location.search);
const BUY_LABELS = {
  BAS: "Bas",
  SUN: "Sun",
  HUKUM: "Hukum",
  ASHKAL: "Ashkal",
  GABLAK_SUN: "Gablak Sun",
  GABLAK_ASHKAL: "Gablak Ashkal",
  BET_OPEN: "Bet Open",
  BET_CLOSE: "Bet Close",
  BET_DOUBLE: "Double",
  BET_TRIPLE: "Triple",
  BET_QUADRUPLE: "Quadruple",
  GAHWA: "Gahwa",
  ENFORCE_SUN: "Enforce Sun",
  ENFORCE_HUKUM: "Enforce Hukum"
};
const BUY_OPTIONS_BY_PHASE = {
  1: ["BAS", "HUKUM", "SUN", "ASHKAL"],
  2: ["BAS", "HUKUM", "SUN"],
  discussion: [
    "BAS",
    "GABLAK_SUN",
    "GABLAK_ASHKAL",
    "BET_OPEN",
    "BET_CLOSE",
    "BET_DOUBLE",
    "BET_TRIPLE",
    "BET_QUADRUPLE",
    "GAHWA"
  ],
  enforce: ["BAS", "ENFORCE_SUN", "ENFORCE_HUKUM"]
};

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
  const isTurn = snapshot?.self.role === "player" && snapshot.currentTurn?.actorId === snapshot.self.seat;
  const legalCards = new Set(snapshot?.self.legalCards ?? []);
  const enforceLegal = isTurn && snapshot.currentTurn?.kind === "PLAY_CARD" && legalCards.size > 0;
  const legal = !enforceLegal || legalCards.has(card);
  const stateClass = legal ? "" : " is-illegal";
  const disabled = legal ? "" : " disabled";
  return `<button class="card ${cardColor(card)}${stateClass}" type="button" data-card="${escapeHtml(card)}" aria-label="${escapeHtml(card)}"${disabled}>${escapeHtml(card)}</button>`;
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

function canCallAshkal() {
  const seat = snapshot?.self.seat;
  const seats = snapshot?.state.seats ?? {};
  if (!seat) return false;
  if (seats.cutter || seats.dealer) return seat === seats.cutter || seat === seats.dealer;
  return seat === 3 || seat === 4;
}

function middleSuit() {
  const middle = snapshot?.state.middle || "";
  return middle.slice(-1);
}

function setOptions(select, values, labels = BUY_LABELS) {
  const current = select.value;
  select.innerHTML = values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(labels[value] || value)}</option>`)
    .join("");
  select.value = values.includes(current) ? current : values[0] || "";
}

function allowedBuyOptions() {
  const phase = String(snapshot?.currentTurn?.phase || "1");
  const options = BUY_OPTIONS_BY_PHASE[phase] ?? BUY_OPTIONS_BY_PHASE.discussion;
  return options.filter((option) => !option.includes("ASHKAL") || canCallAshkal());
}

function syncBuyControls() {
  if (snapshot?.currentTurn?.kind !== "BUY_CALL") return;

  setOptions(els.buyCall, allowedBuyOptions());
  const call = els.buyCall.value;
  const phase = String(snapshot.currentTurn.phase || "1");
  const needsTrump = call === "HUKUM" && phase === "2";
  const canChooseTrump = needsTrump || call === "ENFORCE_HUKUM";
  const suits = ["C", "D", "H", "S"].filter((suit) => !(needsTrump && suit === middleSuit()));
  const currentTrump = els.trumpSuit.value;

  els.trumpSuit.disabled = !canChooseTrump;
  els.trumpSuit.innerHTML = [
    `<option value="">${needsTrump ? "Choose trump" : "No trump"}</option>`,
    ...suits.map((suit) => `<option value="${suit}">${{ C: "Clubs", D: "Diamonds", H: "Hearts", S: "Spades" }[suit]}</option>`)
  ].join("");
  els.trumpSuit.value = canChooseTrump && (currentTrump === "" || suits.includes(currentTrump)) ? currentTrump : "";
}

function renderControls() {
  const isPlayerTurn =
    snapshot.self.role === "player" && snapshot.currentTurn?.actorId === snapshot.self.seat;
  els.buyControls.classList.toggle("hidden", !(isPlayerTurn && snapshot.currentTurn.kind === "BUY_CALL"));
  els.playControls.classList.toggle("hidden", !(isPlayerTurn && snapshot.currentTurn.kind === "PLAY_CARD"));
  if (isPlayerTurn && snapshot.currentTurn.kind === "BUY_CALL") syncBuyControls();

  const declarations = snapshot.self.declarations ?? { ikkahCards: [], balootCards: [] };
  const isPlayTurn = isPlayerTurn && snapshot.currentTurn.kind === "PLAY_CARD";
  const ikkahAllowed = isPlayTurn && selectedCard && declarations.ikkahCards?.includes(selectedCard);
  const balootAllowed = isPlayTurn && selectedCard && declarations.balootCards?.includes(selectedCard);
  els.ikkahFlag.disabled = !ikkahAllowed;
  els.balootFlag.disabled = !balootAllowed;
  if (!ikkahAllowed) els.ikkahFlag.checked = false;
  if (!balootAllowed) els.balootFlag.checked = false;
  els.ikkahFlag.closest("label")?.classList.toggle("is-disabled", !ikkahAllowed);
  els.balootFlag.closest("label")?.classList.toggle("is-disabled", !balootAllowed);

  const requiresTrump =
    isPlayerTurn &&
    snapshot.currentTurn.kind === "BUY_CALL" &&
    els.buyCall.value === "HUKUM" &&
    String(snapshot.currentTurn.phase || "1") === "2";
  els.submitAction.disabled =
    !isPlayerTurn ||
    (snapshot.currentTurn.kind === "BUY_CALL" && (!els.buyCall.value || (requiresTrump && !els.trumpSuit.value))) ||
    (snapshot.currentTurn.kind === "PLAY_CARD" &&
      (!selectedCard ||
        (snapshot.self.legalCards?.length > 0 && !snapshot.self.legalCards.includes(selectedCard))));

  if (snapshot.self.role !== "player") {
    els.handStatus.textContent = "You are spectating this Activity.";
  } else if (!snapshot.currentTurn) {
    els.handStatus.textContent = "Waiting for the engine.";
  } else if (isPlayerTurn) {
    els.handStatus.textContent = snapshot.currentTurn.kind === "BUY_CALL"
      ? "Your bid."
      : `Your play${snapshot.self.legalCards?.length ? ` - ${snapshot.self.legalCards.length} legal` : ""}.`;
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
  if (
    selectedCard &&
    (!snapshot.self.hand.includes(selectedCard) ||
      (snapshot.self.legalCards?.length > 0 && !snapshot.self.legalCards.includes(selectedCard)))
  ) {
    selectedCard = "";
  }

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
  if (!card || card.disabled) return;
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
    body.ikkah = els.ikkahFlag.checked && !els.ikkahFlag.disabled;
    body.baloot = els.balootFlag.checked && !els.balootFlag.disabled;
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
  } else {
    setStatus("Action sent");
  }
  selectedCard = "";
  els.ikkahFlag.checked = false;
  els.balootFlag.checked = false;
  els.projectKind.value = "";
  els.projectCards.value = "";
});

els.buyCall.addEventListener("change", renderControls);
els.trumpSuit.addEventListener("change", renderControls);

authenticate()
  .then(connectEvents)
  .catch((error) => setStatus(error.message));
