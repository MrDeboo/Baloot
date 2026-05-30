const SAMPLE_LOG = `match 1
new game 1 seats 1,2,3,4
middle card 10C
player 1 bought SUN
round 1 player 1 played 10D
round 1 player 2 played 7D
round 1 player 3 played KD
round 1 player 4 played QD
round 1 winner 1 points 17
round 2 player 1 played 9C
round 2 player 2 played QC
round 2 player 3 played AC
round 2 player 4 played JC
round 2 winner 3 points 16
round 3 player 3 played 8H
round 3 player 4 played 10H
round 3 player 1 played 7H
round 3 player 2 played AH
round 3 winner 2 points 21
round 4 player 2 played JS
round 4 player 3 played KS
round 4 player 4 played AS
round 4 player 1 played 7C
round 4 winner 4 points 17
round 5 player 4 played AD
round 5 player 1 played JD
round 5 player 2 played 8D
round 5 player 3 played 7S
round 5 winner 4 points 13
round 6 player 4 played 8C
round 6 player 1 played 10C
round 6 player 2 played KC
round 6 player 3 played KH
round 6 winner 1 points 18
round 7 player 1 played 9H
round 7 player 2 played JH
round 7 player 3 played QS
round 7 player 4 played 9D
round 7 winner 2 points 5
round 8 player 2 played 8S
round 8 player 3 played 10S
round 8 player 4 played 9S
round 8 player 1 played QH
round 8 winner 3 points 23
game 1 score A=14 B=12 total A=14 B=12
new game 2 seats 2,3,4,1
middle card 8S
player 1 bought SUN
round 1 player 2 played AC
round 1 player 3 played KC
round 1 player 4 played 10C
round 1 player 1 played 9C
round 1 winner 2 points 25
round 2 player 2 played 10D
round 2 player 3 played 9D
round 2 player 4 played 8D
round 2 player 1 played QD
round 2 winner 2 points 13
round 3 player 2 played JH
round 3 player 3 played AH
round 3 player 4 played AD
round 3 player 1 played 7H
round 3 winner 3 points 24
round 4 player 3 played 7S
round 4 player 4 played QS
round 4 player 1 played 8S
round 4 player 2 played AS
round 4 winner 2 points 14
round 5 player 2 played 7C
round 5 player 3 played 8C
round 5 player 4 played JC
round 5 player 1 played QC
round 5 winner 1 points 5
round 6 player 1 played 8H
round 6 player 2 played KS
round 6 player 3 played QH
round 6 player 4 played JS
round 6 winner 3 points 9
round 7 player 3 played 10H
round 7 player 4 played 9S
round 7 player 1 played KH
round 7 player 2 played KD
round 7 winner 3 points 18
round 8 player 3 played 9H
round 8 player 4 played 7D
round 8 player 1 played JD
round 8 player 2 played 10S
round 8 winner 3 points 22
game 2 score A=16 B=10 total A=30 B=22
MATCH_END A=30 B=22 winner=A`;

const SUIT_SYMBOLS = {
  S: "♠",
  H: "♥",
  D: "♦",
  C: "♣"
};

const els = {
  logInput: document.querySelector("#logInput"),
  loadLog: document.querySelector("#loadLog"),
  loadSample: document.querySelector("#loadSample"),
  clearLog: document.querySelector("#clearLog"),
  fileInput: document.querySelector("#fileInput"),
  parseStatus: document.querySelector("#parseStatus"),
  matchSubtitle: document.querySelector("#matchSubtitle"),
  scoreA: document.querySelector("#scoreA"),
  scoreB: document.querySelector("#scoreB"),
  stepCounter: document.querySelector("#stepCounter"),
  eventTitle: document.querySelector("#eventTitle"),
  eventDetail: document.querySelector("#eventDetail"),
  gameLabel: document.querySelector("#gameLabel"),
  contractLabel: document.querySelector("#contractLabel"),
  middleLabel: document.querySelector("#middleLabel"),
  roundLabel: document.querySelector("#roundLabel"),
  trickCards: document.querySelector("#trickCards"),
  seats: {
    top: document.querySelector("#seatTop"),
    right: document.querySelector("#seatRight"),
    bottom: document.querySelector("#seatBottom"),
    left: document.querySelector("#seatLeft")
  },
  firstStep: document.querySelector("#firstStep"),
  prevStep: document.querySelector("#prevStep"),
  playPause: document.querySelector("#playPause"),
  nextStep: document.querySelector("#nextStep"),
  lastStep: document.querySelector("#lastStep"),
  stepRange: document.querySelector("#stepRange"),
  speedSelect: document.querySelector("#speedSelect"),
  gameNav: document.querySelector("#gameNav"),
  scoreTimeline: document.querySelector("#scoreTimeline"),
  eventList: document.querySelector("#eventList"),
  summaryStats: document.querySelector("#summaryStats")
};

