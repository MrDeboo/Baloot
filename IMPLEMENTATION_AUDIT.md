# Implementation Audit

Last updated after the final direct Clang verification pass.

## Verified

- C++23 sources compile directly with Apple Clang.
- `baloot-core-tests` passes.
- Standalone `baloot-server` and `baloot-bot` compile.
- Config-file launch with four bot processes completes a match.
- `--matches 0` exits cleanly on SIGINT/SIGTERM.
- Loopback tests cover:
  - In-process sakkah.
  - Single network match.
  - Concurrent network matches.
  - Disconnect forfeit.
  - Malformed client forfeit with `GAID`, `ERROR`, and `MATCH_END`.
  - Gablak, betting, Hukum enforce/flip, Gahwa scoring, and did-not-go-higher.

## Implemented Toward The Original Spec

- Core card/action/cards/project/scoring/gaid model.
- Transport-agnostic `bot_base`.
- Host-driven sakkah loop.
- Phase-1/phase-2 bidding with Sun, Hukum, and Ashkal validation.
- Discussion handling for Bas, Gablak Sun/Ashkal, open/closed betting, and
  Hukum enforce/flip.
- Double/triple/quadruple/Gahwa call parsing and scoring hooks.
- Second deal, project validation, show-project scoring, trick play, last-trick
  bonus, and match scoring.
- TCP length-framed JSON protocol and control messages.
- Lobby matchmaking and concurrent match execution.
- Reference bot client state machine.
- Config flags/file, human-readable logs, and shutdown handling.

## Notes

- CMake files are present, but `cmake` is not installed in this environment, so
  `ctest` itself has not been executed here.
- The reference bot intentionally uses a conservative strategy. It is designed
  to stay legal and complete matches, not to play expert Baloot.
