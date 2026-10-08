# 🥊 Image Bracket

A self-hosted, real-time party game. Players join from their phones by scanning a QR code and submit an entry (an image, a text, or both). The entries then battle head-to-head in a single-elimination bracket on a shared main screen, and everyone votes on their own phone.

- **Main screen** (TV or laptop): room code and QR code, lobby, settings, matchups with a big countdown, winner reveal, bracket overview, and the champion. Includes a full-screen button and sound effects you can turn off.
- **Phones**: join with a name, pick **Compete** or **Just vote**, submit an entry (camera or gallery), vote by tapping, and always see what is going on ("Your entry is up!", "You've been eliminated", …).

## Contents

- [Architecture](#architecture)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Running with Docker](#running-with-docker)
- [Deploying on Coolify](#deploying-on-coolify)
- [How the game works](#how-the-game-works)
- [Limitations](#limitations)

## Architecture

```
client/  React + Vite SPA (home, host/main screen, player/phone views)
server/  Node.js + Express + Socket.IO (one port for HTTP and WebSockets)
shared/  Types and the pure bracket logic, used by the server and the tests
tests/   Vitest: bracket unit tests, game-engine tests, end-to-end socket test
```

- **The server is authoritative.** All game state and timers live on the server. Clients only render the state they receive and send actions. Every socket gets a view tailored to it: in the lobby, phones see only their own entry, and vote counts stay hidden until the reveal when live counts are off.
- **Real time** runs over Socket.IO on the same origin and port as the HTTP app. Countdowns are drawn on the client from the server's `phaseEndsAt` plus a clock offset, so the server never needs to send ticks.
- **State** for active rooms lives in memory. Uploaded images are stored on disk under `$DATA_DIR/rooms/<CODE>/`. Rooms and their images are deleted after `ROOM_TTL_HOURS` without activity (default 6 h). Leftover image folders are removed on startup, because the rooms they belonged to died with the previous process.
- **Images** are downscaled in the browser to a 1600 px longest edge and re-encoded as WebP (JPEG on Safari). That also strips EXIF/GPS data. iPhone HEIC photos are decoded natively where the browser can, otherwise by a lazy-loaded `heic2any` fallback. The server enforces `MAX_UPLOAD_MB` and checks the file's magic bytes; only JPEG, PNG, WebP and GIF are accepted.

### Room and game state model

```ts
Room {
  code, hostToken, settings, phase,               // phase: lobby → overview → voting ⇄ tiebreak → reveal → … → finished
  players: Map<id, { id, name, role, token, connections, entryId }>,   // role: undecided | competitor | voter
  entries: Map<id, { id, playerId, ownerName, text, imageFile }>,
  bracket: { size, rounds: Match[][], removed: entryId[] } | null,
  currentMatchId, nextMatchId, votes: Map<playerId, 'a' | 'b'>, suddenDeath,
  phaseEndsAt, pausedRemainingMs, lastActivity
}
Match { id, round, index, a, b, bye, winner, votesA, votesB, decidedBy }
// decidedBy: votes | suddenDeath | random | host | forfeit | bye
Settings { maxEntries: 4|8|16|32|'auto', voteSeconds, entryMode: image|text|imageOrText,
           showLiveVotes, allowSelfVote, tieBreak: random|host|suddenDeath }
```

The bracket logic in `shared/bracket.ts` is pure (no I/O, never mutates its input) and fully unit-tested. Entries are shuffled into random seeds and placed using standard tournament seeding (1 v 8, 4 v 5, …). With *N* entries in a bracket of size *S*, the top *S − N* seeds get byes. As a result, byes never meet each other, they are spread evenly across every half and quarter of the bracket, and round 2 is always a clean power of two.

## Local development

Requires Node.js 20 or newer (22 recommended).

```bash
npm install
cp .env.example .env   # optional
npm run dev            # API/WebSocket server on :3000, Vite dev server on :5173
```

Open <http://localhost:5173>. Vite proxies `/api`, `/uploads`, `/health` and `/socket.io` to the backend. To join from phones on the same Wi-Fi, open the host screen through your computer's LAN IP (e.g. `http://192.168.1.20:5173`), so the QR code points somewhere the phones can reach.

| Script | What it does |
| --- | --- |
| `npm run dev` | Server (`tsx watch`) and client (Vite) with hot reload |
| `npm run build` | Builds the client into `dist/client` and bundles the server into `dist/server.js` |
| `npm start` | Runs the production build (serves the SPA and the API on `PORT`) |
| `npm test` | Runs all tests (bracket logic, game engine, end-to-end over sockets) |
| `npm run typecheck` | Type-checks everything with `tsc` |

To run locally without Docker in production mode: `npm run build && npm start`, then open <http://localhost:3000>.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Port for HTTP and WebSockets |
| `PUBLIC_URL` | *(empty)* | Base URL for the QR code and join link, e.g. `https://bracket.example.com`. A bare domain gets `https://` added. If empty, the URL is derived from the request (honouring `X-Forwarded-Proto` / `X-Forwarded-Host`). |
| `DATA_DIR` | `/data` (prod), `./data` (dev) | Where uploaded images are stored |
| `ROOM_TTL_HOURS` | `6` | Delete rooms (and images) after this long without activity |
| `MAX_UPLOAD_MB` | `5` | Server-side size limit per image |
| `MAX_ROOMS` | `200` | Maximum concurrent rooms |
| `MAX_PLAYERS_PER_ROOM` | `100` | Maximum players per room |
| `REVEAL_MS` | `5000` | How long the winner reveal is shown |
| `OVERVIEW_MS` | `4000` | How long the bracket overview is shown between matches |

## Running with Docker

```bash
docker build -t image-bracket .
docker run -p 3000:3000 -v image-bracket-data:/data image-bracket
```

Or with Compose: `docker compose -f docker-compose.yml -f docker-compose.local.yml up --build`. The `.local.yml` override publishes port 3000 on your machine. The base `docker-compose.yml` intentionally publishes no host ports, because on Coolify the proxy handles routing.

The image is multi-stage (`node:22-alpine`), runs as the non-root `node` user, `EXPOSE`s 3000, declares `/data` as a volume, and has a `HEALTHCHECK` against `GET /health`.

## Deploying on Coolify

### Option A: Dockerfile build pack (recommended)

1. **Push this repository** to GitHub, GitLab, or any Git host Coolify can reach.
2. In Coolify, open your project and environment, then choose **+ New → Resource**.
3. Pick **Public Repository** (paste the URL) or **Private Repository (with GitHub App / Deploy Key)**, and select the branch.
4. Set **Build Pack** to **Dockerfile**. The Dockerfile is at the repository root (`/Dockerfile`).
5. Under **Network**, set **Ports Exposes** to `3000`. Leave **Ports Mappings** empty, since Coolify's proxy routes traffic to the container.
6. Under **General → Domains**, enter your domain, e.g. `https://bracket.example.com`. Point the domain's DNS A/AAAA record at your Coolify server. Coolify's proxy (Traefik/Caddy) requests the HTTPS certificate automatically, and WebSockets work through it without extra configuration.
7. Under **Environment Variables**, add:
   - `PUBLIC_URL=https://bracket.example.com` (recommended, so QR codes always use the public domain)
   - optionally `ROOM_TTL_HOURS`, `MAX_UPLOAD_MB`, … (see the table above)
8. Under **Persistent Storage**, choose **+ Add → Volume Mount**, give it a name (e.g. `image-bracket-data`) and set **Destination Path** to `/data`. This keeps uploaded images across redeploys.
9. Optional: under **Health Checks**, enable it with path `/health` and port `3000`. The Dockerfile already includes a `HEALTHCHECK`.
10. Click **Deploy**. When it finishes, open the domain, click **Create room**, and scan the QR code with a phone.

### Option B: Docker Compose build pack

1. Create a new resource from the repository as above, but set **Build Pack** to **Docker Compose**, with the compose file at `/docker-compose.yml`.
2. Coolify reads `SERVICE_FQDN_APP_3000` and generates a domain that routes to port 3000. You can change it under the `app` service's **Domains** setting. `PUBLIC_URL` defaults to `${SERVICE_FQDN_APP}`; the server adds `https://` when the value has no scheme.
3. The named volume `bracket-data` is mounted at `/data` and Coolify keeps it across redeploys.
4. Adjust the other variables (`ROOM_TTL_HOURS`, `MAX_UPLOAD_MB`, …) in Coolify's **Environment Variables** tab, then **Deploy**.

### Notes

- **Run a single instance only** (no horizontal scaling or replicas). Rooms live in the memory of one process. A redeploy or restart ends any running games, though images on `/data` are cleaned up automatically.
- `trust proxy` is enabled, so the app trusts `X-Forwarded-*` headers from Coolify's proxy. Don't expose the container port directly to the internet without a proxy in front.
- If you use a **bind mount** instead of a volume for `/data`, make sure the folder on the host is writable by UID 1000 (`chown -R 1000:1000 /path/on/host`).

## How the game works

1. **Create room** on the main screen. It shows the room code and a big QR code linking to `/join/<CODE>`.
2. Players enter a unique name. Their identity is a session token in `localStorage`, so refreshes and reconnects keep their name, entry and votes.
3. Each player picks **Compete** (and submits an entry) or **Just vote**. Entries and roles can be changed until the game starts.
4. The host adjusts the settings (max entries, vote timer, entry type, live vote counts, self-voting, tie-break) and presses **Start**. Start stays disabled, with the reason shown, until at least 2 competitors have entered and every competitor has submitted.
5. **Bracket**: the size is the next power of two, capped at the max. When the bracket is full, new players can only vote. Byes are shown as "advances automatically".
6. **Each match**: both entries and a countdown appear on the TV, and everyone taps a favourite on their phone. Votes can be changed until time runs out, and voting closes early once everyone has voted. The TV then reveals the winner with the vote split, holds about 5 s, and shows the bracket overview before the next match.
7. **Ties** are broken by a 10 s sudden-death revote and then at random (default), at random immediately, or by the host.
8. **Host controls**: pause/resume (Space), skip timer, next (N), full screen (F), kick players, and remove an entry mid-game (its opponent advances). A competitor who disconnects stays in the bracket.
9. **End**: the champion is shown big along with the full bracket. **Play again** keeps the room, players and settings, clears the entries, and sends everyone back to choosing a role.

### Abuse protection

- Rate limits: room creation per IP, joins and uploads per room, uploads per player, and socket events per connection.
- Names and texts are sanitized (control and zero-width characters stripped, whitespace collapsed, length-capped) and always rendered as text, never HTML.
- Uploads are validated by magic bytes and size, stored under random file names, and served with `X-Content-Type-Options: nosniff`.

## Limitations

- **Single instance, in-memory state.** Restarting the server ends all running rooms. Scaling out would need a shared store (e.g. Redis) and the Socket.IO Redis adapter.
- Animated GIFs are re-encoded to a still image on upload.
