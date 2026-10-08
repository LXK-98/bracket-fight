import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { io as connect } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { parseTrustProxy, type Config } from '../server/config';

const cleanups: Array<() => Promise<void>> = [];

async function start(hostPassword: string | null) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bracket-auth-'));
  const config: Config = {
    port: 0,
    publicUrl: null,
    hostPassword,
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
  const ctx = await createApp(config);
  await new Promise<void>((r) => ctx.server.listen(0, r));
  const base = `http://127.0.0.1:${(ctx.server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    ctx.rooms.stop();
    ctx.io.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return base;
}

afterAll(async () => {
  for (const c of cleanups) await c();
});

function createRoom(base: string, body?: object, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

describe('room creation without HOST_PASSWORD', () => {
  it('is open to everyone', async () => {
    const base = await start(null);
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ createRequiresPassword: false });
    expect((await fetch(`${base}/api/rooms`, { method: 'POST' })).status).toBe(200);
  });
});

describe('room creation with HOST_PASSWORD', () => {
  const PASSWORD = 'party time!';
  let base = '';

  it('advertises that a password is required', async () => {
    base = await start(PASSWORD);
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ createRequiresPassword: true });
  });

  it('rejects a missing or wrong password', async () => {
    const missing = await createRoom(base);
    expect(missing.status).toBe(401);
    expect((await missing.json()).error).toMatch(/required/);
    const wrong = await createRoom(base, { password: 'party time' });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toMatch(/Wrong/);
  });

  it('creates a room with the right password; joining needs no password', async () => {
    const res = await createRoom(base, { password: PASSWORD });
    expect(res.status).toBe(200);
    const { code } = await res.json();
    expect((await fetch(`${base}/api/rooms/${code}`)).status).toBe(200);

    const socket = connect(base, { transports: ['websocket'], forceNew: true });
    const joined = await new Promise<{ ok: boolean }>((r) => socket.emit('player:join', { code, name: 'Guest' }, r));
    socket.close();
    expect(joined.ok).toBe(true);
  });

  // These requests pretend to arrive through one reverse proxy, which appends
  // the real client address to X-Forwarded-For.
  const ATTACKER = '198.51.100.20';

  it('locks out an IP after 10 wrong passwords', async () => {
    const via = { 'X-Forwarded-For': ATTACKER };
    for (let i = 0; i < 10; i++) expect((await createRoom(base, { password: `guess ${i}` }, via)).status).toBe(401);
    const locked = await createRoom(base, { password: PASSWORD }, via);
    expect(locked.status).toBe(429);
    // Another client IP is unaffected.
    const other = await createRoom(base, { password: PASSWORD }, { 'X-Forwarded-For': '203.0.113.7' });
    expect(other.status).toBe(200);
  });

  it('cannot be bypassed by spoofing X-Forwarded-For', async () => {
    // The attacker prepends a fake address; the proxy appends the real one.
    const spoofed = await createRoom(base, { password: PASSWORD }, { 'X-Forwarded-For': `192.0.2.99, ${ATTACKER}` });
    expect(spoofed.status).toBe(429);
  });

  it('rejects malformed JSON as a bad request', async () => {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Bad request.');
  });
});

describe('parseTrustProxy', () => {
  it('defaults to one hop and accepts counts, booleans and address lists', () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy('')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});
