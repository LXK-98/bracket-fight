// Types shared between server and client. The server is authoritative; clients
// only ever receive these views and send actions.
import type { Bracket, DecidedBy, Side } from './bracket';
import type { MessageParams, Problem } from './messages';

export type { Bracket, Match, Side, DecidedBy } from './bracket';
export type { MessageCode, MessageParams, Problem } from './messages';

export type Role = 'undecided' | 'competitor' | 'voter';
export type EntryMode = 'image' | 'text' | 'imageOrText';
export type TieBreak = 'random' | 'host' | 'suddenDeath';
export type MaxEntries = 4 | 8 | 16 | 32 | 'auto';
export type Phase = 'lobby' | 'voting' | 'tiebreak' | 'reveal' | 'overview' | 'finished';

export interface Settings {
  maxEntries: MaxEntries;
  voteSeconds: number;
  entryMode: EntryMode;
  showLiveVotes: boolean;
  allowSelfVote: boolean;
  tieBreak: TieBreak;
}

export const DEFAULT_SETTINGS: Settings = {
  maxEntries: 'auto',
  voteSeconds: 20,
  entryMode: 'imageOrText',
  showLiveVotes: true,
  allowSelfVote: true,
  tieBreak: 'suddenDeath',
};

/** Hard cap used when maxEntries is "auto". Keeps the bracket readable on a TV. */
export const AUTO_MAX_ENTRIES = 32;
export const SUDDEN_DEATH_SECONDS = 10;
export const MIN_VOTE_SECONDS = 5;
export const MAX_VOTE_SECONDS = 120;
export const MAX_NAME_LENGTH = 20;
export const MAX_TEXT_LENGTH = 200;

export function maxEntriesValue(m: MaxEntries): number {
  return m === 'auto' ? AUTO_MAX_ENTRIES : m;
}

export interface PublicPlayer {
  id: string;
  name: string;
  role: Role;
  connected: boolean;
  /** Competitor has a submitted entry that satisfies the current entry mode. */
  submitted: boolean;
}

export interface PublicEntry {
  id: string;
  playerId: string;
  ownerName: string;
  text: string | null;
  imageUrl: string | null;
}

export interface MatchView {
  matchId: string;
  round: number;
  a: string;
  b: string;
  suddenDeath: boolean;
  /** Present when vote counts are visible to this viewer. */
  votesA: number | null;
  votesB: number | null;
  votedCount: number;
  eligibleCount: number;
  /** Set once the match is decided (reveal phase). */
  winner: Side | null;
  decidedBy: DecidedBy | null;
}

export interface LobbyInfo {
  competitorCount: number;
  submittedCount: number;
  maxEntries: number;
  bracketSize: number;
  byes: number;
  canStart: boolean;
  /** Why the host can't start yet (null when they can). */
  startBlocked: Problem | null;
  competitorsFull: boolean;
}

export interface MeView {
  id: string;
  name: string;
  role: Role;
  entry: PublicEntry | null;
  /** True when my entry exists and satisfies the current entry mode. */
  submitted: boolean;
  vote: Side | null;
  canVote: boolean;
  /** Why this player can't vote in the running match, if they can't. */
  voteBlocked: 'ownMatchup' | 'paused' | null;
  /** Bracket status of my entry while a game is running. */
  entryStatus: 'none' | 'alive' | 'eliminated' | 'champion' | 'removed';
  eliminatedRound: number | null;
}

export interface RoomView {
  code: string;
  isHost: boolean;
  phase: Phase;
  settings: Settings;
  /** Server clock (ms) when this view was built, for countdown sync. */
  now: number;
  /** Server clock (ms) when the current timed phase ends; null when untimed. */
  phaseEndsAt: number | null;
  paused: boolean;
  pausedRemainingMs: number | null;
  players: PublicPlayer[];
  /** Entries visible to this viewer (lobby: only your own; in-game: all bracket entries). */
  entries: Record<string, PublicEntry>;
  bracket: Bracket | null;
  match: MatchView | null;
  /** Upcoming match during the overview phase. */
  nextMatchId: string | null;
  champion: string | null;
  lobby: LobbyInfo;
  me: MeView | null;
}

/** Failed action: `error` is the English text; `code` + `params` are for translating it. */
export interface AckError {
  ok: false;
  error: string;
  code: Problem['code'];
  params?: MessageParams;
}

export type Ack<T = object> = (res: ({ ok: true } & T) | AckError) => void;

export interface JoinPayload {
  code: string;
  name: string;
}
export interface ResumePayload {
  code: string;
  token: string;
}
