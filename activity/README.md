# Baloot Discord Activity

This folder is a Discord Activity wrapper around the C++ Baloot engine in the
repository root. It serves a static browser client and a small Node.js backend
that connects exactly four Discord users to one `baloot-server` match.

The Activity does not run gameplay bots. The first four distinct users inside a
single Discord Activity instance become the players. The match starts only after
all four player seats are filled. Anyone who joins after those four seats are
full is shown as a spectator and cannot submit engine actions.

## Status

The Activity implementation is ready for local testing and production readiness
checks. Final production proof still requires a real Discord application,
Developer Portal Activity URL mapping, production credentials, and a live
`node server/readiness.js` pass against that public URL.

The code follows Discord's current Activity guidance:

- Activities are web apps embedded in Discord iframes.
- The SDK `instanceId` is used as the shared room key for users in the same
  launched Activity instance.
- Connected Discord participants are fetched through
  `getInstanceConnectedParticipants()` and subscribed through
  `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`.
- Production participation is checked server-side with Discord's Activity
  Instance API.
- Optional Discord proxy request signatures can be required and validated.
- Non-HTML assets are cache-busted and served with `Cache-Control: no-store`.
- Secure Activity session cookies use `SameSite=None; Secure; Partitioned`.

Useful Discord docs:

- https://docs.discord.com/developers/activities/building-an-activity
- https://docs.discord.com/developers/activities/development-guides/networking
- https://docs.discord.com/developers/activities/development-guides/multiplayer-experience
- https://docs.discord.com/developers/activities/development-guides/production-readiness

## Requirements

- Node.js 20 or newer.
- A built C++ engine binary, usually `../build/baloot-server` from this folder.
- For production: Discord application credentials, a public HTTPS Activity URL,
  and a Developer Portal URL mapping.

No npm packages are required at runtime. The browser SDK is vendored under
`client/vendor/discord-embedded-app-sdk/`.

## Folder Map

- `client/index.html`: Activity UI shell.
- `client/main.js`: Discord SDK auth, SSE connection, rendering, and actions.
- `client/styles.css`: Activity layout and controls.
- `client/vendor/discord-embedded-app-sdk/`: vendored SDK ESM bundle.
- `server/index.js`: HTTP server, auth routes, static serving, SSE, actions.
- `server/room.js`: lobby, spectators, engine lifecycle, validation, snapshots.
- `server/engine-client.js`: TCP client for one engine seat.
- `server/protocol.js`: length-prefixed engine frame helpers.
- `server/turn-tracker.js`: maps engine actions to the current human turn.
- `server/preflight.js`: local config validation.
- `server/deploy-check.js`: public Activity surface verification.
- `server/entrypoint-command.js`: Discord Entry Point command verifier/creator.
- `server/readiness.js`: combined preflight, deployment, and Entry Point gate.
- `server/*.test.js`: Node test suite and real-engine smoke coverage.

## How It Works

1. The client boots inside Discord and creates `new DiscordSDK(DISCORD_CLIENT_ID)`.
2. The client uses `discordSdk.instanceId` as the Activity room id.
3. The client requests an OAuth code through the SDK `authorize` command.
4. `POST /api/token` exchanges that code, fetches `/users/@me`, verifies the
   user is inside the Activity instance, and returns an Activity session.
5. The server also sets an HttpOnly `baloot_activity_session` cookie for
   same-origin `/api/events` and `/api/action` calls. The client keeps the signed
   session token as a fallback for EventSource contexts where cookies are not
   available.
6. `GET /api/events` opens an SSE stream and seats the user if a player seat is
   available.
7. When four connected players are seated, the server revalidates those four
   Discord users against the Activity Instance API.
8. The backend spawns `baloot-server --matches 1` and opens four TCP proxy
   clients, one for each player seat.
9. Engine private deal frames update only the owning player's hand. Public
   engine actions are broadcast to all connected clients.
10. `POST /api/action` accepts only the current seated player's legal action and
    forwards it to the engine.

Spectators receive snapshots but have no hand and cannot submit actions.
Disconnected in-match players get a short reconnect grace period; if they do not
return, their engine proxy seat is closed and the engine resolves the match as a
forfeit. No replacement bot move is generated.

## Local Development

Build the engine from the repository root:

```sh
cmake -S . -B build
cmake --build build --parallel
```

Start the Activity backend in local mock mode:

```sh
cd activity
cp .env.example .env
npm run dev
```

Open four browser profiles or tabs with different names:

```text
http://127.0.0.1:3000/?mock=1&room=dev&name=Player-1
http://127.0.0.1:3000/?mock=1&room=dev&name=Player-2
http://127.0.0.1:3000/?mock=1&room=dev&name=Player-3
http://127.0.0.1:3000/?mock=1&room=dev&name=Player-4
```

Open a fifth URL with the same `room` to verify spectator behavior.

Local mock mode is intentionally insecure. Keep
`ACTIVITY_ALLOW_INSECURE_DEV=1` only for local browser testing.

## Discord Setup

1. Create a Discord application.
2. Enable Activities in the Developer Portal.
3. Add a placeholder OAuth2 redirect URI, such as `https://127.0.0.1`.
4. Add an Activity URL Mapping that maps `/` to the public HTTPS origin serving
   this backend.
5. Copy `.env.example` to `.env` or set equivalent deployment environment
   variables.
6. Set `ACTIVITY_ALLOW_INSECURE_DEV=0` in production.
7. Set:

```sh
DISCORD_CLIENT_ID=your_application_id
DISCORD_CLIENT_SECRET=your_oauth_client_secret
DISCORD_BOT_TOKEN=your_bot_token_for_activity_instance_checks
ACTIVITY_SESSION_SECRET=a-long-random-secret-at-least-32-chars
ACTIVITY_PUBLIC_URL=https://your-public-activity-origin.example
BALOOT_SERVER_BIN=../build/baloot-server
```

