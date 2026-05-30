# Baloot Network Game: Step 1 Design

Status: historical design document. Implementation now lives in `src/`,
`apps/`, and `tests/`; the current operator documentation is in `README.md`.

This was the milestone-1 design for building the Baloot engine, network host,
wire protocol, and reference bot from scratch.

## Scope

The project will produce:

- A pure, transport-agnostic Baloot engine.
- A `bot_base` boundary usable by in-process bots and remote network clients.
- TCP server matchmaking four bot clients into matches.
- Newline/length-framed JSON protocol for engine actions and control messages.
- A reference bot that can complete full matches without normal gaid failures.
- CMake targets `baloot-server`, `baloot-bot`, and tests runnable with `ctest`.

The pasted task is the authoritative rule spec. Where it explicitly allows a
choice for ambiguous scoring details, this design follows the Saudi
tournament-style rules summarized by Pagat, cross-checked against PlayLah and
Jawaker. Variant choices will be centralized in `rules_config` and documented
in the README.

References to cite in the README:

- https://www.pagat.com/jass/baloot.html
- https://playlah.helpshift.com/hc/en/3-playlah/faq/87-baloot/
- https://blog.jawaker.com/en/baloot-rules-en/amp/

## Source Layout

Planned repository layout:

```text
CMakeLists.txt
README.md
src/
  core/
    action.cpp
    action.hpp
    bot.hpp
    card.cpp
    card.hpp
    cards.cpp
    cards.hpp
    gaid.hpp
    game_state.hpp
    host.cpp
    host.hpp
    project.cpp
    project.hpp
    rules.cpp
    rules.hpp
    scoring.cpp
    scoring.hpp
  net/
    frame.cpp
    frame.hpp
    network_bot.cpp
    network_bot.hpp
    protocol.cpp
    protocol.hpp
    server.cpp
    server.hpp
  bots/
    reference_bot.cpp
    reference_bot.hpp
apps/
  baloot_server.cpp
  baloot_bot.cpp
tests/
  test_cards.cpp
  test_projects.cpp
  test_scoring.cpp
  test_tricks_gaid.cpp
  test_protocol.cpp
  test_integration.cpp
```

The original unrelated web-editor files were removed during final cleanup.

## Core Model

### `card`

`card` is a small value type:

```cpp
enum class suit { clubs, diamonds, hearts, spades };
enum class rank { seven, eight, nine, ten, jack, queen, king, ace };

struct card {
  suit s;
  rank r;
};
```

Helpers:

- `std::string to_string(card)`: stable ASCII format, e.g. `7C`, `10D`, `JH`,
  `AS`.
- `std::optional<card> parse_card(std::string_view)`.
- `int sun_points(card)`.
- `int hukum_points(card, suit trump)`.
- `int sun_strength(rank)`.
- `int hukum_trump_strength(rank)`.
- `int sequence_strength(rank)`.

Rank/point constants live in `rules.hpp`.

Sun order, high to low:

```text
A, 10, K, Q, J, 9, 8, 7
```

Hukum trump order, high to low:

```text
J, 9, A, 10, K, Q, 8, 7
```

Sequence order, high to low:

```text
A, K, Q, J, 10, 9, 8, 7
```

### `cards`

`cards` wraps an ordered vector of `card`.

Operations:

- `cards make_deck_32()`.
- `void shuffle(std::mt19937&)`.
- `cards deal(size_t n)`.
- `bool contains(card) const`.
- `size_t index_of(card) const`.
- `void append(card)`.
- `card remove(card)`.
- `std::string to_string() const`.
- `cards parse_cards(std::string_view)`.

Hand order is preserved for logging and deterministic tests.

### `action`

The engine action type exactly follows the requested boundary:

```cpp
enum class action_type {
  new_sakkah,
  new_game,
  deal_1,
  middle_card,
  buy_call,
  deal_2,
  state_project,
  show_project,
  play_card,
  ikkah,
  baloot
};

struct action {
  int actor_id;
  action_type type;
  std::map<std::string, std::string> data;

  bool valid() const;
  std::string_view operator[](std::string_view key) const;
};
```

Action type conversion is lossless and case-stable:

