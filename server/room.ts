import crypto from 'node:crypto';
import {
  bracketSizeFor,
  champion,
  createBracket,
  entryStatus,
  findMatch,
  isComplete,
  nextPlayableMatch,
  recordResult,
  removeEntry as bracketRemoveEntry,
  resolveVotes,
  type Bracket,
  type DecidedBy,
  type Rng,
  type Side,
} from '../shared/bracket';
import { problem, type MessageCode, type MessageParams } from '../shared/messages';
import { sanitizeName, sanitizeText } from '../shared/sanitize';
import {
  DEFAULT_SETTINGS,
  MAX_VOTE_SECONDS,
  MIN_VOTE_SECONDS,
  SUDDEN_DEATH_SECONDS,
  maxEntriesValue,
  type EntryMode,
  type LobbyInfo,
  type MatchView,
  type MeView,
  type Phase,
  type PublicEntry,
  type Problem,
  type PublicPlayer,
  type Role,
  type RoomView,
  type Settings,
} from '../shared/types';

/** An error meant for the user: `code` + `params` are translated by the client, `message` is English. */
export class GameError extends Error {
  constructor(
    readonly code: MessageCode,
    readonly params?: MessageParams,
  ) {
    super(problem(code, params).message);
  }
}

export interface PlayerState {
  id: string;
  name: string;
  role: Role;
  token: string;
  connections: number;
  entryId: string | null;
}

export interface EntryState {
  id: string;
  playerId: string;
  ownerName: string;
  text: string | null;
  /** File name inside this room's upload directory. */
  imageFile: string | null;
}

export interface RoomDeps {
  now: () => number;
  rng: Rng;
  revealMs: number;
  overviewMs: number;
  maxPlayers: number;
  /** Called (coalescing is up to the caller) whenever observable state changes. */
  onChange: (room: Room) => void;
  /** Called when an uploaded image is no longer referenced. */
  onDeleteFile: (room: Room, file: string) => void;
}

export type Viewer = { kind: 'host' } | { kind: 'player'; playerId: string };

/** Time all voters get after the last vote comes in, before voting closes. */
const ALL_VOTED_GRACE_MS = 1500;
/** Extra time on the very first bracket overview, so people can take it in. */
const FIRST_OVERVIEW_BONUS_MS = 2000;

const id = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

function entryValid(e: EntryState | undefined, mode: EntryMode): boolean {
  if (!e) return false;
  if (mode === 'image') return e.imageFile !== null;
  if (mode === 'text') return e.text !== null;
  return e.imageFile !== null || e.text !== null;
}

export class Room {
  readonly hostToken = id(18);
  readonly createdAt: number;
  lastActivity: number;
  settings: Settings = { ...DEFAULT_SETTINGS };

  readonly players = new Map<string, PlayerState>();
  private readonly byToken = new Map<string, string>();
  readonly entries = new Map<string, EntryState>();

  phase: Phase = 'lobby';
  bracket: Bracket | null = null;
  currentMatchId: string | null = null;
  nextMatchId: string | null = null;
  readonly votes = new Map<string, Side>();
  suddenDeath = false;

  phaseEndsAt: number | null = null;
  pausedRemainingMs: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerFn: (() => void) | null = null;

  constructor(
    readonly code: string,
    private readonly deps: RoomDeps,
  ) {
    this.createdAt = deps.now();
    this.lastActivity = this.createdAt;
  }

  // ---------------------------------------------------------------- helpers

  private changed() {
    this.lastActivity = this.deps.now();
    this.deps.onChange(this);
  }

  private get maxEntries() {
    return maxEntriesValue(this.settings.maxEntries);
  }

  private competitors(): PlayerState[] {
    return [...this.players.values()].filter((p) => p.role === 'competitor');
  }

  private player(playerId: string): PlayerState {
    const p = this.players.get(playerId);
    if (!p) throw new GameError('notInRoom');
    return p;
  }

  private requireLobby() {
    if (this.phase !== 'lobby') throw new GameError('gameStarted');
  }

  private deleteEntry(entryId: string | null) {
    if (!entryId) return;
    const e = this.entries.get(entryId);
    if (!e) return;
    this.entries.delete(entryId);
    if (e.imageFile) this.deps.onDeleteFile(this, e.imageFile);
    const owner = this.players.get(e.playerId);
    if (owner?.entryId === entryId) owner.entryId = null;
  }