Recommended:

```sh
DISCORD_PROXY_PUBLIC_KEY=your_application_public_key
ACTIVITY_HOST=0.0.0.0
```

`DISCORD_PROXY_PUBLIC_KEY` enables optional Discord proxy request signature
verification on Activity API requests.

## Production Runbook

From `activity/`:

```sh
npm run preflight
npm start
```

After the backend is reachable through the Developer Portal URL mapping:

```sh
npm run verify:deploy -- --url "$ACTIVITY_PUBLIC_URL"
npm run verify:entrypoint
npm run verify:ready
```

If proxy request signatures are enabled, direct non-Discord requests to
`/api/config` should fail with `401`. Use:

```sh
npm run verify:deploy -- --url "$ACTIVITY_PUBLIC_URL" --allow-signed-api
npm run verify:ready -- --allow-signed-api
```

If Activities are enabled but the global Entry Point command is missing, create
one with Discord's launch handler:

```sh
npm run verify:entrypoint -- --create
```

Use `npm run verify:ready -- --create-entrypoint` only when you want the
readiness command to create that missing Entry Point command through Discord's
API.

## Environment Variables

- `DISCORD_CLIENT_ID`: Discord application/client id. Required in production.
- `DISCORD_CLIENT_SECRET`: OAuth client secret. Required in production.
- `DISCORD_BOT_TOKEN`: bot token used for Activity Instance API checks.
  Required in production.
- `DISCORD_PROXY_PUBLIC_KEY`: optional 64-character hex public key from the
  Developer Portal. `DISCORD_APPLICATION_PUBLIC_KEY` is accepted as an alias.
- `DISCORD_API_BASE_URL`: optional override for tests; defaults to
  `https://discord.com/api/v10`.
- `ACTIVITY_SESSION_SECRET`: signing key for Activity sessions. Production must
  use a long random value.
- `ACTIVITY_PUBLIC_URL`: public HTTPS Activity origin used for URL parsing,
  checks, and secure cookie mode.
- `ACTIVITY_HOST`: bind address. Use `127.0.0.1` locally and usually `0.0.0.0`
  in containers or behind a reverse proxy.
- `ACTIVITY_PORT`: HTTP port. Default `3000`.
- `ACTIVITY_ALLOW_INSECURE_DEV`: `1` enables local mock users; use `0` in
  production.
- `ACTIVITY_ASSET_VERSION`: optional JS/CSS cache-busting value. If omitted, the
  server generates one at startup.
- `ACTIVITY_DISCONNECT_GRACE_MS`: reconnect grace period for seated in-match
  players. Default `10000`.
- `ACTIVITY_SSE_HEARTBEAT_MS`: SSE keepalive interval. Default `25000`; set `0`
  to disable.
- `BALOOT_SERVER_BIN`: path to `baloot-server`. Relative paths are resolved from
  common launch locations.
- `BALOOT_TARGET_SCORE`: match target score passed to the engine. Default `152`.
- `BALOOT_READ_TIMEOUT_MS`: engine read timeout. Default `900000`.

## Commands

- `npm run dev`: load `.env`, force local mock mode if unset, start the server.
- `npm start`: load `.env` and start the server.
- `npm run preflight`: validate local runtime configuration.
- `npm run verify:deploy -- --url <url>`: verify public HTML, assets, SDK, API
  health, cache headers, and production flags.
- `npm run verify:entrypoint`: verify the Discord global Entry Point command.
- `npm run verify:ready`: run preflight, deployment, and Entry Point checks.
- `npm test`: run all Activity server tests.

The scripts are thin wrappers around `node server/*.js`, so they also work
directly without npm.

## Verification

Run this before pushing Activity changes:

```sh
npm test
```

Useful targeted checks:

```sh
node --check client/main.js
node --check server/index.js
node --test server/config.test.js
node --test server/activity-smoke.test.js
```

The test suite covers:

- Four-player-only match start.
- Extra users becoming spectators.
- Spectator action rejection.
- Current-turn enforcement.
- No bot fallback moves.
- Disconnect forfeit behavior.
- Activity Instance API gating and revalidation.
- Discord proxy signature validation.
- Same-origin API and legacy `/.proxy/api/*` compatibility.
- Vendored SDK serving and cache headers.
- Deployment/readiness verifiers.

## Troubleshooting

- `Missing or invalid Activity session`: in production, the client must complete
  Discord SDK OAuth and `/api/token` before opening events or actions.
- `Discord Activity instance verification failed`: the user/session is not
  present in the active Discord Activity instance, the instance id is wrong, or
  `DISCORD_BOT_TOKEN` cannot read the Activity Instance API.
- `proxy request verification failed`: proxy signatures are enabled, but the
  request did not come through Discord's signed proxy or the public key is wrong.
- Match never starts: confirm four connected users are in the same `instanceId`
  and that readiness checks pass with production credentials.
- Engine spawn errors: run `npm run preflight` and confirm `BALOOT_SERVER_BIN`
  points to a built executable for the current OS.
- Stale JS/CSS after deploy: set `ACTIVITY_ASSET_VERSION` to a new value or
  restart the backend so it injects a fresh generated value.

## Security Notes

- Do not trust client-provided user or room values in production. The production
  path uses signed sessions, Discord OAuth, and Activity Instance API checks.
- Keep `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, and
  `ACTIVITY_SESSION_SECRET` out of version control.
- Keep `ACTIVITY_ALLOW_INSECURE_DEV=0` in production.
- Enable `DISCORD_PROXY_PUBLIC_KEY` when the deployment should require Discord
  proxy authentication headers.
- Serve the public Activity URL over HTTPS.