```text
NEW_SAKKAH, NEW_GAME, DEAL_1, MIDDLE_CARD, BUY_CALL, DEAL_2,
STATE_PROJECT, SHOW_PROJECT, PLAY_CARD, IKKAH, BALOOT
```

Known data keys:

```text
self_id, initiator, nitwit, cutter, dealer, our_score, their_score,
cards, card, call, type, phase, trump, contract, multiplier, closed,
project, round, trick, winner, message
```

`BUY_CALL` will use `data["call"]` for all buy/discussion/betting subcalls:

```text
BAS, SUN, HUKUM, ASHKAL, GABLAK_SUN, GABLAK_ASHKAL,
BET_OPEN, BET_CLOSE, BET_DOUBLE, BET_TRIPLE, BET_QUADRUPLE, GAHWA,
ENFORCE_SUN, ENFORCE_HUKUM
```

### State Value Types

Planned value types:

- `seat`: `initiator`, `nitwit`, `cutter`, `dealer`.
- `team_id`: `team_a`, `team_b`.
- `team`: ids, score, seat pair.
- `buy_call`: actor, call kind, phase, selected trump, closed/open flag.
- `contract`: mode `sun` or `hukum`, trump if Hukum, buyer id, taker id,
  buyer team, source call, multiplier, closed flag, gahwa flag.
- `project`: owner id, kind, cards, score value, comparison rank.
- `trick_play`: actor id, card, optional `ikkah`, optional `baloot`.
- `round`: leader, plays, winner, led suit, card points.
- `game`: seats, hands, middle card, contract, projects, rounds, trick piles,
  gaid state, score breakdown.
- `sakkah`: target score, teams, current seats, current game number, winner.

### Gaid Errors

`gaid` exceptions are typed but serializable:

```cpp
class gaid : public std::runtime_error {
 public:
  int source_id() const;
  std::optional<int> target_id() const;
  std::optional<card> offending_card() const;
  cards expected_cards() const;
};
```

Derived errors:

- `invalid_action`
- `invalid_cut`
- `didnt_knock`
- `trump_initiation`
- `didnt_go_higher`

Every gaid includes a human-readable message and enough structured data for a
network `GAID` control message.

## Engine Boundary

The engine knows only this abstract interface:

```cpp
struct bot_base {
  virtual ~bot_base() = default;
  virtual std::vector<action> read() = 0;
  virtual void write(std::vector<action> actions) = 0;
  virtual int id() = 0;
};
```

In-process test bots and network clients both implement this interface.

`host` owns no sockets and imports nothing from `src/net`. It pulls actions by
calling `read()` only when the active player is expected to respond and pushes
announcements with `write()`.

## Sakkah And Seating

The four seats in dealing and turn order are:

```text
INITIATOR -> NITWIT -> CUTTER -> DEALER -> INITIATOR
```

Teams:

```text
Team A: INITIATOR + CUTTER
Team B: NITWIT + DEALER
```

At `NEW_SAKKAH`, each receiver gets its own `self_id`.

At each `NEW_GAME`, each receiver gets:

- `initiator`
- `nitwit`
- `cutter`
- `dealer`
- `our_score`
- `their_score`

After every scored, void, or forfeited hand, seats rotate by one position so the
dealer role moves to the next player in cyclic order. A sakkah ends when a team
reaches the target score, default 152, unless both teams are tied at or above
target; in that case another hand breaks the tie.

## Game State Machine

### Deal

1. Shuffle a fresh 32-card deck.
2. First deal: five cards to each player.
3. `DEAL_1` is sent privately to each player with `cards`.
4. Deal one face-up middle card.
5. `MIDDLE_CARD` is broadcast with `card`.

### Bidding

Phase 1:

- Acting order: `INITIATOR`, `NITWIT`, `CUTTER`, `DEALER`.
- Legal calls: `BAS`, `SUN`, `HUKUM`, `ASHKAL`.
- `ASHKAL` is legal only for `CUTTER` or `DEALER`.
- Phase-1 `HUKUM` uses the middle card suit.

If all pass, phase 2 starts:

- Acting order repeats.
- Legal calls: `BAS`, `SUN`, `HUKUM`.
- Phase-2 `HUKUM` must name a trump suit different from the middle card suit.
- No phase-2 `ASHKAL`.

If all pass both phases, the hand is void: no score change, roles rotate, and a
new game begins.

