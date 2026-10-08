import path from 'node:path';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Normalise PUBLIC_URL. Coolify's SERVICE_FQDN_* may be a bare host, include a
 * scheme, or be a comma-separated list of domains; unresolved "$VAR" values are ignored.
 */
export function normalizePublicUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(',')[0].trim();
  if (!first || first.includes('$')) return null;
  const withScheme = /^https?:\/\//i.test(first) ? first : `https://${first}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Express "trust proxy" setting: hop count, true/false, or a list of trusted IPs/subnets. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = raw?.trim();
  if (!v) return 1; // one reverse proxy in front (e.g. Coolify's Traefik/Caddy)
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export const config = {
  port: num('PORT', 3000),
  publicUrl: normalizePublicUrl(process.env.PUBLIC_URL),
  /** When set, creating a room requires this password. Joining stays open. */
  hostPassword: process.env.HOST_PASSWORD || null,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  dataDir: path.resolve(process.env.DATA_DIR || (process.env.NODE_ENV === 'production' ? '/data' : './data')),
  roomTtlMs: num('ROOM_TTL_HOURS', 6) * 60 * 60 * 1000,
  maxUploadBytes: Math.round(num('MAX_UPLOAD_MB', 5) * 1024 * 1024),
  maxRooms: num('MAX_ROOMS', 200),
  maxPlayersPerRoom: num('MAX_PLAYERS_PER_ROOM', 100),
  revealMs: num('REVEAL_MS', 5000),
  overviewMs: num('OVERVIEW_MS', 4000),
  clientDir: path.resolve(process.env.CLIENT_DIR || './dist/client'),
};

export type Config = typeof config;
