import { describe, expect, it } from 'vitest';
import {
  allMatches,
  bracketSizeFor,
  champion,
  createBracket,
  entryStatus,
  isComplete,
  nextPlayableMatch,
  recordResult,
  removeEntry,
  resolveVotes,
  roundName,
  seedOrder,
  type Bracket,
  type Rng,
} from '../shared/bracket';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

/** Play the bracket to completion, side a always winning. */
function playOut(b: Bracket): Bracket {
  let m = nextPlayableMatch(b);
  let guard = 0;
  while (m) {
    b = recordResult(b, m.id, 'a', 'votes', 3, 1);
    m = nextPlayableMatch(b);
    if (++guard > 100) throw new Error('bracket did not terminate');
  }
  return b;
}

/** Number of byes in each half/quarter/... subtree of round 0. */
function byesPerSubtree(b: Bracket, parts: number): number[] {
  const per = b.rounds[0].length / parts;
  return Array.from({ length: parts }, (_, p) =>
    b.rounds[0].slice(p * per, (p + 1) * per).filter((m) => m.bye).length,
  );
}

describe('seedOrder', () => {
  it('produces standard seeding', () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe('bracketSizeFor', () => {
  it('rounds up to a power of two, capped by max', () => {
    expect(bracketSizeFor(2, 32)).toBe(2);
    expect(bracketSizeFor(3, 32)).toBe(4);
    expect(bracketSizeFor(5, 32)).toBe(8);
    expect(bracketSizeFor(9, 32)).toBe(16);
    expect(bracketSizeFor(17, 32)).toBe(32);
    expect(bracketSizeFor(9, 8)).toBe(8);
  });
});

describe('createBracket', () => {
  const cases: Array<[number, number, number]> = [
    // entries, size, byes
    [2, 2, 0],
    [3, 4, 1],
    [5, 8, 3],
    [7, 8, 1],
    [8, 8, 0],
    [9, 16, 7],
    [16, 16, 0],
    [17, 32, 15],
  ];

  for (const [n, size, byes] of cases) {
    describe(`${n} entries`, () => {
      for (const seed of [1, 2, 3, 42, 1337]) {
        it(`has the right shape (seed ${seed})`, () => {
          const b = createBracket(ids(n), seeded(seed));
          expect(b.size).toBe(size);
          expect(b.rounds).toHaveLength(Math.log2(size));
          expect(b.rounds[0]).toHaveLength(size / 2);

          // Every entry appears exactly once in round 0.
          const r0 = b.rounds[0].flatMap((m) => [m.a, m.b]).filter((x) => x !== null);
          expect(r0.sort()).toEqual(ids(n).sort());

          // Exactly size - n byes, never two byes against each other.
          const byeMatches = b.rounds[0].filter((m) => m.bye);
          expect(byeMatches).toHaveLength(byes);
          for (const m of byeMatches) {
            expect(m.a).not.toBeNull();
            expect(m.b).toBeNull();
            expect(m.winner).toBe(m.a);
            expect(m.decidedBy).toBe('bye');
          }
          for (const m of b.rounds[0].filter((m) => !m.bye)) {
            expect(m.a).not.toBeNull();
            expect(m.b).not.toBeNull();
            expect(m.winner).toBeNull();
          }

          // Byes advanced into round 2, which ends up a clean power of two.
          if (b.rounds.length > 1) {
            const advanced = b.rounds[1].flatMap((m) => [m.a, m.b]).filter((x) => x !== null);
            expect(advanced).toHaveLength(byes);
          }

          // Byes are spread: sibling subtrees differ by at most one bye.
          for (let parts = 2; parts <= b.rounds[0].length; parts *= 2) {
            const counts = byesPerSubtree(b, parts);
            for (let i = 0; i < counts.length; i += 2) {
              expect(Math.abs(counts[i] - counts[i + 1])).toBeLessThanOrEqual(1);
            }
          }
        });
      }

      it('plays out to a single champion with log2(size) wins max', () => {
        const b = playOut(createBracket(ids(n), seeded(7)));
        expect(isComplete(b)).toBe(true);
        const champ = champion(b);
        expect(champ).not.toBeNull();
        // Exactly n - 1 entries were eliminated.
        const eliminated = ids(n).filter((id) => entryStatus(b, id).state === 'eliminated');
        expect(eliminated).toHaveLength(n - 1);
        expect(entryStatus(b, champ!).state).toBe('champion');
        // Number of voted matches = n - 1 (byes are free).
        expect(allMatches(b).filter((m) => m.decidedBy === 'votes')).toHaveLength(n - 1);
      });
    });
  }

  it('randomises seeding', () => {
    const a = createBracket(ids(8), seeded(1)).rounds[0].map((m) => m.a);
    const b = createBracket(ids(8), seeded(2)).rounds[0].map((m) => m.a);
    expect(a).not.toEqual(b);
  });

  it('rejects fewer than 2 entries and duplicates', () => {
    expect(() => createBracket(['x'])).toThrow();
    expect(() => createBracket(['x', 'x'])).toThrow();
  });

  it('spreads byes for every entry count up to 32', () => {
    for (let n = 2; n <= 32; n++) {
      const b = createBracket(ids(n), seeded(n));
      for (const m of b.rounds[0]) expect(m.a === null && m.b === null).toBe(false);
      const counts = byesPerSubtree(b, 2 > b.rounds[0].length ? 1 : 2);
      if (counts.length === 2) expect(Math.abs(counts[0] - counts[1])).toBeLessThanOrEqual(1);
    }
  });
});

describe('match flow', () => {
  it('records results and advances winners', () => {
    let b = createBracket(ids(4), seeded(3));
    const first = nextPlayableMatch(b)!;
    expect(first.id).toBe('r0m0');
    b = recordResult(b, first.id, 'b', 'votes', 1, 5);
    expect(b.rounds[0][0].winner).toBe(first.b);
    expect(b.rounds[0][0].votesB).toBe(5);
    expect(b.rounds[1][0].a).toBe(first.b);
    expect(nextPlayableMatch(b)!.id).toBe('r0m1');
    expect(() => recordResult(b, first.id, 'a', 'votes')).toThrow();
    expect(() => recordResult(b, 'r1m0', 'a', 'votes')).toThrow(); // not ready
  });

  it('does not mutate its input', () => {
    const b = createBracket(ids(4), seeded(3));
    const snapshot = JSON.stringify(b);
    recordResult(b, 'r0m0', 'a', 'votes');
    removeEntry(b, b.rounds[0][1].a!);
    expect(JSON.stringify(b)).toBe(snapshot);
  });

  it('plays rounds in order', () => {
    let b = createBracket(ids(8), seeded(9));
    const order: string[] = [];
    let m = nextPlayableMatch(b);
    while (m) {
      order.push(m.id);
      b = recordResult(b, m.id, 'a', 'votes');
      m = nextPlayableMatch(b);
    }
    expect(order).toEqual(['r0m0', 'r0m1', 'r0m2', 'r0m3', 'r1m0', 'r1m1', 'r2m0']);
  });

  it('names rounds', () => {
    expect(roundName(0, 5)).toBe('Round 1');
    expect(roundName(2, 5)).toBe('Quarterfinals');
    expect(roundName(3, 5)).toBe('Semifinals');
    expect(roundName(4, 5)).toBe('Final');
  });
});

describe('ties', () => {
  it('picks the higher vote count', () => {
    expect(resolveVotes(3, 1, 'random', false)).toEqual({ kind: 'winner', side: 'a' });
    expect(resolveVotes(0, 2, 'host', false)).toEqual({ kind: 'winner', side: 'b' });
  });

  it('sudden death revotes once, then falls back to random', () => {
    expect(resolveVotes(2, 2, 'suddenDeath', false)).toEqual({ kind: 'revote' });
    expect(resolveVotes(2, 2, 'suddenDeath', true, () => 0.1)).toEqual({ kind: 'winner', side: 'a' });
    expect(resolveVotes(2, 2, 'suddenDeath', true, () => 0.9)).toEqual({ kind: 'winner', side: 'b' });
  });

  it('host rule hands the decision to the host', () => {
    expect(resolveVotes(1, 1, 'host', false)).toEqual({ kind: 'host' });
    expect(resolveVotes(0, 0, 'host', true)).toEqual({ kind: 'host' });
  });

  it('random rule picks a side with the rng', () => {
    expect(resolveVotes(0, 0, 'random', false, () => 0.2)).toEqual({ kind: 'winner', side: 'a' });
    expect(resolveVotes(0, 0, 'random', false, () => 0.7)).toEqual({ kind: 'winner', side: 'b' });
  });

  it('records how a tie was decided', () => {
    let b = createBracket(ids(2), seeded(1));
    b = recordResult(b, 'r0m0', 'b', 'random', 2, 2);
    expect(b.rounds[0][0].decidedBy).toBe('random');
    expect(champion(b)).toBe(b.rounds[0][0].b);
  });
});

describe('entries removed mid-game', () => {
  it('opponent advances immediately when the match is ready', () => {
    let b = createBracket(ids(4), seeded(5));
    const m = b.rounds[0][0];
    b = removeEntry(b, m.a!);
    expect(b.rounds[0][0].winner).toBe(m.b);
    expect(b.rounds[0][0].decidedBy).toBe('forfeit');
    expect(b.rounds[1][0].a).toBe(m.b);
    expect(entryStatus(b, m.a!).state).toBe('removed');
    expect(nextPlayableMatch(b)!.id).toBe('r0m1');
  });

  it('opponent advances once it is known (waiting in a later round)', () => {
    let b = createBracket(ids(4), seeded(5));
    const [m0, m1] = b.rounds[0];
    b = recordResult(b, m0.id, 'a', 'votes');
    // m0's winner is waiting in the final; remove it before m1 is played.
    b = removeEntry(b, m0.a!);
    expect(b.rounds[1][0].winner).toBeNull();
    b = recordResult(b, m1.id, 'b', 'votes');
    expect(isComplete(b)).toBe(true);
    expect(champion(b)).toBe(m1.b);
    expect(b.rounds[1][0].decidedBy).toBe('forfeit');
  });

  it('a removed bye entry forfeits its next match', () => {
    let b = createBracket(ids(3), seeded(11));
    const bye = b.rounds[0].find((m) => m.bye)!;
    const real = b.rounds[0].find((m) => !m.bye)!;
    b = removeEntry(b, bye.a!);
    b = recordResult(b, real.id, 'a', 'votes');
    expect(champion(b)).toBe(real.a);
  });

  it('removing both entries of a match forfeits up the tree', () => {
    let b = createBracket(ids(4), seeded(2));
    const [m0, m1] = b.rounds[0];
    b = removeEntry(b, m0.a!);
    b = removeEntry(b, m0.b!);
    expect(b.rounds[0][0].winner).not.toBeNull();
    b = recordResult(b, m1.id, 'a', 'votes');
    expect(champion(b)).toBe(m1.a);
  });

  it('has no champion if every entry is removed', () => {
    let b = createBracket(ids(2), seeded(2));
    b = removeEntry(b, 'e1');
    b = removeEntry(b, 'e2');
    expect(isComplete(b)).toBe(true);
    expect(champion(b)).toBeNull();
  });

  it('keeps working with removals in big brackets', () => {
    let b = createBracket(ids(17), seeded(4));
    b = removeEntry(b, 'e5');
    b = removeEntry(b, 'e9');
    b = removeEntry(b, 'e9'); // idempotent
    b = playOut(b);
    expect(isComplete(b)).toBe(true);
    const champ = champion(b)!;
    expect(['e5', 'e9']).not.toContain(champ);
    expect(() => removeEntry(b, 'nope')).toThrow();
  });
});
