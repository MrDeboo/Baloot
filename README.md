# Baloot Network Game

A C++23 Baloot engine and TCP host that can match four bot clients, run full
matches, and print a human-readable move log. The core engine talks only to
`bot_base`, so in-process bots and network clients use the same game loop.

## Status

Implemented and tested:

- 32-card Baloot deck, card parsing, Sun/Hukum point and strength tables.
- Four fixed seats and two fixed partnerships.
- Sakkah loop to a configurable target score.
- First deal, middle card, two-phase bidding, second deal, projects, trick play,
  gaid validation, scoring, and role rotation.
- TCP length-framed JSON protocol.
- `network_bot : bot_base` socket adapter with read timeouts and frame-size
  limits.
- Lobby server with four-client matchmaking and concurrent matches.
- Reference bot client that completes normal bot-vs-bot matches without gaid.
- Clean forfeit for timeout, disconnect, malformed frames, and illegal protocol
  input.

Advanced bidding branches are implemented in the host state machine for gablak,
open/closed betting, double/triple/quadruple/Gahwa calls, and Hukum
enforce/flip. The reference bot remains conservative by design: it completes
legal matches reliably rather than trying to play expert Baloot.

## Requirements

- C++23 compiler.
- CMake 3.24+.
- macOS: Xcode Command Line Tools, Apple Clang 17+, LLVM Clang, or GCC.
- Windows: Visual Studio 2022 with the Desktop development with C++ workload, or
  MinGW-w64/GCC with Ninja.
- No third-party runtime dependency is required by the current source. JSON is
  encoded/decoded by the small strict parser in `src/net/protocol.cpp`.

The CMake build links platform libraries automatically, including Winsock
(`ws2_32`) on Windows.

## Build

macOS:

```sh
brew install cmake
cmake -S . -B build
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

Windows with Visual Studio 2022, from Developer PowerShell:

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
```

Windows with Ninja and MinGW-w64:

```powershell
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
```

Targets:

- `baloot-server`
- `baloot-bot`
- `baloot-local-smoke`
- `baloot-core-tests`

Direct compiler fallback for macOS/Linux when CMake is unavailable:

```sh
mkdir -p build
c++ -std=c++23 -Wall -Wextra -Wpedantic -Isrc \
  src/core/action.cpp src/core/card.cpp src/core/cards.cpp \
  src/core/host.cpp src/core/project.cpp src/core/rules.cpp \
  src/core/scoring.cpp src/net/frame.cpp src/net/protocol.cpp \
  src/net/socket.cpp src/net/network_bot.cpp src/net/server.cpp \
  src/bots/local_bot.cpp src/bots/reference_client.cpp \
  tests/test_main.cpp -o build/baloot-core-tests

./build/baloot-core-tests
```

On Windows, prefer the CMake commands above. If you compile manually, link
Winsock explicitly with `Ws2_32.lib` for MSVC or `-lws2_32` for MinGW.

## Run A Match

Start a server for one match on macOS:

```sh
./build/baloot-server --port 33999 --target-score 152 --matches 1
```

Launch four bots in separate terminals:

```sh
./build/baloot-bot --host 127.0.0.1 --port 33999 --name bot-a
./build/baloot-bot --host 127.0.0.1 --port 33999 --name bot-b
./build/baloot-bot --host 127.0.0.1 --port 33999 --name bot-c
./build/baloot-bot --host 127.0.0.1 --port 33999 --name bot-d
```

Start a server for one match on Windows with the Visual Studio generator:

```powershell
.\build\Release\baloot-server.exe --port 33999 --target-score 152 --matches 1
```

Launch four bots in separate PowerShell windows:

```powershell
.\build\Release\baloot-bot.exe --host 127.0.0.1 --port 33999 --name bot-a
.\build\Release\baloot-bot.exe --host 127.0.0.1 --port 33999 --name bot-b
.\build\Release\baloot-bot.exe --host 127.0.0.1 --port 33999 --name bot-c
.\build\Release\baloot-bot.exe --host 127.0.0.1 --port 33999 --name bot-d
```

If you build with Ninja on Windows, the executables are under `.\build\` instead
of `.\build\Release\`.

Run two concurrent matches with eight bots:

```sh
./build/baloot-server --port 33999 --target-score 152 \
  --matches 2 --max-concurrent-matches 2
```

For long-running lobby mode, use `--matches 0`. The server stops accepting new
lobby clients on SIGINT/SIGTERM, notifies unmatched lobby clients, waits for
active matches to finish, and exits.

## Visualizer

Open `visualizer/index.html` in a browser to replay a full Baloot match log.
The visualizer accepts output from `baloot-server` or `baloot-local-smoke`,
shows each game, trick, card play, winner, and score transition, and includes a
sample replay by default.

If a browser blocks direct local-file loading, serve the repository and open
`http://127.0.0.1:8765/visualizer/index.html`:

```sh
python3 -m http.server 8765
```

On Windows:

```powershell
py -m http.server 8765
```

## Platform Notes

- The TCP server binds to `127.0.0.1`, so matches run locally by default on both
  macOS and Windows.
- The network layer uses POSIX sockets on macOS/Linux and Winsock on Windows.
- CMake defines `_WIN32_WINNT=0x0601`, `WIN32_LEAN_AND_MEAN`, and `NOMINMAX` for
  Windows builds.
- Windows Firewall may ask for loopback/network permission the first time you
  run `baloot-server.exe`.