Contract taker:

- `SUN`: caller takes the middle card.
- `HUKUM`: caller takes the middle card.
- `ASHKAL`: caller's partner takes the middle card; mode is Sun/Ashkal.

### Gablak, Betting, And Enforce

After a buy, discussion iterates in reverse seat order:

```text
DEALER -> CUTTER -> NITWIT -> INITIATOR
```

Legal discussion calls:

- `BAS`
- `GABLAK_SUN`
- `GABLAK_ASHKAL`
- `BET_OPEN`
- `BET_CLOSE`
- multiplier calls after betting is opened

Gablak rules:

- Gablak must be Sun or Ashkal.
- Ashkal gablak is legal only for Cutter or Dealer.
- A player cannot gablak their own teammate unless the original buy was Hukum.
- On gablak, the current contract is replaced and discussion restarts.
- The implementation uses an explicit loop with a transition cap to avoid
  accidental infinite recursion.

Betting rules:

- Only the team opposite the current buyer may open betting.
- Once opened, turns alternate buyer side and bettor side.
- Hukum betting can be open or closed.
- Sun betting is open only.
- The buyer may not use `BET_CLOSE` for the opening bet.
- Multipliers are represented centrally as `none`, `double`, `triple`,
  `quadruple`, and `gahwa`.

Enforce/flip:

- If Hukum was bought and no double occurred, the buyer is asked to enforce.
- Phase-1 Hukum may flip to Sun.
- Phase-2 Hukum must confirm/select a legal trump suit not equal to the middle
  card suit.
- If the contract flips, the discussion phase reruns.

### Second Deal

The middle-card taker receives the middle card plus two more cards. Every other
player receives three cards. After `DEAL_2`, every player has eight cards.

The engine verifies hand sizes and deck exhaustion.

## Projects

Project declaration happens before or at the start of play. The engine accepts
zero or more `STATE_PROJECT` actions from a player before their first
`PLAY_CARD`, validates each project strictly, and records only legal
non-overlapping card sets.

Kinds:

- `SIRA`: three consecutive cards in one suit.
- `FIFTY`: four consecutive cards in one suit.
- `HUNDRED`: five consecutive cards in one suit, or four of a kind using only
  `10`, `J`, `Q`, `K`, or `A`.
- `FOUR_HUNDRED`: four Aces, Sun only.

Four-of-a-kind `7`, `8`, and `9` are invalid. A card can belong to only one
declared project.

Project values:

```text
Kind          Hukum  Sun/Ashkal
SIRA          2      4
FIFTY         5      10
HUNDRED       10     20
FOUR_HUNDRED  invalid 40
```

Only the team with the single highest project scores its projects. Comparison:

1. Higher scoring project wins.
2. Four-of-a-kind beats a five-card sequence when both are `HUNDRED`.
3. Higher top rank in sequence order wins.
4. Earlier player in first-trick order wins remaining ties.

Winning projects are sent as `SHOW_PROJECT` during round 2. The losing team's
projects are not shown or scored.

## Baloot Bonus

Baloot exists only in Hukum. A player holding the King and Queen of trump scores
2 game points for that player's team when the second of those two cards is
played and `BALOOT` is declared, or when the rules-configured auto-baloot mode
detects it.

If the K/Q trump pair is inside a shown Sira or Fifty, the default config scores
Baloot automatically, matching the Pagat-described common rule. If it is inside
a Hundred project, it does not score separately. This behavior is isolated in
`rules_config`.

## Trick Play

The first trick is led by `INITIATOR`, regardless of the buyer. Each later trick
is led by the previous trick winner.

Sun/Ashkal:

- Any card may be led.
- Followers must follow led suit if possible.
- A player unable to follow suit may play any card.
- Highest led-suit card by Sun strength wins.

Hukum:

- A leader may play any card, except in closed Hukum.
- In closed Hukum, a leader may not lead trump if they hold any non-trump card.
- Followers must follow led suit if possible.
- If trump is led, followers must over-trump when an opponent is currently
  winning and they can beat the current highest trump.
- If non-trump is led and a follower cannot follow suit, they generally must
  trump if doing so is required to beat or challenge an opponent.
