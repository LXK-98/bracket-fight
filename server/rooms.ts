import crypto from 'node:crypto';
import type { Config } from './config';
import { Room } from './room';
import type { Storage } from './storage';

// Consonants only: easy to type on a phone and avoids spelling real words.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

function randomCode(length: number) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly onChange: (room: Room) => void,
    private readonly onRemove: (room: Room) => void = () => {},
  ) {}

  get size() {
    return this.rooms.size;
  }

  create(): Room {
    if (this.rooms.size >= this.config.maxRooms) throw new Error('Server is full, try again later.');
    let code = randomCode(4);
    for (let attempt = 0; this.rooms.has(code); attempt++) code = randomCode(attempt < 20 ? 4 : 5);
    const room = new Room(code, {
      now: Date.now,
      rng: Math.random,
      revealMs: this.config.revealMs,
      overviewMs: this.config.overviewMs,
      maxPlayers: this.config.maxPlayersPerRoom,
      onChange: this.onChange,
      onDeleteFile: (r, file) => {
        this.storage.deleteFile(r.code, file).catch((err) => console.error('delete file failed', err));
      },
    });
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  async remove(code: string) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.destroy();
    this.rooms.delete(code);
    this.onRemove(room);
    await this.storage.deleteRoom(code);
  }

  /** Drop rooms (and their images) with no activity for the configured TTL. */
  async sweep(now = Date.now()) {
    for (const room of [...this.rooms.values()]) {
      if (now - room.lastActivity > this.config.roomTtlMs) {
        console.log(`Cleaning up inactive room ${room.code}`);
        await this.remove(room.code).catch((err) => console.error('room cleanup failed', err));
      }
    }
  }

  startSweeper(intervalMs = 60_000) {
    this.sweeper = setInterval(() => void this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  stop() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.destroy();
  }
}
