# Baloot Discord Activity

This folder contains a Discord Activity web app and a small Node.js backend that
proxies four Discord users into the existing C++ `baloot-server` engine.

The first four distinct users in an Activity instance become players. A match
starts only when those four seats are full. Everyone who joins after the four
seats are filled is kept as a spectator. The backend does not run bots or choose
actions for players; it only forwards player-submitted actions to the C++ engine
when the engine asks that seat for a move.

## Discord Setup

1. Create a Discord application and enable Activities in the Developer Portal.
2. Add a URL mapping for your Activity domain to the backend serving this folder.
3. Configure OAuth2 for the Activity and expose these environment variables:

   ```sh
   DISCORD_CLIENT_ID=your_application_id
   DISCORD_CLIENT_SECRET=your_oauth_client_secret
   DISCORD_BOT_TOKEN=your_bot_token_for_instance_verification
   ACTIVITY_SESSION_SECRET=a-long-random-string
   ACTIVITY_PUBLIC_URL=https://your-activity-domain.example
   ```

4. Build the C++ engine first so `build/baloot-server` exists:

   ```sh
   cmake -S .. -B ../build
   cmake --build ../build --parallel
   ```

5. Start the Activity backend:

   ```sh
   cd activity
   node server/index.js
   ```

Local development can run without Discord OAuth by leaving
`ACTIVITY_ALLOW_INSECURE_DEV=1` and opening:

```text
http://127.0.0.1:3000/?mock=1&room=dev&name=Adeeb
```

Open four browser profiles with different `name` query values to fill the four
player seats. A fifth browser joins as a spectator.

## How It Uses The Engine

- The Activity backend reserves a local TCP port and spawns
  `baloot-server --matches 1` on that port.
- It creates four TCP proxy clients, one for each seated Activity player.
- Engine `ACTIONS` frames update the Activity room and are streamed to browsers.
- Private deal frames update only the owning player's hand.
- Player HTTP actions become engine `ACTIONS` envelopes with the expected
  sequence number.
- If the engine rejects an action, disconnects, or times out, the existing
  engine forfeit behavior is preserved.
- In Discord, the client uses the `/.proxy/api/*` path supported by the backend.
- When `DISCORD_BOT_TOKEN` is set, `/api/token` verifies the authenticated user
  is present in the Discord Activity instance before issuing an Activity session.

## Useful Environment Variables

- `ACTIVITY_HOST`: bind address, default `127.0.0.1`; use `0.0.0.0` behind a
  production proxy/container.
- `ACTIVITY_PORT`: backend port, default `3000`.
- `ACTIVITY_PUBLIC_URL`: public Activity origin.
- `DISCORD_BOT_TOKEN`: optional but recommended; enables Discord Activity
  Instance API verification for production sessions.
- `BALOOT_SERVER_BIN`: path to `baloot-server`.
- `BALOOT_TARGET_SCORE`: target score passed to the engine, default `152`.
- `BALOOT_READ_TIMEOUT_MS`: engine read timeout, default `900000`.
- `ACTIVITY_ALLOW_INSECURE_DEV`: set `1` for mock local users.