- Exceptions:
  - Third player may discard if partner is currently winning and the leader
    signalled valid Ikkah.
  - Third player may discard if second player trumped and third player cannot
    beat it.
  - Fourth player may discard if their side is already winning the trick.
- When trumping is required against an opponent-held winning trump, the player
  must go higher if possible.

Ikkah:

- In Hukum, when a trick leader leads a non-trump card that is the highest
  remaining card of that suit, `IKKAH` may be sent or auto-recorded.
- Invalid Ikkah is rejected as `invalid_action`.
- Valid Ikkah relaxes the partner's forced-trump obligation in the documented
  third-player case.

The trick winner is highest trump if any trump was played, otherwise highest
card of the led suit.

## Scoring

Card points:

```text
Sun/non-trump: A=11, 10=10, K=4, Q=3, J=2, 9/8/7=0
Hukum trump:   J=20, 9=14, A=11, 10=10, K=4, Q=3, 8/7=0
```

The last trick adds 10 card points to the winning team.

Counting team:

- With no multiplier, the opponents of the declarer are the counting team.
- With multiplier, the counting team is the opponents of the last team that
  raised the multiplier.

Conversion:

- Hukum: counting team's card points round to nearest 10, with 5 rounded down,
  then divide by 10. Total card game points are 16.
- Sun/Ashkal: counting team's card points round to nearest 10, except totals
  ending in 5 are not rounded, then divide by 5. Total card game points are 26.

Projects and Baloot are added as game points after card conversion.

Winner:

- Higher total game points wins the hand.
- On a tie, use the counting team's card-point units digit to determine who
  lost more in rounding.
- If rounding is also tied, the declarer's team wins.

Score assignment:

- No multiplier and declarer wins: both teams add their own hand game points.
- No multiplier and declarer loses: opponents score the whole hand; declarer
  scores zero.
- Any multiplier: winning team scores the multiplied whole hand; losing team
  scores zero.
- Gahwa: the hand winner wins the sakkah immediately.

Sweep:

- A team taking all eight tricks scores 25 in Hukum or 44 in Sun/Ashkal, plus
  eligible projects and Baloot. Opponents score zero.

## Host Responsibilities

`host` drives a complete sakkah:

1. Announce `NEW_SAKKAH`.
2. Loop games until match end.
3. Deal and announce private/public state.
4. Run bidding and discussion.
5. Complete second deal.
6. Collect and validate projects.
7. Run eight tricks with legal-card validation.
8. Catch gaid exceptions, notify players, and forfeit the offending team.
9. Score hand, rotate seats, and continue or end match.

The host logs a human-readable lifecycle stream through an injected logger
interface. The network server can attach a logger that writes to stdout/stderr.

## Wire Protocol

Transport is TCP. Framing is length-prefixed, newline-separated JSON:

```text
<decimal-payload-byte-length>\n
<json-payload>\n
```

One framed message equals one atomic vector returned by `read()` or passed to
`write()`. Max frame size defaults to 64 KiB and is configurable.

### Action Envelope

```json
{
  "kind": "ACTIONS",
  "seq": 42,
  "match_id": "m-000001",
  "actions": [
    {
      "actor_id": 3,
      "type": "PLAY_CARD",
      "data": {
        "card": "JH"
      }
    }
  ]
}
```

`seq` is per connection and monotonic. Duplicate, skipped, or malformed
sequence numbers are protocol errors.

### Control Messages

`HELLO`:

```json
{
  "kind": "HELLO",
  "name": "bot-a",
  "version": "1",
  "token": ""
}
```

`WELCOME`:

```json
{
  "kind": "WELCOME",
  "connection_id": "c-000001",
  "server_version": "1",
  "protocol_version": "1"
}
```

`JOIN_LOBBY`:

```json
{
  "kind": "JOIN_LOBBY"
}
```

`MATCH_FOUND`:

```json
{
  "kind": "MATCH_FOUND",
  "match_id": "m-000001",
  "self_id": 2,
  "players": [
    {"id": 1, "name": "bot-a"},
    {"id": 2, "name": "bot-b"},
    {"id": 3, "name": "bot-c"},
    {"id": 4, "name": "bot-d"}
  ]
}
```

`GAID`:

```json
{
  "kind": "GAID",
  "match_id": "m-000001",
  "type": "DIDNT_KNOCK",
  "source_id": 3,
  "target_id": 1,
  "offending_card": "7C",
  "expected_cards": "9H JH",
  "message": "Player 3 had trump and had to knock."
}
```

