import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Detected from magic bytes; the client's declared MIME type is never trusted. */
export type ImageKind = 'jpg' | 'png' | 'webp' | 'gif';

export function detectImage(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const gif = buf.toString('ascii', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  return null;
}

const SAFE_CODE = /^[A-Z0-9]{4,5}$/;
const SAFE_FILE = /^[A-Za-z0-9_-]+\.(jpg|png|webp|gif)$/;

export class Storage {
  readonly roomsDir: string;

  constructor(dataDir: string) {
    this.roomsDir = path.join(dataDir, 'rooms');
  }

  /** Rooms live in memory, so leftovers from a previous process are orphans. */
  async init() {
    await fs.rm(this.roomsDir, { recursive: true, force: true });
    await fs.mkdir(this.roomsDir, { recursive: true });
  }

  roomDir(code: string) {
    if (!SAFE_CODE.test(code)) throw new Error('Invalid room code');
    return path.join(this.roomsDir, code);
  }

  async saveImage(code: string, buf: Buffer, kind: ImageKind): Promise<string> {
    const dir = this.roomDir(code);
    await fs.mkdir(dir, { recursive: true });
    const file = `${crypto.randomBytes(12).toString('base64url')}.${kind}`;
    await fs.writeFile(path.join(dir, file), buf);
    return file;
  }

  async deleteFile(code: string, file: string) {
    if (!SAFE_FILE.test(file)) return;
    await fs.rm(path.join(this.roomDir(code), file), { force: true });
  }

  async deleteRoom(code: string) {
    await fs.rm(this.roomDir(code), { recursive: true, force: true });
  }
}
