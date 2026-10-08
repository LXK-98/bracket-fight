import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { Server, type Socket } from 'socket.io';
import { problem, type MessageCode, type MessageParams } from '../shared/messages';
import { normalizeCode } from '../shared/sanitize';
import type { Ack, AckError } from '../shared/types';
import type { Config } from './config';
import { RateLimiter } from './rateLimit';
import { GameError, type Room, type Viewer } from './room';
import { RoomManager } from './rooms';
import { Storage, detectImage } from './storage';

interface SocketData {
  code?: string;
  viewer?: Viewer;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppSocket = Socket<any, any, any, SocketData>;

const channel = (code: string) => `room:${code}`;

/** JSON error body: English `error` text plus `code`/`params` for clients to translate. */
function fail(res: Response, status: number, code: MessageCode, params?: MessageParams) {
  const p = problem(code, params);
  return res.status(status).json({ error: p.message, code, ...(params && { params }) });
}

function ackError(code: MessageCode, params?: MessageParams): AckError {
  return { ok: false, error: problem(code, params).message, code, ...(params && { params }) };
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
function safeEqual(a: string, b: string) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function createApp(config: Config) {
  const storage = new Storage(config.dataDir);
  await storage.init();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { serveClient: false, pingInterval: 10_000, pingTimeout: 8_000 });

  // ------------------------------------------------------------ broadcasting
  // Coalesce bursts of changes into one personalised state push per socket.
  const pending = new Set<string>();
  const flush = () => {
    for (const code of pending) {
      const room = rooms.get(code);
      const ids = io.sockets.adapter.rooms.get(channel(code));
      if (!room || !ids) continue;
      for (const sid of ids) {
        const s = io.sockets.sockets.get(sid) as AppSocket | undefined;
        if (s?.data.viewer) s.emit('state', room.view(s.data.viewer));
      }
    }
    pending.clear();
  };
  const onChange = (room: Room) => {
    if (pending.size === 0) setImmediate(flush);
    pending.add(room.code);
  };
  const onRemove = (room: Room) => {
    io.to(channel(room.code)).emit('roomClosed');
    io.in(channel(room.code)).socketsLeave(channel(room.code));
  };
  const rooms = new RoomManager(config, storage, onChange, onRemove);

  // ------------------------------------------------------------ rate limits
  const createLimiter = new RateLimiter(10, 60_000); // rooms per IP per minute
  const joinLimiter = new RateLimiter(60, 60_000); // joins per room per minute
  const uploadRoomLimiter = new RateLimiter(60, 60_000); // uploads per room per minute
  const uploadPlayerLimiter = new RateLimiter(10, 60_000); // uploads per player per minute
  const socketLimiter = new RateLimiter(30, 5_000); // events per socket
  const passwordFailLimiter = new RateLimiter(10, 15 * 60_000); // wrong host passwords per IP

  // ------------------------------------------------------------ HTTP
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ createRequiresPassword: config.hostPassword !== null });
  });

  app.post('/api/rooms', express.json({ limit: '2kb' }), (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (config.hostPassword !== null) {
      if (passwordFailLimiter.blocked(ip)) {
        return fail(res, 429, 'passwordLocked');
      }
      const given: unknown = req.body?.password;
      if (typeof given !== 'string' || given === '') {
        return fail(res, 401, 'passwordRequired');
      }
      if (!safeEqual(given, config.hostPassword)) {
        passwordFailLimiter.take(ip);
        return fail(res, 401, 'wrongPassword');
      }
    }
    if (!createLimiter.take(ip)) return fail(res, 429, 'tooManyRooms');
    try {
      const room = rooms.create();
      res.json({ code: room.code, hostToken: room.hostToken });
    } catch (err) {
      if (err instanceof GameError) return fail(res, 503, err.code, err.params);
      throw err;
    }
  });

  const roomFrom = (req: Request) => rooms.get(normalizeCode(req.params.code));

  app.get('/api/rooms/:code', (req, res) => {
    const room = roomFrom(req);
    if (!room) return fail(res, 404, 'roomNotFound');
    res.json({ code: room.code, phase: room.phase });
  });

  app.get('/api/rooms/:code/join-info', async (req, res) => {
    const room = roomFrom(req);
    if (!room) return fail(res, 404, 'roomNotFound');
    // Behind a reverse proxy (trust proxy is on) prefer the original host it forwards.
    const host = req.get('x-forwarded-host')?.split(',')[0].trim() || req.get('host');
    const base = config.publicUrl ?? `${req.protocol}://${host}`;
    const joinUrl = `${base}/join/${room.code}`;
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.json({ joinUrl, qrSvg });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, fieldSize: 4096, parts: 8 },
  }).single('image');

  app.post('/api/rooms/:code/entry', (req, res) => {
    const room = roomFrom(req);
    if (!room) return fail(res, 404, 'roomNotFound');
    const player = room.playerByToken(req.get('x-player-token'));
    if (!player) return fail(res, 401, 'unknownPlayer');
    if (!uploadRoomLimiter.take(room.code) || !uploadPlayerLimiter.take(player.id)) {
      return fail(res, 429, 'tooManyUploads');
    }
    upload(req, res, async (err: unknown) => {
      if (err) {
        const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
        const mb = (config.maxUploadBytes / 1024 / 1024).toFixed(0);
        return tooBig ? fail(res, 413, 'imageTooLarge', { mb }) : fail(res, 400, 'invalidUpload');
      }
      try {
        let imageFile: string | null = null;
        if (req.file) {
          const kind = detectImage(req.file.buffer);
          if (!kind) return fail(res, 415, 'unsupportedImage');
          if (room.phase !== 'lobby') throw new GameError('gameStarted');
          imageFile = await storage.saveImage(room.code, req.file.buffer, kind);
        }
        if (rooms.get(room.code) !== room) return fail(res, 404, 'roomNotFound');
        room.submitEntry(player.id, {
          text: req.body?.text ?? null,
          imageFile,
          removeImage: req.body?.removeImage === '1',
        });
        res.json({ ok: true });
      } catch (e) {
        if (e instanceof GameError) return fail(res, 400, e.code, e.params);
        console.error('entry upload failed', e);
        fail(res, 500, 'uploadFailed');
      }
    });
  });

  app.use(
    '/uploads',
    express.static(storage.roomsDir, { index: false, dotfiles: 'deny', maxAge: '1d', immutable: true, fallthrough: false }),
  );

  app.use('/api', (_req, res) => fail(res, 404, 'notFound'));

  // Frontend (production build). In dev, Vite serves it and proxies here.
  const indexHtml = path.join(config.clientDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.clientDir, { index: false, maxAge: '1h' }));
    app.use('/assets', (_req, res) => res.status(404).end());
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status >= 500) console.error(err);
    fail(res, status, status === 404 ? 'notFound' : status < 500 ? 'badRequest' : 'serverError');
  });

  // ------------------------------------------------------------ sockets
  function bind(socket: AppSocket, room: Room, viewer: Viewer) {
    unbind(socket);
    socket.data.code = room.code;
    socket.data.viewer = viewer;
    socket.join(channel(room.code));
    if (viewer.kind === 'player') room.connect(viewer.playerId);
    socket.emit('state', room.view(viewer));
  }

  function unbind(socket: AppSocket) {
    const { code, viewer } = socket.data;
    if (!code) return;
    const room = rooms.get(code);
    if (room && viewer?.kind === 'player') room.disconnect(viewer.playerId);
    socket.leave(channel(code));
    socket.data.code = undefined;
    socket.data.viewer = undefined;
  }

  type Handler<P> = (payload: P) => object | void;

  io.on('connection', (raw) => {
    const socket = raw as AppSocket;

    /** Wrap a handler: rate limiting, error reporting via ack. */
    const on = <P>(event: string, fn: Handler<P>) => {
      socket.on(event, ((payload: P, ack?: Ack) => {
        const reply: Ack = typeof ack === 'function' ? ack : () => {};
        if (!socketLimiter.take(socket.id)) return reply(ackError('slowDown'));
        try {
          reply({ ok: true, ...(fn((payload ?? {}) as P) || {}) });
        } catch (err) {
          if (err instanceof GameError) return reply(ackError(err.code, err.params));
          console.error(`socket ${event} failed`, err);
          reply(ackError('serverError'));
        }
      }) as never);
    };

    const requireRoom = (code: unknown) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) throw new GameError('roomNotFound');
      return room;
    };

    const current = () => {
      const room = socket.data.code ? rooms.get(socket.data.code) : undefined;
      if (!room || !socket.data.viewer) throw new GameError('notConnected');
      return { room, viewer: socket.data.viewer };
    };

    const asPlayer = () => {
      const { room, viewer } = current();
      if (viewer.kind !== 'player') throw new GameError('playersOnly');
      return { room, playerId: viewer.playerId };
    };

    const asHost = () => {
      const { room, viewer } = current();
      if (viewer.kind !== 'host') throw new GameError('hostOnly');
      return room;
    };

    on<{ code: string; hostToken: string }>('host:attach', ({ code, hostToken }) => {
      const room = requireRoom(code);
      if (typeof hostToken !== 'string' || hostToken !== room.hostToken) throw new GameError('notHost');
      bind(socket, room, { kind: 'host' });
    });

    on<{ code: string; name: string }>('player:join', ({ code, name }) => {
      const room = requireRoom(code);
      if (!joinLimiter.take(room.code)) throw new GameError('tooManyJoins');
      const player = room.join(name);
      bind(socket, room, { kind: 'player', playerId: player.id });
      return { token: player.token, playerId: player.id, code: room.code };
    });

    on<{ code: string; token: string }>('player:resume', ({ code, token }) => {
      const room = requireRoom(code);
      const player = room.playerByToken(token);
      if (!player) throw new GameError('sessionExpired');
      bind(socket, room, { kind: 'player', playerId: player.id });
      return { playerId: player.id, code: room.code };
    });

    on('leave', () => unbind(socket));

    on<{ role: string }>('player:setRole', ({ role }) => {
      const { room, playerId } = asPlayer();
      room.setRole(playerId, role);
    });

    on<{ matchId: string; side: string }>('player:vote', ({ matchId, side }) => {
      const { room, playerId } = asPlayer();
      room.vote(playerId, matchId, side);
    });

    on<Record<string, unknown>>('host:settings', (patch) => asHost().updateSettings(patch));
    on('host:start', () => asHost().start());
    on('host:pause', () => asHost().pause());
    on('host:resume', () => asHost().resume());
    on('host:skipTimer', () => asHost().skipTimer());
    on('host:advance', () => asHost().advance());
    on('host:playAgain', () => asHost().playAgain());
    on<{ side: string }>('host:pickWinner', ({ side }) => asHost().pickWinner(side));
    on<{ entryId: string }>('host:removeEntry', ({ entryId }) => asHost().removeEntry(entryId));

    on<{ playerId: string }>('host:kick', ({ playerId }) => {
      const room = asHost();
      const kicked = room.kick(playerId);
      if (!kicked) throw new GameError('playerNotFound');
      for (const sid of io.sockets.adapter.rooms.get(channel(room.code)) ?? []) {
        const s = io.sockets.sockets.get(sid) as AppSocket | undefined;
        if (s?.data.viewer?.kind === 'player' && s.data.viewer.playerId === kicked.id) {
          s.leave(channel(room.code));
          s.data.code = undefined;
          s.data.viewer = undefined;
          s.emit('kicked');
        }
      }
    });

    socket.on('disconnect', () => unbind(socket));
  });

  rooms.startSweeper();

  return { app, server, io, rooms, storage };
}