let replay = null;
let stepIndex = 0;
let playTimer = null;

function parseReplay(raw) {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = {
    games: [],
    events: [],
    final: null,
    teamMap: new Map(),
    warnings: []
  };

  let currentGame = null;
  let currentRound = null;

  const addEvent = (type, title, detail, extra = {}) => {
    parsed.events.push({
      index: parsed.events.length,
      type,
      title,
      detail,
      gameIndex: currentGame ? currentGame.index : null,
      roundIndex: currentRound ? currentRound.index : null,
      ...extra
    });
  };

  const ensureRound = (roundNumber) => {
    if (!currentGame) return null;
    let round = currentGame.rounds.find((item) => item.number === roundNumber);
    if (!round) {
      round = {
        index: currentGame.rounds.length,
        number: roundNumber,
        plays: [],
        winner: null,
        points: null
      };
      currentGame.rounds.push(round);
    }
    currentRound = round;
    return round;
  };

  for (const line of lines) {
    let match = line.match(/^match\s+(\d+)$/i);
    if (match) {
      parsed.matchNumber = Number(match[1]);
      addEvent("match", `Match ${match[1]}`, "Server replay");
      continue;
    }

    match = line.match(/^new game\s+(\d+)\s+seats\s+([0-9,\s]+)$/i);
    if (match) {
      const seats = match[2].split(",").map((value) => Number(value.trim()));
      currentGame = {
        index: parsed.games.length,
        number: Number(match[1]),
        seats,
        middle: null,
        bids: [],
        contract: null,
        rounds: [],
        score: null,
        rawLines: [line]
      };
      currentRound = null;
      parsed.games.push(currentGame);
      if (parsed.teamMap.size === 0 && seats.length === 4) {
        parsed.teamMap.set(seats[0], "A");
        parsed.teamMap.set(seats[2], "A");
        parsed.teamMap.set(seats[1], "B");
        parsed.teamMap.set(seats[3], "B");
      }
      addEvent("game", `Game ${currentGame.number}`, `Seats ${seats.join(", ")}`);
      continue;
    }

    match = line.match(/^middle card\s+([A-Z0-9]+)$/i);
    if (match && currentGame) {
      currentGame.middle = parseCard(match[1]);
      addEvent("middle", `Middle ${match[1].toUpperCase()}`, `Game ${currentGame.number}`);
      continue;
    }

    match = line.match(/^player\s+(\d+)\s+bought\s+([A-Z_]+)$/i);
    if (match && currentGame) {
      const bid = { player: Number(match[1]), kind: match[2].toUpperCase(), mode: "bought" };
      currentGame.bids.push(bid);
      currentGame.contract = bid;
      addEvent("bid", `P${bid.player} bought ${bid.kind}`, teamDetail(bid.player, parsed));
      continue;
    }

    match = line.match(/^player\s+(\d+)\s+gablak\s+([A-Z_]+)$/i);
    if (match && currentGame) {
      const bid = { player: Number(match[1]), kind: match[2].toUpperCase(), mode: "gablak" };
      currentGame.bids.push(bid);
      currentGame.contract = bid;
      addEvent("bid", `P${bid.player} gablak ${bid.kind}`, teamDetail(bid.player, parsed));
      continue;
    }

    match = line.match(/^player\s+(\d+)\s+bet\s+([A-Z_]+)$/i);
    if (match && currentGame) {
      const bid = { player: Number(match[1]), kind: match[2].toUpperCase(), mode: "bet" };
      currentGame.bids.push(bid);
      currentGame.contract = bid;
      addEvent("bid", `P${bid.player} bet ${bid.kind}`, teamDetail(bid.player, parsed));
      continue;
    }

    match = line.match(/^player\s+(\d+)\s+enforced\s+HUKUM\s+to\s+SUN$/i);
    if (match && currentGame) {
      const bid = { player: Number(match[1]), kind: "ENFORCE_SUN", mode: "enforce" };
      currentGame.bids.push(bid);
      currentGame.contract = bid;
      addEvent("bid", `P${bid.player} enforced SUN`, teamDetail(bid.player, parsed));
      continue;
    }

    match = line.match(/^round\s+(\d+)\s+player\s+(\d+)\s+played\s+([A-Z0-9]+)$/i);
    if (match && currentGame) {
      const round = ensureRound(Number(match[1]));
      if (!round) continue;
      const play = {
        index: round.plays.length,
        player: Number(match[2]),
        card: parseCard(match[3])
      };
      round.plays.push(play);
      addEvent(
        "play",
        `R${round.number} P${play.player} played ${play.card.code}`,
        teamDetail(play.player, parsed),
        { playIndex: play.index }
      );
      continue;
    }

    match = line.match(/^round\s+(\d+)\s+winner\s+(\d+)\s+points\s+(\d+)$/i);
    if (match && currentGame) {
      const round = ensureRound(Number(match[1]));
      if (!round) continue;
      round.winner = Number(match[2]);
      round.points = Number(match[3]);
      addEvent(
        "winner",
        `R${round.number} P${round.winner} won`,
        `${round.points} points for Team ${teamOf(round.winner, parsed)}`
      );
      continue;
    }

    match = line.match(
      /^game\s+(\d+)\s+score\s+A=(\d+)\s+B=(\d+)\s+total\s+A=(\d+)\s+B=(\d+)$/i
    );
    if (match && currentGame) {
      currentRound = null;
      currentGame.score = {
        a: Number(match[2]),
        b: Number(match[3]),
        totalA: Number(match[4]),
        totalB: Number(match[5])
      };
      addEvent(
        "score",
        `Game ${match[1]} scored`,
        `+${match[2]} / +${match[3]} -> ${match[4]} / ${match[5]}`,
        { score: currentGame.score }
      );
      continue;
    }

    match = line.match(/^MATCH_END(?:\s+self=\d+)?\s+A=(\d+)\s+B=(\d+)\s+winner=([A-Z]+)$/i);
    if (match) {
      currentRound = null;
      parsed.final = {
        a: Number(match[1]),
        b: Number(match[2]),
        winner: match[3].toUpperCase()
      };
      addEvent("final", `Winner Team ${parsed.final.winner}`, `${parsed.final.a} / ${parsed.final.b}`);
      continue;
    }

    match = line.match(/^final\s+A=(\d+)\s+B=(\d+)\s+winner=([A-Z]+)(?:\s+games=(\d+))?$/i);
    if (match) {
      currentRound = null;
      parsed.final = {
        a: Number(match[1]),
        b: Number(match[2]),
        winner: match[3].toUpperCase(),
        games: match[4] ? Number(match[4]) : parsed.games.length
      };
      addEvent("final", `Winner Team ${parsed.final.winner}`, `${parsed.final.a} / ${parsed.final.b}`);
      continue;
    }

    match = line.match(/^gaid\s+(.+)$/i);
    if (match) {
      currentRound = null;
      addEvent("gaid", "Gaid", match[1]);
      continue;
    }

    if (currentGame) currentGame.rawLines.push(line);
  }

  let totalA = 0;
  let totalB = 0;
  for (const event of parsed.events) {
    if (event.type === "score" && event.score) {
      totalA = event.score.totalA;
      totalB = event.score.totalB;
    }
    if (event.type === "final" && parsed.final) {
      totalA = parsed.final.a;
      totalB = parsed.final.b;
    }
    event.totalA = totalA;
    event.totalB = totalB;
  }

  if (parsed.games.length === 0) {
    throw new Error("No Baloot games were found in this log.");
  }
  if (parsed.events.length === 0) {
    throw new Error("No replay events were found in this log.");
  }
  return parsed;
}

