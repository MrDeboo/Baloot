const PHASE = {
  WAITING_FOR_GAME: "waiting_for_game",
  WAITING_FOR_MIDDLE: "waiting_for_middle",
  BIDDING: "bidding",
  DISCUSSION: "discussion",
  WAITING_FOR_DEAL2: "waiting_for_deal2",
  PLAYING: "playing"
};

const BUY = {
  BAS: "BAS",
  HUKUM: "HUKUM",
  SUN: "SUN",
  ASHKAL: "ASHKAL",
  GABLAK_SUN: "GABLAK_SUN",
  GABLAK_ASHKAL: "GABLAK_ASHKAL",
  BET_OPEN: "BET_OPEN",
  BET_CLOSE: "BET_CLOSE",
  BET_DOUBLE: "BET_DOUBLE",
  BET_TRIPLE: "BET_TRIPLE",
  BET_QUADRUPLE: "BET_QUADRUPLE",
  GAHWA: "GAHWA",
  ENFORCE_SUN: "ENFORCE_SUN",
  ENFORCE_HUKUM: "ENFORCE_HUKUM"
};

function teamOf(id, teams) {
  return teams.get(id) ?? (id % 2 === 1 ? "A" : "B");
}

function parseCard(code) {
  const text = String(code || "").toUpperCase();
  return { code: text, rank: text.slice(0, -1), suit: text.slice(-1) };
}

function cardStrength(card, contract) {
  if (contract?.mode === "HUKUM" && contract.trump && card.suit === contract.trump) {
    return { J: 8, 9: 7, A: 6, 10: 5, K: 4, Q: 3, 8: 2, 7: 1 }[card.rank] ?? 0;
  }
  return { A: 8, 10: 7, K: 6, Q: 5, J: 4, 9: 3, 8: 2, 7: 1 }[card.rank] ?? 0;
}

function winningPlayIndex(plays, contract) {
  const led = plays[0].card.suit;
  let winner = 0;
  for (let i = 1; i < plays.length; i += 1) {
    const challenger = plays[i].card;
    const current = plays[winner].card;
    const challengerTrump =
      contract?.mode === "HUKUM" && contract.trump && challenger.suit === contract.trump;
    const currentTrump =
      contract?.mode === "HUKUM" && contract.trump && current.suit === contract.trump;

    if (challengerTrump && !currentTrump) {
      winner = i;
    } else if (challengerTrump === currentTrump && challenger.suit === current.suit) {
      if (cardStrength(challenger, contract) > cardStrength(current, contract)) winner = i;
    } else if (!currentTrump && challenger.suit === led && current.suit !== led) {
      winner = i;
    }
  }
  return winner;
}

export class TurnTracker {
  constructor(selfId) {
    this.selfId = selfId;
    this.phase = PHASE.WAITING_FOR_GAME;
    this.seats = [];
    this.teams = new Map();
    this.middle = null;
    this.contract = null;
    this.biddingPhase = 1;
    this.bidderIndex = 0;
    this.discussionQueue = [];
    this.leaderId = 0;
    this.nextPlayerId = 0;
    this.round = 0;
    this.currentTrick = [];
  }

  observe(actions) {
    let prompt = null;
    for (const action of actions) {
      const next = this.observeOne(action);
      if (next) prompt = next;
    }
    return prompt;
  }

  prompt(kind, extra = {}) {
    return { actorId: this.selfId, kind, ...extra };
  }

  observeOne(action) {
    switch (action.type) {
      case "NEW_SAKKAH":
        return null;
      case "NEW_GAME":
        this.seats = [
          Number(action.data.initiator),
          Number(action.data.nitwit),
          Number(action.data.cutter),
          Number(action.data.dealer)
        ];
        this.teams.set(this.seats[0], "A");
        this.teams.set(this.seats[2], "A");
        this.teams.set(this.seats[1], "B");
        this.teams.set(this.seats[3], "B");
        this.middle = null;
        this.contract = null;
        this.currentTrick = [];
        this.discussionQueue = [];
        this.biddingPhase = 1;
        this.bidderIndex = 0;
        this.leaderId = this.seats[0];
        this.nextPlayerId = this.seats[0];
        this.round = 0;
        this.phase = PHASE.WAITING_FOR_MIDDLE;
        return null;
      case "DEAL_1":
        return null;
      case "MIDDLE_CARD":
        this.middle = parseCard(action.data.card);
        this.phase = PHASE.BIDDING;
        this.biddingPhase = 1;
        this.bidderIndex = 0;
        return this.selfId === this.seats[0]
          ? this.prompt("BUY_CALL", { phase: "1" })
          : null;
      case "BUY_CALL":
        return this.observeBuyCall(action);
      case "DEAL_2":
        this.phase = PHASE.PLAYING;
        this.round = 1;
        this.currentTrick = [];
        this.leaderId = this.seats[0];
        this.nextPlayerId = this.leaderId;
        return this.selfId === this.nextPlayerId
          ? this.prompt("PLAY_CARD", { round: this.round })
          : null;
      case "STATE_PROJECT":
      case "SHOW_PROJECT":
      case "IKKAH":
      case "BALOOT":
        return null;
      case "PLAY_CARD":
        return this.observePlayCard(action);
      default:
        return null;
    }
  }