  private setTimer(ms: number, fn: () => void) {
    this.clearTimer();
    this.timerFn = fn;
    this.phaseEndsAt = this.deps.now() + ms;
    this.pausedRemainingMs = null;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerFn = null;
      this.phaseEndsAt = null;
      fn();
    }, ms);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerFn = null;
    this.phaseEndsAt = null;
    this.pausedRemainingMs = null;
  }

  get paused() {
    return this.pausedRemainingMs !== null;
  }

  private currentMatch() {
    return this.bracket && this.currentMatchId ? findMatch(this.bracket, this.currentMatchId) : undefined;
  }

  private canVote(p: PlayerState): boolean {
    if (this.settings.allowSelfVote || !p.entryId) return true;
    const m = this.currentMatch();
    return !m || (m.a !== p.entryId && m.b !== p.entryId);
  }

  private eligibleVoters(): PlayerState[] {
    return [...this.players.values()].filter((p) => p.connections > 0 && this.canVote(p));
  }

  /** Close voting shortly after every eligible, connected player has voted. */
  private checkAllVoted() {
    if (this.phase !== 'voting' || this.paused || this.phaseEndsAt === null) return;
    const eligible = this.eligibleVoters();
    if (eligible.length === 0 || !eligible.every((p) => this.votes.has(p.id))) return;
    if (this.phaseEndsAt - this.deps.now() > ALL_VOTED_GRACE_MS) {
      this.setTimer(ALL_VOTED_GRACE_MS, () => this.endVoting());
    }
  }

  // ---------------------------------------------------------------- players

  join(rawName: unknown): PlayerState {
    const name = sanitizeName(rawName);
    if (!name) throw new GameError('nameRequired');
    if (this.players.size >= this.deps.maxPlayers) throw new GameError('roomFull');
    const lower = name.toLocaleLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLocaleLowerCase() === lower) throw new GameError('nameTaken');
    }
    const player: PlayerState = {
      id: id(),
      name,
      role: this.phase === 'lobby' ? 'undecided' : 'voter',
      token: id(24),
      connections: 0,
      entryId: null,
    };
    this.players.set(player.id, player);
    this.byToken.set(player.token, player.id);
    this.changed();
    return player;
  }

  playerByToken(token: unknown): PlayerState | null {
    if (typeof token !== 'string') return null;
    const pid = this.byToken.get(token);
    return pid ? (this.players.get(pid) ?? null) : null;
  }

  connect(playerId: string) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connections++;
    this.changed();
  }

  disconnect(playerId: string) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connections = Math.max(0, p.connections - 1);
    this.checkAllVoted();
    this.changed();
  }

  setRole(playerId: string, role: unknown) {
    this.requireLobby();
    const p = this.player(playerId);
    if (role !== 'competitor' && role !== 'voter') throw new GameError('invalidRequest');
    if (role === p.role) return;
    if (role === 'competitor' && this.competitors().length >= this.maxEntries) {
      throw new GameError('bracketFull', { max: this.maxEntries });
    }
    if (role === 'voter') this.deleteEntry(p.entryId);
    p.role = role;
    this.changed();
  }

  /**
   * Create or update a competitor's entry. `imageFile` is a freshly stored
   * upload (ownership passes to the room, even on error), `removeImage` drops the current one.
   */
  submitEntry(playerId: string, input: { text: unknown; imageFile: string | null; removeImage: boolean }) {
    try {
      this.requireLobby();
      const p = this.player(playerId);
      if (p.role !== 'competitor') throw new GameError('notCompetitor');
      const mode = this.settings.entryMode;
      if (mode === 'text' && input.imageFile) throw new GameError('textOnly');
      const text = mode === 'image' ? null : sanitizeText(input.text);

      const existing = p.entryId ? this.entries.get(p.entryId) : undefined;
      let imageFile = existing?.imageFile ?? null;
      if (input.imageFile || input.removeImage) imageFile = input.imageFile;
      if (mode === 'text') imageFile = null;

      const draft: EntryState = {
        id: existing?.id ?? id(),
        playerId: p.id,
        ownerName: p.name,
        text,
        imageFile,
      };
      if (!entryValid(draft, mode)) {
        throw new GameError(mode === 'image' ? 'imageRequired' : mode === 'text' ? 'textRequired' : 'entryEmpty');
      }
      if (existing?.imageFile && existing.imageFile !== imageFile) this.deps.onDeleteFile(this, existing.imageFile);
      this.entries.set(draft.id, draft);
      p.entryId = draft.id;
      this.changed();
    } catch (err) {
      if (input.imageFile) this.deps.onDeleteFile(this, input.imageFile);
      throw err;
    }
  }

  /** Remove a player. In the lobby their entry goes too; mid-game it stays in the bracket. */
  kick(playerId: string): PlayerState | null {
    const p = this.players.get(playerId);
    if (!p) return null;
    if (this.phase === 'lobby') this.deleteEntry(p.entryId);
    this.players.delete(p.id);
    this.byToken.delete(p.token);
    this.votes.delete(p.id);
    this.checkAllVoted();
    this.changed();
    return p;
  }

  // ---------------------------------------------------------------- host

  updateSettings(patch: Partial<Record<keyof Settings, unknown>>) {
    this.requireLobby();
    const s = { ...this.settings };
    if (patch.maxEntries !== undefined) {
      if (![4, 8, 16, 32, 'auto'].includes(patch.maxEntries as never)) throw new GameError('invalidRequest');
      s.maxEntries = patch.maxEntries as Settings['maxEntries'];
    }
    if (patch.voteSeconds !== undefined) {
      const v = Math.round(Number(patch.voteSeconds));
      if (!Number.isFinite(v)) throw new GameError('invalidRequest');
      s.voteSeconds = Math.min(MAX_VOTE_SECONDS, Math.max(MIN_VOTE_SECONDS, v));
    }
    if (patch.entryMode !== undefined) {
      if (!['image', 'text', 'imageOrText'].includes(patch.entryMode as string)) throw new GameError('invalidRequest');
      s.entryMode = patch.entryMode as EntryMode;
    }
    if (patch.showLiveVotes !== undefined) s.showLiveVotes = Boolean(patch.showLiveVotes);
    if (patch.allowSelfVote !== undefined) s.allowSelfVote = Boolean(patch.allowSelfVote);
    if (patch.tieBreak !== undefined) {
      if (!['random', 'host', 'suddenDeath'].includes(patch.tieBreak as string)) throw new GameError('invalidRequest');
      s.tieBreak = patch.tieBreak as Settings['tieBreak'];
    }
    this.settings = s;
    this.changed();
  }

  lobbyInfo(): LobbyInfo {
    const competitors = this.competitors();
    const count = competitors.length;
    const submitted = competitors.filter((p) => entryValid(this.entries.get(p.entryId ?? ''), this.settings.entryMode)).length;
    const max = this.maxEntries;
    const bracketSize = bracketSizeFor(Math.max(count, 2), max);
    let blocked: Problem | null = null;
    if (count < 2) blocked = problem('needTwoCompetitors', { current: count });
    else if (count > max) blocked = problem('tooManyCompetitors', { current: count, max });
    else if (submitted < count) blocked = problem('waitingForEntries', { count: count - submitted });
    return {
      competitorCount: count,
      submittedCount: submitted,
      maxEntries: max,
      bracketSize,
      byes: count >= 2 && count <= max ? bracketSize - count : 0,
      canStart: blocked === null,
      startBlocked: blocked,
      competitorsFull: count >= max,
    };
  }

  start() {
    this.requireLobby();
    const info = this.lobbyInfo();
    if (info.startBlocked) throw new GameError(info.startBlocked.code, info.startBlocked.params);
    for (const p of this.players.values()) if (p.role === 'undecided') p.role = 'voter';
    const entryIds = this.competitors().map((p) => p.entryId!);
    this.bracket = createBracket(entryIds, this.deps.rng);
    this.goToNext(FIRST_OVERVIEW_BONUS_MS);
  }

  /** Show the bracket overview, then play the next match (or finish). */
  private goToNext(extraMs = 0) {
    const b = this.bracket!;
    this.votes.clear();
    this.currentMatchId = null;
    this.suddenDeath = false;
    if (isComplete(b)) return this.finish();
    const next = nextPlayableMatch(b)!;
    this.phase = 'overview';
    this.nextMatchId = next.id;
    this.setTimer(this.deps.overviewMs + extraMs, () => this.startMatch(next.id));
    this.changed();
  }

  private startMatch(matchId: string) {
    this.phase = 'voting';
    this.currentMatchId = matchId;
    this.nextMatchId = null;
    this.votes.clear();
    this.suddenDeath = false;
    this.setTimer(this.settings.voteSeconds * 1000, () => this.endVoting());
    this.changed();
  }

  private tally() {
    let a = 0;
    let b = 0;
    for (const v of this.votes.values()) v === 'a' ? a++ : b++;
    return { a, b };
  }

  private endVoting() {
    this.clearTimer();
    const { a, b } = this.tally();
    const action = resolveVotes(a, b, this.settings.tieBreak, this.suddenDeath, this.deps.rng);
    if (action.kind === 'revote') {
      this.suddenDeath = true;
      this.votes.clear();
      this.phase = 'voting';
      this.setTimer(SUDDEN_DEATH_SECONDS * 1000, () => this.endVoting());
      this.changed();
      return;
    }
    if (action.kind === 'host') {
      this.phase = 'tiebreak';
      this.changed();
      return;
    }
    const decidedBy: DecidedBy = a === b ? 'random' : this.suddenDeath ? 'suddenDeath' : 'votes';
    this.finishMatch(action.side, decidedBy, a, b);
  }

  private finishMatch(side: Side, decidedBy: DecidedBy, a: number, b: number) {
    this.bracket = recordResult(this.bracket!, this.currentMatchId!, side, decidedBy, a, b);
    this.showReveal();
  }

  private showReveal() {
    this.phase = 'reveal';
    this.setTimer(this.deps.revealMs, () => this.goToNext());
    this.changed();
  }

  private finish() {
    this.clearTimer();
    this.phase = 'finished';
    this.currentMatchId = null;
    this.nextMatchId = null;
    this.votes.clear();
    this.changed();
  }

  pause() {
    if (this.paused || !this.timer || this.phaseEndsAt === null) throw new GameError('nothingToPause');
    const remaining = Math.max(0, this.phaseEndsAt - this.deps.now());
    const fn = this.timerFn!;
    this.clearTimer();
    this.timerFn = fn;
    this.pausedRemainingMs = remaining;
    this.changed();
  }

  resume() {
    if (!this.paused || !this.timerFn) throw new GameError('notPaused');
    this.setTimer(this.pausedRemainingMs!, this.timerFn);
    this.checkAllVoted();
    this.changed();
  }

  /** End the vote timer now. */
  skipTimer() {
    if (this.phase !== 'voting') throw new GameError('noVoteRunning');
    this.endVoting();
  }

  /** Move to the next step right away (end vote, skip reveal/overview). */
  advance() {
    switch (this.phase) {
      case 'voting':
        return this.endVoting();
      case 'reveal':
        return this.goToNext();
      case 'overview':
        return this.startMatch(this.nextMatchId!);
      case 'tiebreak':
        throw new GameError('pickWinner');
      default:
        throw new GameError('nothingToAdvance');
    }
  }

  pickWinner(side: unknown) {
    if (this.phase !== 'tiebreak') throw new GameError('noTie');
    if (side !== 'a' && side !== 'b') throw new GameError('invalidRequest');
    const { a, b } = this.tally();
    this.finishMatch(side, 'host', a, b);
  }

  /** Host moderation: in the lobby the entry is deleted; mid-game its opponent advances. */
  removeEntry(entryId: unknown) {
    if (typeof entryId !== 'string' || !this.entries.has(entryId)) throw new GameError('unknownEntry');
    if (this.phase === 'lobby') {
      this.deleteEntry(entryId);
      this.changed();
      return;
    }
    if (this.phase === 'finished' || !this.bracket) throw new GameError('gameOver');
    this.bracket = bracketRemoveEntry(this.bracket, entryId);
    const current = this.currentMatch();
    if ((this.phase === 'voting' || this.phase === 'tiebreak') && current?.winner) {
      // The running match was just decided by forfeit.
      this.showReveal();
      return;
    }
    if (this.phase === 'overview') {
      if (isComplete(this.bracket)) return this.finish();
      const next = nextPlayableMatch(this.bracket)!;
      if (next.id !== this.nextMatchId) {
        this.nextMatchId = next.id;
        const start = () => this.startMatch(next.id);
        if (this.paused) this.timerFn = start;
        else this.setTimer(Math.max(0, (this.phaseEndsAt ?? 0) - this.deps.now()), start);
      }
    }
    this.changed();
  }

  /** Same room and players, entries cleared, everyone picks a role again. */
  playAgain() {
    this.clearTimer();
    for (const e of [...this.entries.keys()]) this.deleteEntry(e);
    for (const p of this.players.values()) {
      p.role = 'undecided';
      p.entryId = null;
    }
    this.bracket = null;
    this.phase = 'lobby';
    this.currentMatchId = null;
    this.nextMatchId = null;
    this.votes.clear();
    this.suddenDeath = false;
    this.changed();
  }

  // ---------------------------------------------------------------- voting

  vote(playerId: string, matchId: unknown, side: unknown) {
    const p = this.player(playerId);
    if (this.phase !== 'voting' || matchId !== this.currentMatchId) throw new GameError('votingClosed');
    if (this.paused) throw new GameError('gamePaused');
    if (side !== 'a' && side !== 'b') throw new GameError('invalidRequest');
    if (!this.canVote(p)) throw new GameError('ownMatchup');
    this.votes.set(p.id, side);
    this.checkAllVoted();
    this.changed();
  }

  // ---------------------------------------------------------------- views

  destroy() {
    this.clearTimer();
  }

  private publicEntry(e: EntryState): PublicEntry {
    const mode = this.settings.entryMode;
    return {
      id: e.id,
      playerId: e.playerId,
      ownerName: e.ownerName,
      text: mode === 'image' ? null : e.text,
      imageUrl: mode !== 'text' && e.imageFile ? `/uploads/${this.code}/${e.imageFile}` : null,
    };
  }

  view(viewer: Viewer): RoomView {
    const isHost = viewer.kind === 'host';
    const me = viewer.kind === 'player' ? this.players.get(viewer.playerId) : undefined;
    const mode = this.settings.entryMode;

    const players: PublicPlayer[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      connected: p.connections > 0,
      submitted: p.role === 'competitor' && entryValid(this.entries.get(p.entryId ?? ''), mode),
    }));

    // Entries stay secret until the game starts (players only see their own).
    const entries: Record<string, PublicEntry> = {};
    if (this.bracket) {
      for (const m of this.bracket.rounds[0]) {
        for (const eid of [m.a, m.b]) {
          const e = eid ? this.entries.get(eid) : undefined;
          if (e) entries[e.id] = this.publicEntry(e);
        }
      }
    }
    const myEntry = me?.entryId ? this.entries.get(me.entryId) : undefined;
    if (myEntry) entries[myEntry.id] = this.publicEntry(myEntry);

    let match: MatchView | null = null;
    const m = this.currentMatch();
    if (m && m.a && m.b && (this.phase === 'voting' || this.phase === 'tiebreak' || this.phase === 'reveal')) {
      const showCounts = this.settings.showLiveVotes || this.phase !== 'voting';
      const live = this.tally();
      const decided = this.phase === 'reveal' && m.winner !== null;
      match = {
        matchId: m.id,
        round: m.round,
        a: m.a,
        b: m.b,
        suddenDeath: this.suddenDeath,
        votesA: showCounts ? (decided ? m.votesA : live.a) : null,
        votesB: showCounts ? (decided ? m.votesB : live.b) : null,
        votedCount: decided ? m.votesA + m.votesB : this.votes.size,
        eligibleCount: this.eligibleVoters().length,
        winner: decided ? (m.winner === m.a ? 'a' : 'b') : null,
        decidedBy: decided ? m.decidedBy : null,
      };
    }

    let meView: MeView | null = null;
    if (me) {
      const inBracket = !!this.bracket && !!myEntry && this.bracket.rounds[0].some((x) => x.a === myEntry.id || x.b === myEntry.id);
      const status = inBracket ? entryStatus(this.bracket!, myEntry!.id) : null;
      let blocked: MeView['voteBlocked'] = null;
      if (this.phase === 'voting') {
        if (!this.canVote(me)) blocked = 'ownMatchup';
        else if (this.paused) blocked = 'paused';
      }
      meView = {
        id: me.id,
        name: me.name,
        role: me.role,
        entry: myEntry ? this.publicEntry(myEntry) : null,
        submitted: me.role === 'competitor' && entryValid(myEntry, mode),
        vote: this.phase === 'voting' || this.phase === 'tiebreak' || this.phase === 'reveal' ? (this.votes.get(me.id) ?? null) : null,
        canVote: this.phase === 'voting' && blocked === null,
        voteBlocked: blocked,
        entryStatus: status ? status.state : 'none',
        eliminatedRound: status?.state === 'eliminated' ? status.round : null,
      };
    }

    return {
      code: this.code,
      isHost,
      phase: this.phase,
      settings: this.settings,
      now: this.deps.now(),
      phaseEndsAt: this.phaseEndsAt,
      paused: this.paused,
      pausedRemainingMs: this.pausedRemainingMs,
      players,
      entries,
      bracket: this.bracket,
      match,
      nextMatchId: this.nextMatchId,
      champion: this.bracket && this.phase === 'finished' ? champion(this.bracket) : null,
      lobby: this.lobbyInfo(),
      me: meView,
    };
  }
}
