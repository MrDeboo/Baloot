# Baloot Discord Activity

This folder contains a Discord Activity web app and a small Node.js backend that
proxies four Discord users into the existing C++ `baloot-server` engine.

The first four distinct users in an Activity instance become players. A match
starts only when those four seats are full. Everyone who joins after the four
seats are filled is kept as a spectator. The backend does not run bots or choose
actions for players; it only forwards player-submitted actions to the C++ engine
when the engine asks that seat for a move.

The client serves a vendored copy of `@discord/embedded-app-sdk` from
`activity/client/vendor/discord-embedded-app-sdk/` so a production Activity does
not need an extra external CDN URL mapping for the SDK import.

## Discord Setup

1. Create a Discord application and enable Activities in the Developer Portal.
2. Add a URL mapping for your Activity domain to the backend serving this folder.
3. Configure OAuth2 for the Activity and expose these environment variables:

   ```sh
   DISCORD_CLIENT_ID=your_application_id
   DISCORD_CLIENT_SECRET=your_oauth_client_secret
   DISCORD_BOT_TOKEN=your_bot_token_for_instance_verification
   DISCORD_PROXY_PUBLIC_KEY=your_application_public_key
   ACTIVITY_SESSION_SECRET=a-long-random-string
   ACTIVITY_PUBLIC_URL=https://your-activity-domain.example
   ```

4. Build the C++ engine first so `build/baloot-server` exists:

   ```sh
   cmake -S .. -B ../build
   cmake --build ../build --parallel
   ```

5. Check the production/runtime configuration, then start the Activity backend:

   ```sh
   cd activity
   node server/preflight.js
   node server/start.js
   ```

6. After the backend is reachable through the public URL mapping, verify the
   deployed Activity surface:

   ```sh
   node server/deploy-check.js --url "$ACTIVITY_PUBLIC_URL"
   ```

   If you enabled Discord proxy request signature checks, direct requests to
   `/api/config` are expected to fail without Discord's signed proxy headers.
   In that case, run:

   ```sh
   node server/deploy-check.js --url "$ACTIVITY_PUBLIC_URL" --allow-signed-api
   ```

Local development can run without Discord OAuth by leaving
`ACTIVITY_ALLOW_INSECURE_DEV=1` and opening:

```sh
cd activity
cp .env.example .env
node server/dev.js
```

```text
http://127.0.0.1:3000/?mock=1&room=dev&name=Adeeb
```

Open four browser profiles with different `name` query values to fill the four
player seats. A fifth browser joins as a spectator.

For production, set `ACTIVITY_ALLOW_INSECURE_DEV=0`. In that mode,
`DISCORD_BOT_TOKEN` is required: the backend verifies each authenticated user
against Discord's Activity Instance API before issuing a session or seating the
user in a room. If `DISCORD_PROXY_PUBLIC_KEY` is set to the application's public
key from the Developer Portal, API requests must also include valid Discord
proxy signature headers. For signed requests that include user context, the
backend also verifies that the signed proxy user matches the Activity session
user before allowing gameplay requests. `node server/preflight.js` fails if production Discord
credentials, the public HTTPS URL, the session secret, or the C++ engine binary
are missing.

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
- In Discord, the client uses same-origin `/api/*` paths through the Activity
  URL mapping. The backend still accepts the older `/.proxy/api/*` form for
  compatibility with existing local tests and older deployments.
- The Embedded App SDK is loaded from the Activity's own static assets rather
  than from an external CDN.
- In production mode, `/api/token` verifies the authenticated user is present in
  the Discord Activity instance before issuing an Activity session.
- When proxy request signatures are enabled, signed Discord proxy user context is
  bound to the Activity session user for `/api/token`, `/api/events`, and
  `/api/action`.
- Non-HTML Activity assets are served with `Cache-Control: no-store` so Discord
  clients do not hold stale JavaScript or CSS after a deploy.

## Useful Environment Variables

- `ACTIVITY_HOST`: bind address, default `127.0.0.1`; use `0.0.0.0` behind a
  production proxy/container.
- `ACTIVITY_PORT`: backend port, default `3000`.
- `ACTIVITY_PUBLIC_URL`: public Activity origin.
- `DISCORD_BOT_TOKEN`: required when `ACTIVITY_ALLOW_INSECURE_DEV=0`; enables
  Discord Activity Instance API verification for production sessions.
- `DISCORD_PROXY_PUBLIC_KEY`: optional 64-character hex application public key.
  When set outside local dev, the backend verifies Discord proxy request
  signatures before serving Activity API calls. `DISCORD_APPLICATION_PUBLIC_KEY`
  is accepted as an alias.
- `BALOOT_SERVER_BIN`: path to `baloot-server`.
  Relative paths are resolved from the current working directory, the
  `activity/` folder, and the repository root so both `../build/baloot-server`
  and `build/baloot-server` work from common launch locations.
- `BALOOT_TARGET_SCORE`: target score passed to the engine, default `152`.
- `BALOOT_READ_TIMEOUT_MS`: engine read timeout, default `900000`.
- `ACTIVITY_DISCONNECT_GRACE_MS`: reconnect grace period for a seated player
  during a match, default `10000`. If the player does not reconnect before the
  grace expires, the Activity closes that player's engine proxy seat and the
  engine resolves the match as a forfeit. No bot action is generated.
- `ACTIVITY_ASSET_VERSION`: optional cache-busting value injected into
  `main.js` and `styles.css` URLs. If omitted, the backend generates a new value
  when it starts.
- `ACTIVITY_ALLOW_INSECURE_DEV`: set `1` for mock local users.
  Set `0` in production; production sessions require `DISCORD_BOT_TOKEN`.

## Commands

- `node server/dev.js`: loads `activity/.env` if it exists, defaults to local mock
  users, and starts the Activity backend.
- `node server/preflight.js`: loads `activity/.env` if it exists and validates the
  Discord/engine configuration without starting a server.
- `node server/deploy-check.js --url <public-url>`: checks the served Activity
  HTML, static assets, SDK bundle, API health, canonical `/api/*` routes, cache
  headers, and production config flags for a deployed URL.
- `node server/start.js`: loads `activity/.env` if it exists and starts the backend.
- `node --test server/*.test.js`: runs the Activity server tests.

The same commands are also exposed as npm scripts (`npm run dev`,
`npm run preflight`, `npm run verify:deploy`, `npm start`, `npm test`) when npm
is available.