## Config

Flags:

- `--config path`
- `--port N`
- `--target-score N`
- `--matches N` (`0` means run until SIGINT/SIGTERM)
- `--max-concurrent-matches N`
- `--read-timeout-ms N`
- `--accept-timeout-ms N`
- `--max-frame-bytes N`
- `--seed N`
- `--log-level quiet|info|debug`

Config files are line-oriented `key=value` files. See
`examples/server.conf`.

## Rules Implemented

The pasted project spec is the authority. Ambiguous scoring choices follow the
Saudi-style Baloot rules summarized by Pagat and broadly echoed by PlayLah and
Jawaker:

- Baloot is four players in two fixed partnerships, with a 32-card deck and a
  target score of 152 by default.
- Sun strength: `A, 10, K, Q, J, 9, 8, 7`.
- Hukum trump strength: `J, 9, A, 10, K, Q, 8, 7`.
- Card points: Sun/non-trump `A=11, 10=10, K=4, Q=3, J=2`; Hukum trump
  `J=20, 9=14, A=11, 10=10, K=4, Q=3`.
- Last trick bonus: 10 card points.
- Projects: Sira, Fifty, Hundred, and Four Hundred, with no card reused across
  projects.
- Only the team with the single best project scores its shown projects.
- Baloot bonus is Hukum-only, K+Q of trump, worth 2 game points.

Project values:

| Project | Hukum | Sun/Ashkal |
| --- | ---: | ---: |
| Sira | 2 | 4 |
| Fifty | 5 | 10 |
| Hundred | 10 | 20 |
| Four Hundred | invalid | 40 |

Scoring conversion:

- Hukum: round the relevant card-point total to the nearest 10, with 5 rounded
  down, then divide by 10. Total card game points are 16.
- Sun/Ashkal: round to nearest 10, except totals ending in 5 are not rounded,
  then divide by 5. Total card game points are 26.
- If the declaring team loses, the opposing team takes the whole hand score and
  the declaring team scores zero.
- If a team takes all tricks, the current engine scores 25 in Hukum or 44 in
  Sun/Ashkal before eligible bonuses.
- Gahwa awards the match target to the winning team immediately.

Sources:

- [Pagat Baloot rules](https://www.pagat.com/jass/baloot.html)
- [PlayLah Baloot rules](https://playlah.helpshift.com/hc/en/3-playlah/faq/87-baloot/)
- [Jawaker Baloot rules](https://blog.jawaker.com/en/baloot-rules-en/amp/)

## Wire Protocol

Transport is TCP. One logical message is one length-prefixed frame:

```text
<decimal payload byte length>\n
<JSON payload>\n
```

The default maximum payload is 64 KiB. Partial reads are buffered until the
complete frame arrives. Invalid lengths, oversized frames, malformed JSON, bad
sequence numbers, and wrong match ids are protocol errors.

Action envelope:

```json
{
  "kind": "ACTIONS",
  "seq": 42,
  "match_id": "m-1",
  "actions": [
    {
      "actor_id": 1,
      "type": "PLAY_CARD",
      "data": {"card": "AS"}
    }
  ]
}
```

Control messages:

- `HELLO`: `{ "kind": "HELLO", "name": "...", "version": "1", "token": "" }`
- `WELCOME`: connection id and protocol version.
- `JOIN_LOBBY`: request matchmaking.
- `MATCH_FOUND`: match id, `self_id`, and player list.
- `ERROR`: protocol, lobby, or match error.
- `GAID`: reserved typed game violation message.
- `MATCH_END`: final standings and reason.
- `PING` / `PONG`: nonce echo.

Action types:

```text
NEW_SAKKAH, NEW_GAME, DEAL_1, MIDDLE_CARD, BUY_CALL, DEAL_2,
STATE_PROJECT, SHOW_PROJECT, PLAY_CARD, IKKAH, BALOOT
```

Common data keys:

```text
self_id, initiator, nitwit, cutter, dealer, our_score, their_score,
cards, card, call, type, phase, trump, project, round, score, message
```

## Concurrency Model

The lobby server uses:

- One caller thread accepting clients into the lobby.
- One match task per group of four clients.
- A configurable `max_concurrent_matches` guard.

After matchmaking, each socket is owned by exactly one match task through its
`network_bot`; no other thread reads or writes that socket. The lobby only
touches sockets before `MATCH_FOUND`. Match result storage is synchronized by
future completion in the caller.

## Disconnect And Forfeit Policy

- Lobby disconnect: client is dropped before matching.
- Match disconnect, timeout, malformed frame, wrong sequence, wrong actor, or
  invalid protocol: converted into typed `invalid_action`.
- The offending player's team forfeits the match.
- Surviving clients receive `ERROR` followed by `MATCH_END` with reason
  `FORFEIT`.
- Other concurrent matches continue unaffected.

## Tests

`baloot-core-tests` covers:

- Card point/order tables.
- Action type conversion.
- Action/control/envelope/frame serialization, including empty data and special
  characters.
- Project validation.
- Trick winner resolution.
- Gaid cases: invalid cut, did not knock, trump initiation.
- Advanced bidding coverage for gablak, betting, Hukum enforce/flip, and Gahwa
  scoring.
- In-process sakkah smoke test.
- Loopback network sakkah smoke test.
- Concurrent lobby matches.
- Disconnect forfeit.
- Malformed client isolation while another match completes normally.
