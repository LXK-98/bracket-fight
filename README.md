# 🥊 Image Bracket

A self-hosted, real-time party game. Players join from their phones by scanning a QR code and submit an entry (an image, a text, or both). The entries then battle head-to-head in a single-elimination bracket on a shared main screen, and everyone votes on their own phone.

- **Main screen** (TV or laptop): room code and QR code, lobby, settings, matchups with a big countdown, winner reveal, bracket overview, and the champion. Includes a full-screen button and sound effects you can turn off.
- **Phones**: join with a name, pick **Compete** or **Just vote**, submit an entry (camera or gallery), vote by tapping, and always see what is going on ("Your entry is up!", "You've been eliminated", …).

## Contents

- [Architecture](#architecture)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Running with Docker](#running-with-docker)
- [Deploying](#deploying)
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
| `HOST_PASSWORD` | *(empty)* | If set, creating a room requires this password. Joining a room never does. Empty = anyone can create rooms. |
| `TRUST_PROXY` | `1` | How many reverse proxies sit in front of the app (Express `trust proxy`). `1` = one proxy (the usual setup); `2` if another layer such as a CDN sits in front of it; or a list of trusted IPs/subnets. Used to find the real client IP for rate limits. |
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

Or with Compose: `docker compose -f docker-compose.yml -f docker-compose.local.yml up --build`. The `.local.yml` override publishes port 3000 on your machine. The base `docker-compose.yml` intentionally publishes no host ports, because in production a reverse proxy handles routing.

The image is multi-stage (`node:22-alpine`), runs as the non-root `node` user, `EXPOSE`s 3000, declares `/data` as a volume, and has a `HEALTHCHECK` against `GET /health`.

## Deploying

The app is a single Docker container. It runs on any host or platform that can build a `Dockerfile` (or run `docker-compose.yml`) behind an HTTPS reverse proxy. What it needs:

1. **The container**, built from the `Dockerfile` at the repository root. It listens on port `3000`.
2. **A reverse proxy** in front that terminates HTTPS and routes your domain (e.g. `bracket.example.com`) to port 3000. It must:
   - pass WebSocket upgrades through (Socket.IO uses them; it falls back to long polling otherwise),
   - forward the original `Host` (or `X-Forwarded-Host`) and `X-Forwarded-Proto`, so join links come out as `https://your-domain/…`,
   - allow request bodies of at least `MAX_UPLOAD_MB` (default 5 MB) for image uploads.

   Most container platforms and Traefik/Caddy do this out of the box; nginx needs the config below.
3. **A persistent volume on `/data`** for uploaded images (`docker-compose.yml` declares one).
4. **Environment variables** (see the table above):
   - `PUBLIC_URL=https://bracket.example.com` (recommended, so QR codes always use the public domain no matter how the proxy behaves),
   - optionally `HOST_PASSWORD` (see [Restricting room creation](#restricting-room-creation)),
   - `TRUST_PROXY` matching the number of proxies in front of the app (the default `1` fits a single proxy).
5. Optionally a **health check** on `GET /health` (the Dockerfile already declares one).

Then open the domain, click **Create room**, and scan the QR code with a phone.

### Example: nginx

Run the container with the port bound to localhost only, e.g. `docker run -d -p 127.0.0.1:3000:3000 -v image-bracket-data:/data -e PUBLIC_URL=https://bracket.example.com image-bracket`, and add a server block like this (TLS settings omitted):

```nginx
server {
    server_name bracket.example.com;
    client_max_body_size 6m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Example: Coolify

- **Dockerfile build pack:** create a resource from the Git repository with the **Dockerfile** build pack, set **Ports Exposes** to `3000` (no port mappings), enter your domain, add the environment variables, and add a **Volume Mount** with destination `/data`.
- **Docker Compose build pack:** point it at `docker-compose.yml`. The `SERVICE_FQDN_APP_3000` line makes Coolify generate a domain for the service, and `PUBLIC_URL` defaults to that domain unless you set your own. The compose file already declares the `/data` volume.

### Restricting room creation

By default anyone who can reach the site can create a room. Set `HOST_PASSWORD` to require a password for that:

- The home page shows a password field next to **Create room**. Joining a room (by QR code or room code) never asks for it, so guests are unaffected.
- It is a single shared password, not user accounts. Anyone who knows it can host.
- After 10 wrong attempts from one IP address, that address must wait 15 minutes. This relies on the real client IP, so keep `TRUST_PROXY` matched to your proxy setup (the default `1` means one proxy in front).
- Change the password by updating the variable and redeploying. Running rooms are not affected.

### Notes

- **Run a single instance only** (no horizontal scaling or replicas). Rooms live in the memory of one process. A redeploy or restart ends any running games, though images on `/data` are cleaned up automatically.
- The app trusts `X-Forwarded-*` headers from one proxy hop (`TRUST_PROXY=1`). Don't expose the container port directly to the internet without a proxy in front.
- If you use a **bind mount** instead of a volume for `/data`, make sure the folder on the host is writable by UID 1000 (`chown -R 1000:1000 /path/on/host`).

## How the game works

1. **Create room** on the main screen (with the host password, if `HOST_PASSWORD` is set). It shows the room code and a big QR code linking to `/join/<CODE>`.
2. Players enter a unique name. Their identity is a session token in `localStorage`, so refreshes and reconnects keep their name, entry and votes.
3. Each player picks **Compete** (and submits an entry) or **Just vote**. Entries and roles can be changed until the game starts.
4. The host adjusts the settings (max entries, vote timer, entry type, live vote counts, self-voting, tie-break) and presses **Start**. Start stays disabled, with the reason shown, until at least 2 competitors have entered and every competitor has submitted.
5. **Bracket**: the size is the next power of two, capped at the max. When the bracket is full, new players can only vote. Byes are shown as "advances automatically".
6. **Each match**: both entries and a countdown appear on the TV, and everyone taps a favourite on their phone. Votes can be changed until time runs out, and voting closes early once everyone has voted. The TV then reveals the winner with the vote split, holds about 5 s, and shows the bracket overview before the next match.
7. **Ties** are broken by a 10 s sudden-death revote and then at random (default), at random immediately, or by the host.
8. **Host controls**: pause/resume (Space), skip timer, next (N), full screen (F), kick players, and remove an entry mid-game (its opponent advances). A competitor who disconnects stays in the bracket.
9. **End**: the champion is shown big along with the full bracket. **Play again** keeps the room, players and settings, clears the entries, and sends everyone back to choosing a role.

### Abuse protection

- Optional host password for room creation (`HOST_PASSWORD`), compared in constant time, with a lockout after 10 wrong attempts per IP.
- Rate limits: room creation per IP, joins and uploads per room, uploads per player, and socket events per connection.
- Names and texts are sanitized (control and zero-width characters stripped, whitespace collapsed, length-capped) and always rendered as text, never HTML.
- Uploads are validated by magic bytes and size, stored under random file names, and served with `X-Content-Type-Options: nosniff`.

## Limitations

- **Single instance, in-memory state.** Restarting the server ends all running rooms. Scaling out would need a shared store (e.g. Redis) and the Socket.IO Redis adapter.
- Animated GIFs are re-encoded to a still image on upload.