`ERROR`:

```json
{
  "kind": "ERROR",
  "code": "MALFORMED_JSON",
  "message": "Frame payload is not valid JSON."
}
```

`MATCH_END`:

```json
{
  "kind": "MATCH_END",
  "match_id": "m-000001",
  "winner_team": "A",
  "team_a_score": 152,
  "team_b_score": 97,
  "reason": "TARGET_SCORE"
}
```

`PING` and `PONG`:

```json
{"kind": "PING", "nonce": "abc"}
{"kind": "PONG", "nonce": "abc"}
```

## Network Host

Concurrency model:

- One acceptor thread listens for TCP connections.
- Each connection gets a session thread for handshake and lobby wait.
- When four clients are ready, socket ownership transfers to a match thread.
- Each match owns one `host` and four `network_bot` adapters.
- Multiple matches run concurrently.

Thread-safety:

- Lobby queue and active match registry are protected by mutexes.
- Once a connection enters a match, only that match thread reads or writes its
  socket.
- Logging uses a mutex-protected sink.

Timeouts and limits:

- Every blocking read has a configurable timeout.
- Every frame is capped by `max_frame_bytes`.
- Slow, silent, disconnected, malformed, or protocol-invalid clients forfeit
  their current match and never crash the server.

Disconnect policy:

- During lobby: remove the client quietly.
- During match: offending client's team forfeits the current hand or match
  depending on phase; default is match forfeit because there is no reconnect
  window in milestone scope.
- Other players receive `ERROR` and `MATCH_END`.

Graceful shutdown:

- SIGINT stops accepting new clients.
- Lobby sessions are closed.
- Active matches are notified through a cancellation flag and joined.
- Server exits after active threads finish or a forced timeout expires.

## Reference Bot

The bot is a standalone binary, `baloot-bot`.

Protocol state machine:

```text
HELLO -> WELCOME -> JOIN_LOBBY -> MATCH_FOUND
NEW_SAKKAH -> repeated game flow -> MATCH_END
```

Game flow:

```text
NEW_GAME -> DEAL_1 -> MIDDLE_CARD -> bidding/discussion/enforce ->
DEAL_2 -> round 1 projects/play -> round 2 show/play -> rounds 3-8 play
```

Strategy:

- Maintains its hand, middle card, played cards, contract, and trick state.
- Bids conservatively but not always pass, to avoid excessive void hands.
- Declares only projects validated by shared core helpers.
- Chooses randomly among `legal_cards(...)` for play.
- Sends `IKKAH` and `BALOOT` only when shared validators say legal.

The reference bot links against the same core rules as the host so normal
bot-vs-bot play should not trigger gaid.

## Build, Config, Logging, Tests

CMake:

- C++23 required.
- Preferred compiler: Apple Clang or Clang with C++23 library support.
- Third-party dependency: nlohmann/json only, fetched by CMake or vendored if
  network-free builds are preferred.

Config:

- `--port`
- `--target-score`
- `--max-concurrent-matches`
- `--read-timeout-ms`
- `--max-frame-bytes`
- `--log-level`
- optional `--config path.json`

Logging:

- Debug: every frame in/out.
- Info: lifecycle, deals, calls, trick winners, scoring.
- Warn/error: gaids, disconnects, malformed input, forfeits.

Tests:

- Serialization round trips for every action type, empty data, and special
  characters.
- Card point/order tables.
- Project validation, valid and invalid.
- Trick winner resolution.
- Gaid scenarios: invalid cut, did not knock, trump initiation, did not go
  higher.
- Integration smoke: start server in-process, connect four reference clients
  over loopback, complete at least one full sakkah, verify final standings and
  no crash.
- Robustness: malformed/illegal client message ends its match cleanly and does
  not affect another concurrent match.

## Approval Gate

Milestone 1 requires confirmation before implementation. After the user
approves this design, milestone 2 will begin:

- Create CMake project skeleton.
- Implement core cards/actions/rules/project/scoring/gaid helpers.
- Implement in-process local bot.
- Drive one complete in-memory sakkah.
- Add unit tests for cards, scoring, projects, trick winners, and gaid cases.
