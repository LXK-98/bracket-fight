// Pure single-elimination bracket logic. Every exported function returns a new
// bracket and never mutates its input, so it is trivially testable.

export type Side = 'a' | 'b';
export type DecidedBy = 'votes' | 'suddenDeath' | 'random' | 'host' | 'forfeit' | 'bye';

export interface Match {
  /** Stable id, e.g. "r0m3" (round 0, match 3). */
  id: string;
  round: number;
  index: number;
  /** Entry ids. null means "not decided yet", or the empty side of a bye. */
  a: string | null;
  b: string | null;
  /** Round-0 match with a single entry that advances automatically. */
  bye: boolean;
  winner: string | null;
  votesA: number;
  votesB: number;
  decidedBy: DecidedBy | null;
}

export interface Bracket {
  /** Number of round-0 slots, always a power of two. */
  size: number;
  rounds: Match[][];
  /** Entries removed by the host mid-game; their opponents advance. */
  removed: string[];
}

export type Rng = () => number;

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Bracket size for a given entry count, capped by the configured maximum. */
export function bracketSizeFor(entryCount: number, max: number): number {
  if (entryCount < 2) return 2;
  return Math.min(nextPowerOfTwo(entryCount), nextPowerOfTwo(max));
}

/**
 * Standard tournament seeding order for a bracket of `size` slots, e.g. for 8:
 * [1, 8, 4, 5, 2, 7, 3, 6]. Adjacent pairs are first-round matches. Top seeds
 * are spread as far apart as possible, which is what spreads the byes.
 */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clone(b: Bracket): Bracket {
  return {
    size: b.size,
    removed: b.removed.slice(),
    rounds: b.rounds.map((r) => r.map((m) => ({ ...m }))),
  };
}

function emptyMatch(round: number, index: number): Match {
  return {
    id: `r${round}m${index}`,
    round,
    index,
    a: null,
    b: null,
    bye: false,
    winner: null,
    votesA: 0,
    votesB: 0,
    decidedBy: null,
  };
}

/**
 * Build a bracket from entry ids. Entries are randomly seeded; when the count
 * is not a power of two the top seeds get byes, so exactly (size - n) entries
 * advance automatically and round 2 is a clean power of two.
 */
export function createBracket(entryIds: readonly string[], rng: Rng = Math.random): Bracket {
  if (new Set(entryIds).size !== entryIds.length) throw new Error('Duplicate entry ids');
  if (entryIds.length < 2) throw new Error('At least 2 entries are required');
  const size = nextPowerOfTwo(entryIds.length);
  const seeded = shuffle(entryIds, rng); // seeded[k] has seed k + 1
  const order = seedOrder(size);
  const roundCount = Math.log2(size);

  const rounds: Match[][] = [];
  for (let r = 0; r < roundCount; r++) {
    const count = size / 2 ** (r + 1);
    rounds.push(Array.from({ length: count }, (_, i) => emptyMatch(r, i)));
  }

  rounds[0].forEach((m, i) => {
    const seedA = order[2 * i];
    const seedB = order[2 * i + 1];
    m.a = seeded[seedA - 1] ?? null;
    m.b = seeded[seedB - 1] ?? null;
    if (m.a === null && m.b !== null) {
      // Keep the real entry on side a for byes.
      m.a = m.b;
      m.b = null;
    }
    if (m.b === null) {
      m.bye = true;
      m.winner = m.a;
      m.decidedBy = 'bye';
    }
  });

  let bracket: Bracket = { size, rounds, removed: [] };
  for (const m of rounds[0]) if (m.bye) propagate(bracket, m);
  bracket = settle(bracket);
  return bracket;
}

/** Copy a decided match's winner into its slot in the next round (mutates). */
function propagate(b: Bracket, m: Match): void {
  const next = b.rounds[m.round + 1]?.[Math.floor(m.index / 2)];
  if (!next) return;
  if (m.index % 2 === 0) next.a = m.winner;
  else next.b = m.winner;
}

/**
 * Resolve every match that no longer needs a vote: a removed entry facing a
 * live one forfeits. Two removed entries: one advances only to forfeit again.
 */