function parseCard(code) {
  const normalized = String(code).toUpperCase();
  const suit = normalized.slice(-1);
  const rank = normalized.slice(0, -1);
  return {
    code: normalized,
    rank,
    suit,
    color: suit === "H" || suit === "D" ? "red" : "black"
  };
}

function teamOf(playerId, parsed = replay) {
  if (parsed?.teamMap?.has(playerId)) return parsed.teamMap.get(playerId);
  return playerId % 2 === 1 ? "A" : "B";
}

function teamDetail(playerId, parsed = replay) {
  return `Team ${teamOf(playerId, parsed)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function suitSymbol(suit) {
  return SUIT_SYMBOLS[suit] ?? suit;
}

function cardMarkup(card, small = false) {
  if (!card) {
    return `<div class="card card-ghost ${small ? "card-small" : ""}">--</div>`;
  }
  const colorClass = card.color === "red" ? "card-red" : "";
  const sizeClass = small ? "card-small" : "";
  return `<div class="card ${colorClass} ${sizeClass}" aria-label="${escapeHtml(card.code)}">
    <span class="card-rank">${escapeHtml(card.rank)}</span>
    <span class="card-suit">${escapeHtml(suitSymbol(card.suit))}</span>
    <span class="card-foot">${escapeHtml(card.rank)}</span>
  </div>`;
}

function currentEvent() {
  return replay?.events[stepIndex] ?? null;
}

function currentGameFor(event) {
  if (!replay || !event) return null;
  if (event.gameIndex !== null && replay.games[event.gameIndex]) {
    return replay.games[event.gameIndex];
  }
  return replay.games[0] ?? null;
}

function currentRoundFor(game, event) {
  if (!game || !event) return null;
  if (event.roundIndex !== null && game.rounds[event.roundIndex]) {
    return game.rounds[event.roundIndex];
  }
  if (event.type === "score") return game.rounds.at(-1) ?? null;
  return null;
}

function visiblePlays(round, event) {
  if (!round || !event) return [];
  if (event.type === "play" && Number.isInteger(event.playIndex)) {
    return round.plays.slice(0, event.playIndex + 1);
  }
  return round.plays;
}

function seatPositionsFor(game) {
  const seats = game?.seats?.length === 4 ? game.seats : [1, 2, 3, 4];
  return {
    bottom: seats[0],
    left: seats[1],
    top: seats[2],
    right: seats[3]
  };
}

function contractText(game) {
  if (!game?.contract) return "No contract";
  const prefix = game.contract.mode === "bought" ? "P" : `${game.contract.mode.toUpperCase()} P`;
  return `${prefix}${game.contract.player} ${game.contract.kind}`;
}

function render() {
  const event = currentEvent();
  const game = currentGameFor(event);
  const round = currentRoundFor(game, event);
  const plays = visiblePlays(round, event);

  if (!replay || !event || !game) {
    renderEmpty();
    return;
  }

  els.scoreA.textContent = event.totalA;
  els.scoreB.textContent = event.totalB;
  els.stepCounter.textContent = `Step ${stepIndex + 1} / ${replay.events.length}`;
  els.eventTitle.textContent = event.title;
  els.eventDetail.textContent = event.detail;
  els.gameLabel.textContent = `Game ${game.number}`;
  els.contractLabel.textContent = contractText(game);
  els.middleLabel.textContent = `Middle ${game.middle?.code ?? "-"}`;
  els.roundLabel.textContent = round ? `Round ${round.number}` : "Round -";
  els.matchSubtitle.textContent = summaryLine(replay);
  els.stepRange.max = String(Math.max(replay.events.length - 1, 0));
  els.stepRange.value = String(stepIndex);
  els.summaryStats.textContent = `${replay.events.length} events`;
  els.parseStatus.textContent = `${replay.games.length} games`;

  renderSeats(game, event, round, plays);
  renderTrick(plays, round);
  renderGameNav(game);
  renderScoreTimeline(game);
  renderEventList();
}

function renderEmpty() {
  els.scoreA.textContent = "0";
  els.scoreB.textContent = "0";
  els.stepCounter.textContent = "Step 0 / 0";
  els.eventTitle.textContent = "No replay loaded";
  els.eventDetail.textContent = "Load a log to begin";
  els.gameLabel.textContent = "Game -";
  els.contractLabel.textContent = "No contract";
  els.middleLabel.textContent = "Middle -";
  els.roundLabel.textContent = "Round -";
  els.trickCards.innerHTML = "";
  for (const element of Object.values(els.seats)) {
    element.innerHTML = "";
    element.className = element.className.replace(/\sis-\w+/g, "");
  }
  els.gameNav.innerHTML = "";
  els.scoreTimeline.innerHTML = "";
  els.eventList.innerHTML = `<div class="empty-state">No replay loaded</div>`;
}

function renderSeats(game, event, round, plays) {
  const positions = seatPositionsFor(game);
  const playedBy = new Map(plays.map((play) => [play.player, play.card]));
  const activePlayer = event.type === "play" ? event.player ?? round?.plays[event.playIndex]?.player : null;
  const winner = event.type === "winner" ? round?.winner : null;

  for (const [position, playerId] of Object.entries(positions)) {
    const team = teamOf(playerId);
    const element = els.seats[position];
    element.classList.toggle("is-active", playerId === activePlayer);
    element.classList.toggle("is-winner", playerId === winner);
    element.innerHTML = `
      <div class="seat-header">
        <span class="player-name">Player ${playerId}</span>
        <span class="team-badge team-${team.toLowerCase()}-badge">Team ${team}</span>
      </div>
      <div class="seat-meta">${seatMeta(position, game, playerId, event)}</div>
      <div class="seat-card-slot">${cardMarkup(playedBy.get(playerId), true)}</div>
    `;
  }
}

function seatMeta(position, game, playerId, event) {
  const roleMap = {
    bottom: "Initiator",
    left: "Nitwit",
    top: "Cutter",
    right: "Dealer"
  };
  const parts = [roleMap[position]];
  if (game.contract?.player === playerId) parts.push("contract");
  if (event.type === "play" && event.title.includes(`P${playerId} `)) parts.push("active");
  return parts.join(" / ");
}

function renderTrick(plays, round) {
  if (!round) {
    els.trickCards.innerHTML = `<div class="empty-state">Game setup</div>`;
    return;
  }
  const slots = [...plays];
  while (slots.length < 4) slots.push(null);
  els.trickCards.innerHTML = slots
    .map((play) => {
      if (!play) {
        return `<div class="played-stack">${cardMarkup(null)}<span>Waiting</span></div>`;
      }
      return `<div class="played-stack">${cardMarkup(play.card)}<span>P${play.player}</span></div>`;
    })
    .join("");
}

function renderGameNav(game) {
  els.gameNav.innerHTML = replay.games
    .map((item) => {
      const current = item.index === game.index ? " is-current" : "";
      return `<button class="game-chip${current}" type="button" data-game-index="${item.index}">G${item.number}</button>`;
    })
    .join("");
}

function renderScoreTimeline(currentGame) {
  const scoredGames = replay.games.filter((game) => game.score);
  if (scoredGames.length === 0) {
    els.scoreTimeline.innerHTML = "";
    return;
  }
  els.scoreTimeline.innerHTML = scoredGames
    .map((game) => {
      const total = Math.max(game.score.totalA + game.score.totalB, 1);
      const a = Math.max(game.score.totalA / total, 0.04);
      const b = Math.max(game.score.totalB / total, 0.04);
      const current = game.index === currentGame.index ? " current-score-row" : "";
      return `<div class="score-row${current}">
        <span>G${game.number}</span>
        <div class="score-bars" style="--a:${a}fr;--b:${b}fr"><span></span><span></span></div>
        <span>${game.score.totalA}/${game.score.totalB}</span>
      </div>`;
    })
    .join("");
}

function renderEventList() {
  const start = Math.max(0, stepIndex - 45);
  const end = Math.min(replay.events.length, start + 95);
  els.eventList.innerHTML = replay.events
    .slice(start, end)
    .map((event) => {
      const current = event.index === stepIndex ? " is-current" : "";
      return `<button class="event-item${current}" type="button" data-step="${event.index}">
        <span class="event-index">#${event.index + 1}</span>
        <span class="event-copy">
          <strong>${escapeHtml(event.title)}</strong>
          <span>${escapeHtml(event.detail)}</span>
        </span>
      </button>`;
    })
    .join("");
}

function summaryLine(parsed) {
  const tricks = parsed.games.reduce((sum, game) => sum + game.rounds.length, 0);
  const final = parsed.final ? ` / Winner Team ${parsed.final.winner}` : "";
  return `${parsed.games.length} games / ${tricks} tricks${final}`;
}

function loadReplayFromText(text) {
  stopPlayback();
  try {
    replay = parseReplay(text);
    stepIndex = 0;
    els.parseStatus.textContent = `${replay.games.length} games`;
    render();
  } catch (error) {
    replay = null;
    stepIndex = 0;
    els.parseStatus.textContent = "Error";
    els.eventTitle.textContent = "Could not parse log";
    els.eventDetail.textContent = error.message;
    renderEmpty();
  }
}

function goToStep(nextStep) {
  if (!replay) return;
  stepIndex = Math.min(Math.max(nextStep, 0), replay.events.length - 1);
  render();
}

function firstEventForGame(gameIndex) {
  return replay.events.find((event) => event.gameIndex === gameIndex)?.index ?? 0;
}

function startPlayback() {
  if (!replay || playTimer) return;
  els.playPause.textContent = "Pause";
  const tick = () => {
    if (!replay || stepIndex >= replay.events.length - 1) {
      stopPlayback();
      return;
    }
    goToStep(stepIndex + 1);
    playTimer = window.setTimeout(tick, Number(els.speedSelect.value));
  };
  playTimer = window.setTimeout(tick, Number(els.speedSelect.value));
}

function stopPlayback() {
  if (playTimer) {
    window.clearTimeout(playTimer);
    playTimer = null;
  }
  els.playPause.textContent = "Play";
}

els.loadLog.addEventListener("click", () => loadReplayFromText(els.logInput.value));

els.loadSample.addEventListener("click", () => {
  els.logInput.value = SAMPLE_LOG;
  loadReplayFromText(SAMPLE_LOG);
});

els.clearLog.addEventListener("click", () => {
  stopPlayback();
  els.logInput.value = "";
  replay = null;
  stepIndex = 0;
  els.parseStatus.textContent = "Ready";
  renderEmpty();
});

els.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  els.logInput.value = text;
  loadReplayFromText(text);
  event.target.value = "";
});

els.firstStep.addEventListener("click", () => goToStep(0));
els.prevStep.addEventListener("click", () => goToStep(stepIndex - 1));
els.nextStep.addEventListener("click", () => goToStep(stepIndex + 1));
els.lastStep.addEventListener("click", () => replay && goToStep(replay.events.length - 1));

els.playPause.addEventListener("click", () => {
  if (playTimer) {
    stopPlayback();
  } else {
    startPlayback();
  }
});

els.stepRange.addEventListener("input", () => goToStep(Number(els.stepRange.value)));
els.speedSelect.addEventListener("change", () => {
  if (playTimer) {
    stopPlayback();
    startPlayback();
  }
});

els.gameNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-game-index]");
  if (!button || !replay) return;
  goToStep(firstEventForGame(Number(button.dataset.gameIndex)));
});

els.eventList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-step]");
  if (!button) return;
  goToStep(Number(button.dataset.step));
});

window.addEventListener("keydown", (event) => {
  if (event.target === els.logInput) return;
  if (event.key === "ArrowLeft") goToStep(stepIndex - 1);
  if (event.key === "ArrowRight") goToStep(stepIndex + 1);
  if (event.key === " ") {
    event.preventDefault();
    playTimer ? stopPlayback() : startPlayback();
  }
});

els.logInput.value = SAMPLE_LOG;
loadReplayFromText(SAMPLE_LOG);
