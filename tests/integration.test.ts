import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import type { Config } from '../server/config';
import type { RoomView } from '../shared/types';

let base = '';
let dataDir = '';
let ctx: Awaited<ReturnType<typeof createApp>>;
const sockets: Socket[] = [];

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bracket-'));
  const config: Config = {
    port: 0,
    publicUrl: null,
    hostPassword: null,
    trustProxy: 1,
    dataDir,
    roomTtlMs: 60_000,
    maxUploadBytes: 64 * 1024,
    maxRooms: 10,
    maxPlayersPerRoom: 20,
    revealMs: 50,
    overviewMs: 50,
    clientDir: path.join(dataDir, 'no-client'),
  };
  ctx = await createApp(config);
  await new Promise<void>((r) => ctx.server.listen(0, r));
  base = `http://127.0.0.1:${(ctx.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  ctx.rooms.stop();
  ctx.io.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

function client() {
  const s = connect(base, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  let latest: RoomView | null = null;
  const waiters: Array<{ pred: (v: RoomView) => boolean; resolve: (v: RoomView) => void }> = [];
  s.on('state', (v: RoomView) => {
    latest = v;
    for (const w of [...waiters]) {
      if (w.pred(v)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(v);
      }
    }
  });
  return {
    socket: s,
    emit<T = Record<string, unknown>>(event: string, payload: object = {}): Promise<T & { ok: boolean; error?: string }> {
      return new Promise((resolve) => s.emit(event, payload, resolve));
    },
    until(pred: (v: RoomView) => boolean, ms = 3000): Promise<RoomView> {
      if (latest && pred(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for state')), ms);
        waiters.push({ pred, resolve: (v) => (clearTimeout(t), resolve(v)) });
      });
    },
  };
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function submit(code: string, token: string, fields: Record<string, string>, image?: Buffer) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (image) form.append('image', new Blob([new Uint8Array(image)]), 'x.png');
  const res = await fetch(`${base}/api/rooms/${code}/entry`, {
    method: 'POST',
    headers: { 'x-player-token': token },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
}

describe('server', () => {
  it('serves /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('plays a full game over sockets', async () => {
    const created = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
    const code: string = created.code;
    expect(code).toMatch(/^[A-Z]{4}$/);

    const info = await (
      await fetch(`${base}/api/rooms/${code.toLowerCase()}/join-info`, { headers: { 'x-forwarded-proto': 'https' } })
    ).json();
    expect(info.joinUrl).toMatch(new RegExp(`^https://127\\.0\\.0\\.1:\\d+/join/${code}$`));
    expect(info.qrSvg).toContain('<svg');

    // A reverse proxy that rewrites Host still yields the public address.
    const proxied = await (
      await fetch(`${base}/api/rooms/${code}/join-info`, {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'bracket.example.com' },
      })
    ).json();
    expect(proxied.joinUrl).toBe(`https://bracket.example.com/join/${code}`);

    const host = client();
    expect((await host.emit('host:attach', { code, hostToken: 'wrong' })).ok).toBe(false);
    expect((await host.emit('host:attach', { code, hostToken: created.hostToken })).ok).toBe(true);
    await host.emit('host:settings', { tieBreak: 'random', voteSeconds: 5 });

    const alice = client();
    const a = await alice.emit<{ token: string }>('player:join', { code, name: 'Alice' });
    expect(a.ok).toBe(true);
    const bob = client();
    expect(await bob.emit('player:join', { code, name: 'alice' })).toEqual({
      ok: false,
      code: 'nameTaken',
      error: 'That name is already taken in this room.',
    });
    const b = await bob.emit<{ token: string }>('player:join', { code, name: 'Bob' });
    const carol = client();
    await carol.emit('player:join', { code, name: 'Carol' });

    await alice.emit('player:setRole', { role: 'competitor' });
    await bob.emit('player:setRole', { role: 'competitor' });
    await carol.emit('player:setRole', { role: 'voter' });

    // Upload validation
    expect((await submit(code, 'bogus', { text: 'x' })).status).toBe(401);
    expect((await submit(code, a.token, {}, Buffer.from('not an image at all'))).status).toBe(415);
    const tooBig = await submit(code, a.token, {}, Buffer.alloc(70 * 1024, 0xff));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toMatchObject({ code: 'imageTooLarge', params: { mb: '0' } });

    let hv = await host.until((v) => v.lobby.competitorCount === 2);
    expect(hv.lobby.canStart).toBe(false);
    expect(await host.emit('host:start')).toMatchObject({
      ok: false,
      code: 'waitingForEntries',
      params: { count: 2 },
      error: 'Waiting for 2 competitors to submit an entry.',
    });

    expect((await submit(code, a.token, { text: 'Cats <b>rule</b>' }, PNG)).status).toBe(200);
    expect((await submit(code, b.token, { text: 'Dogs' })).status).toBe(200);

    const av = await alice.until((v) => !!v.me?.submitted);
    const imageUrl = av.me!.entry!.imageUrl!;
    expect(imageUrl).toMatch(new RegExp(`^/uploads/${code}/.+\\.png$`));
    const img = await fetch(base + imageUrl);
    expect(img.status).toBe(200);
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);

    hv = await host.until((v) => v.lobby.canStart);
    expect(Object.keys(hv.entries)).toHaveLength(0); // secret until start

    // Reconnect with the token keeps identity.
    alice.socket.close();
    const alice2 = client();
    const resumed = await alice2.emit<{ playerId: string }>('player:resume', { code, token: a.token });
    expect(resumed.ok).toBe(true);

    expect((await host.emit('host:start')).ok).toBe(true);
    const voting = await carol.until((v) => v.phase === 'voting');
    expect(Object.keys(voting.entries)).toHaveLength(2);
    const aliceEntry = Object.values(voting.entries).find((e) => e.ownerName === 'Alice')!;
    const side = voting.match!.a === aliceEntry.id ? 'a' : 'b';

    expect((await carol.emit('player:vote', { matchId: voting.match!.matchId, side })).ok).toBe(true);
    await alice2.emit('player:vote', { matchId: voting.match!.matchId, side });
    await bob.emit('player:vote', { matchId: voting.match!.matchId, side: side === 'a' ? 'b' : 'a' });

    // Everyone voted -> closes early, reveals, then finishes (2 entries = 1 match).
    const reveal = await host.until((v) => v.phase === 'reveal');
    expect(reveal.match!.winner).toBe(side);
    expect(reveal.match![side === 'a' ? 'votesA' : 'votesB']).toBe(2);

    const done = await alice2.until((v) => v.phase === 'finished');
    expect(done.champion).toBe(aliceEntry.id);
    expect(done.me!.entryStatus).toBe('champion');

    // Kick and play again.
    const bobId = done.players.find((p) => p.name === 'Bob')!.id;
    const kicked = new Promise<void>((r) => bob.socket.once('kicked', () => r()));
    await host.emit('host:kick', { playerId: bobId });
    await kicked;
    expect((await bob.emit('player:resume', { code, token: b.token })).ok).toBe(false);

    await host.emit('host:playAgain');
    const lobby = await carol.until((v) => v.phase === 'lobby');
    expect(lobby.players.map((p) => p.role)).toEqual(['undecided', 'undecided']);
    expect(lobby.settings.voteSeconds).toBe(5);
    expect((await fetch(base + imageUrl)).status).toBe(404); // images cleaned up
  });

  it('rejects unknown rooms', async () => {
    const c = client();
    expect((await c.emit('player:join', { code: 'ZZZZ', name: 'x' })).error).toMatch(/not found/i);
    expect((await fetch(`${base}/api/rooms/ZZZZ`)).status).toBe(404);
  });
});