  observeBuyCall(action) {
    const kind = String(action.data.call || "").toUpperCase();

    if ((kind === BUY.ENFORCE_SUN || kind === BUY.ENFORCE_HUKUM) && this.contract) {
      if (kind === BUY.ENFORCE_SUN) {
        this.contract.mode = "SUN";
        this.contract.trump = "";
        this.phase = PHASE.DISCUSSION;
        this.discussionQueue = [...this.seats].reverse().filter((id) => id !== action.actor_id);
        return this.discussionQueue[0] === this.selfId
          ? this.prompt("BUY_CALL", { phase: "discussion" })
          : null;
      } else if (action.data.trump) {
        this.contract.mode = "HUKUM";
        this.contract.trump = action.data.trump;
      }
      this.phase = PHASE.WAITING_FOR_DEAL2;
      return null;
    }

    if (this.phase === PHASE.BIDDING) {
      if (kind === BUY.BAS) {
        this.bidderIndex += 1;
        if (this.bidderIndex === 4) {
          if (this.biddingPhase === 1) {
            this.biddingPhase = 2;
            this.bidderIndex = 0;
          } else {
            this.phase = PHASE.WAITING_FOR_GAME;
            return null;
          }
        }
        return this.selfId === this.seats[this.bidderIndex]
          ? this.prompt("BUY_CALL", { phase: String(this.biddingPhase) })
          : null;
      }

      this.setContract(action, kind);
      this.phase = PHASE.DISCUSSION;
      this.discussionQueue = [...this.seats].reverse().filter((id) => id !== action.actor_id);
      return this.discussionQueue[0] === this.selfId
        ? this.prompt("BUY_CALL", { phase: "discussion" })
        : null;
    }

    if (this.phase === PHASE.DISCUSSION) {
      if (kind === BUY.GABLAK_SUN || kind === BUY.GABLAK_ASHKAL) {
        this.setContract(action, kind);
        this.discussionQueue = [...this.seats].reverse().filter((id) => id !== action.actor_id);
        return this.discussionQueue[0] === this.selfId
          ? this.prompt("BUY_CALL", { phase: "discussion" })
          : null;
      }

      if (this.discussionQueue[0] === action.actor_id) {
        this.discussionQueue.shift();
      }

      if (this.discussionQueue.length === 0) {
        this.phase = PHASE.WAITING_FOR_DEAL2;
        const mustEnforce =
          this.contract?.mode === "HUKUM" &&
          this.contract.multiplier === 1 &&
          this.contract.buyerId === this.selfId;
        return mustEnforce ? this.prompt("BUY_CALL", { phase: "enforce" }) : null;
      }

      return this.discussionQueue[0] === this.selfId
        ? this.prompt("BUY_CALL", { phase: "discussion" })
        : null;
    }

    return null;
  }

  setContract(action, kind) {
    this.contract = {
      buyerId: action.actor_id,
      buyerTeam: teamOf(action.actor_id, this.teams),
      sourceCall: kind,
      mode: kind === BUY.HUKUM ? "HUKUM" : "SUN",
      trump: kind === BUY.HUKUM ? action.data.trump || this.middle?.suit || "" : "",
      multiplier: 1
    };
  }

  observePlayCard(action) {
    if (this.phase !== PHASE.PLAYING || !this.contract) return null;
    this.currentTrick.push({ actorId: action.actor_id, card: parseCard(action.data.card) });

    if (this.currentTrick.length < 4) {
      const idx = this.seats.indexOf(action.actor_id);
      this.nextPlayerId = this.seats[(idx + 1) % 4];
      return this.selfId === this.nextPlayerId
        ? this.prompt("PLAY_CARD", { round: this.round })
        : null;
    }

    const winnerIndex = winningPlayIndex(this.currentTrick, this.contract);
    this.leaderId = this.currentTrick[winnerIndex].actorId;
    this.nextPlayerId = this.leaderId;
    this.currentTrick = [];
    this.round += 1;
    if (this.round > 8) {
      this.phase = PHASE.WAITING_FOR_GAME;
      return null;
    }
    return this.selfId === this.nextPlayerId
      ? this.prompt("PLAY_CARD", { round: this.round })
      : null;
  }
}

export const BUY_CALLS = Object.values(BUY);