function settle(input: Bracket): Bracket {
  const b = clone(input);
  const removed = new Set(b.removed);
  for (const round of b.rounds) {
    for (const m of round) {
      if (m.winner !== null || m.a === null || m.b === null) continue;
      const aOut = removed.has(m.a);
      const bOut = removed.has(m.b);
      if (!aOut && !bOut) continue;
      m.winner = aOut && !bOut ? m.b : m.a;
      m.decidedBy = 'forfeit';
      propagate(b, m);
    }
  }
  return b;
}

export function allMatches(b: Bracket): Match[] {
  return b.rounds.flat();
}

export function findMatch(b: Bracket, matchId: string): Match | undefined {
  return allMatches(b).find((m) => m.id === matchId);
}

/** Next match that needs voting, in round order. */
export function nextPlayableMatch(b: Bracket): Match | null {
  for (const m of allMatches(b)) {
    if (m.winner === null && m.a !== null && m.b !== null) return m;
  }
  return null;
}

export function recordResult(
  input: Bracket,
  matchId: string,
  side: Side,
  decidedBy: DecidedBy,
  votesA = 0,
  votesB = 0,
): Bracket {
  const b = clone(input);
  const m = findMatch(b, matchId);
  if (!m) throw new Error(`Unknown match ${matchId}`);
  if (m.winner !== null) throw new Error(`Match ${matchId} is already decided`);
  if (m.a === null || m.b === null) throw new Error(`Match ${matchId} is not ready`);
  m.winner = side === 'a' ? m.a : m.b;
  m.decidedBy = decidedBy;
  m.votesA = votesA;
  m.votesB = votesB;
  propagate(b, m);
  return settle(b);
}

/** Remove an entry mid-game. Its current (or next) opponent advances. */
export function removeEntry(input: Bracket, entryId: string): Bracket {
  if (input.removed.includes(entryId)) return input;
  const inBracket = input.rounds[0].some((m) => m.a === entryId || m.b === entryId);
  if (!inBracket) throw new Error(`Entry ${entryId} is not in the bracket`);
  return settle({ ...clone(input), removed: [...input.removed, entryId] });
}

export function finalMatch(b: Bracket): Match {
  return b.rounds[b.rounds.length - 1][0];
}

export function isComplete(b: Bracket): boolean {
  return finalMatch(b).winner !== null;
}

/** Champion entry id, or null if unfinished or every entry was removed. */
export function champion(b: Bracket): string | null {
  const w = finalMatch(b).winner;
  return w !== null && !b.removed.includes(w) ? w : null;
}

export type EntryStatus =
  | { state: 'alive' }
  | { state: 'eliminated'; round: number }
  | { state: 'removed' }
  | { state: 'champion' };

export function entryStatus(b: Bracket, entryId: string): EntryStatus {
  if (b.removed.includes(entryId)) return { state: 'removed' };
  if (champion(b) === entryId) return { state: 'champion' };
  for (const m of allMatches(b)) {
    if (m.winner !== null && m.winner !== entryId && (m.a === entryId || m.b === entryId)) {
      return { state: 'eliminated', round: m.round };
    }
  }
  return { state: 'alive' };
}

export type RoundKind = 'final' | 'semifinals' | 'quarterfinals' | 'round';

/** How a round is named: the last three rounds have names, earlier ones are numbered (round + 1). */
export function roundKind(round: number, roundCount: number): RoundKind {
  const fromEnd = roundCount - round;
  if (fromEnd === 1) return 'final';
  if (fromEnd === 2) return 'semifinals';
  if (fromEnd === 3) return 'quarterfinals';
  return 'round';
}

export type TieAction = { kind: 'revote' } | { kind: 'host' } | { kind: 'winner'; side: Side };

/** Decide a vote outcome, applying the tie-break rule when needed. */
export function resolveVotes(
  votesA: number,
  votesB: number,
  rule: 'random' | 'host' | 'suddenDeath',
  alreadySuddenDeath: boolean,
  rng: Rng = Math.random,
): TieAction {
  if (votesA > votesB) return { kind: 'winner', side: 'a' };
  if (votesB > votesA) return { kind: 'winner', side: 'b' };
  if (rule === 'suddenDeath' && !alreadySuddenDeath) return { kind: 'revote' };
  if (rule === 'host') return { kind: 'host' };
  return { kind: 'winner', side: rng() < 0.5 ? 'a' : 'b' };
}
