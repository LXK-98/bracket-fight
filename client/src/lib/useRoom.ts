import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AckError, RoomView } from '../../../shared/types';
import type { Problem } from '../i18n/text';
import { hostToken, playerToken } from './storage';

/** Failure as the server sends it, or a client-side one (offline, no response). */
export type AckFailure = Omit<AckError, 'code'> & { code: string };
export type AckResult<T = object> = ({ ok: true } & T) | AckFailure;

export function ackProblem(res: AckFailure): Problem {
  return { code: res.code, params: res.params, message: res.error };
}

export interface RoomConnection {
  view: RoomView | null;
  connected: boolean;
  /** Unrecoverable state: kicked, room gone, not the host... */
  fatal: Problem | null;
  /** Player has no valid session and must enter a name. */
  needsJoin: boolean;
  emit: <T = object>(event: string, payload?: object) => Promise<AckResult<T>>;
  join: (name: string) => Promise<AckResult>;
  /** Current time on the server clock. */
  serverNow: () => number;
}

export function useRoom(code: string, mode: 'host' | 'player'): RoomConnection {
  const [view, setView] = useState<RoomView | null>(null);
  const [connected, setConnected] = useState(false);
  const [fatal, setFatal] = useState<Problem | null>(null);
  const [needsJoin, setNeedsJoin] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const offsetRef = useRef(0);

  useEffect(() => {
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    setView(null);
    setFatal(null);

    const authenticate = () => {
      if (mode === 'host') {
        const token = hostToken.get(code);
        if (!token) return setFatal({ code: 'notHostScreen' });
        socket.emit('host:attach', { code, hostToken: token }, (res: AckResult) => {
          if (!res.ok) setFatal(ackProblem(res));
        });
        return;
      }
      const token = playerToken.get(code);
      if (!token) return setNeedsJoin(true);
      socket.emit('player:resume', { code, token }, (res: AckResult) => {
        if (res.ok) return;
        if (res.code === 'roomNotFound') return setFatal({ code: 'roomGone' });
        playerToken.set(code, null);
        setNeedsJoin(true);
      });
    };

    socket.on('connect', () => {
      setConnected(true);
      authenticate();
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', (v: RoomView) => {
      offsetRef.current = v.now - Date.now();
      setView(v);
      setNeedsJoin(false);
    });
    socket.on('kicked', () => {
      playerToken.set(code, null);
      setFatal({ code: 'kicked' });
    });
    socket.on('roomClosed', () => setFatal({ code: 'roomClosed' }));

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [code, mode]);

  const emit = useCallback(<T,>(event: string, payload: object = {}) => {
    return new Promise<AckResult<T>>((resolve) => {
      const socket = socketRef.current;
      if (!socket?.connected) return resolve({ ok: false, code: 'offline', error: 'Not connected, retrying…' });
      socket.timeout(8000).emit(event, payload, (err: Error | null, res: AckResult<T>) => {
        resolve(err ? { ok: false, code: 'noResponse', error: 'The server did not respond.' } : res);
      });
    });
  }, []);

  const join = useCallback(
    async (name: string) => {
      const res = await emit<{ token: string }>('player:join', { code, name });
      if (res.ok) playerToken.set(code, res.token);
      return res;
    },
    [code, emit],
  );

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  return { view, connected, fatal, needsJoin, emit, join, serverNow };
}

/** Re-render periodically (for countdowns). */
export function useTick(ms = 200) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Milliseconds left in the current timed phase, or null if untimed. */
export function remainingMs(view: RoomView, serverNow: () => number): number | null {
  if (view.paused) return view.pausedRemainingMs;
  if (view.phaseEndsAt === null) return null;
  return Math.max(0, view.phaseEndsAt - serverNow());
}
