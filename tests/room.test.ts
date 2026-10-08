import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameError, Room } from '../server/room';

const REVEAL = 5000;
const OVERVIEW = 4000;

function makeRoom(rngValue = 0.3) {
  const deleted: string[] = [];
  const room = new Room('ABCD', {
    now: () => Date.now(),
    rng: () => rngValue,
    revealMs: REVEAL,
    overviewMs: OVERVIEW,
    maxPlayers: 50,
    onChange: () => {},
    onDeleteFile: (_r, f) => deleted.push(f),
  });
  return { room, deleted };
}

/** Join n competitors with text entries plus `voters` voters, all connected. */
function setup(n: number, voters = 0, rng?: number) {
  const { room, deleted } = makeRoom(rng);
  const comps = Array.from({ length: n }, (_, i) => {
    const p = room.join(`Comp ${i + 1}`);
    room.connect(p.id);
    room.setRole(p.id, 'competitor');
    room.submitEntry(p.id, { text: `Entry ${i + 1}`, imageFile: null, removeImage: false });
    return p;
  });
  const vs = Array.from({ length: voters }, (_, i) => {
    const p = room.join(`Voter ${i + 1}`);
    room.connect(p.id);
    room.setRole(p.id, 'voter');
    return p;
  });
  return { room, comps, voters: vs, deleted };
}

function startAndReachVoting(room: Room) {
  room.start();
  expect(room.phase).toBe('overview');
  vi.advanceTimersByTime(OVERVIEW + 2000);
  expect(room.phase).toBe('voting');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('lobby', () => {
  it('requires unique, sanitised names', () => {
    const { room } = makeRoom();
    const p = room.join('  Alice​  ');
    expect(p.name).toBe('Alice');
    expect(() => room.join('alice')).toThrow(GameError);
    expect(() => room.join('   ')).toThrow(GameError);
    expect(room.join('x'.repeat(50)).name).toHaveLength(20);
  });

  it('resumes by token', () => {
    const { room } = makeRoom();
    const p = room.join('Bob');
    expect(room.playerByToken(p.token)?.id).toBe(p.id);
    expect(room.playerByToken('nope')).toBeNull();
  });

  it('blocks start until enough competitors have submitted', () => {
    const { room } = makeRoom();
    const a = room.join('A');
    room.setRole(a.id, 'competitor');
    expect(room.lobbyInfo().canStart).toBe(false);
    expect(room.lobbyInfo().startBlocked).toEqual({
      code: 'needTwoCompetitors',
      params: { current: 1 },
      message: 'Need at least 2 competitors (1 so far).',
    });
    const b = room.join('B');
    room.setRole(b.id, 'competitor');
    room.submitEntry(a.id, { text: 'hi', imageFile: null, removeImage: false });
    expect(room.lobbyInfo().startBlocked?.message).toBe('Waiting for 1 competitor to submit an entry.');
    expect(() => room.start()).toThrow(GameError);
    try {
      room.start();
    } catch (err) {
      expect(err).toMatchObject({ code: 'waitingForEntries', params: { count: 1 } });
    }
    room.submitEntry(b.id, { text: 'yo', imageFile: null, removeImage: false });
    expect(room.lobbyInfo().canStart).toBe(true);
    expect(room.lobbyInfo().bracketSize).toBe(2);
  });

  it('enforces the entry mode', () => {
    const { room, deleted } = makeRoom();
    const a = room.join('A');
    room.setRole(a.id, 'competitor');
    room.updateSettings({ entryMode: 'image' });
    expect(() => room.submitEntry(a.id, { text: 'hi', imageFile: null, removeImage: false })).toThrow(/image/);
    room.submitEntry(a.id, { text: 'caption', imageFile: 'one.jpg', removeImage: false });
    room.submitEntry(a.id, { text: null, imageFile: 'two.jpg', removeImage: false });
    expect(deleted).toEqual(['one.jpg']);
    room.updateSettings({ entryMode: 'text' });
    expect(() => room.submitEntry(a.id, { text: 'x', imageFile: 'three.jpg', removeImage: false })).toThrow(/text/);
    expect(deleted).toContain('three.jpg'); // rejected uploads are cleaned up
  });

  it('caps competitors at the max bracket size but lets people vote', () => {
    const { room } = makeRoom();
    room.updateSettings({ maxEntries: 4 });
    for (let i = 0; i < 4; i++) room.setRole(room.join(`P${i}`).id, 'competitor');
    const late = room.join('Late');
    expect(() => room.setRole(late.id, 'competitor')).toThrow(/full/);
    room.setRole(late.id, 'voter');
    expect(room.lobbyInfo().competitorsFull).toBe(true);
  });

  it('switching to voter deletes the entry', () => {
    const { room, comps, deleted } = setup(2);
    room.submitEntry(comps[0].id, { text: 'pic', imageFile: 'a.jpg', removeImage: false });
    room.setRole(comps[0].id, 'voter');
    expect(comps[0].entryId).toBeNull();
    expect(deleted).toContain('a.jpg');
  });

  it('kicking in the lobby removes the player and entry', () => {
    const { room, comps } = setup(3);
    room.kick(comps[0].id);
    expect(room.players.size).toBe(2);
    expect(room.entries.size).toBe(2);
    expect(room.playerByToken(comps[0].token)).toBeNull();
  });

  it('hides other entries in the lobby', () => {
    const { room, comps } = setup(3);
    const view = room.view({ kind: 'player', playerId: comps[0].id });
    expect(Object.keys(view.entries)).toEqual([comps[0].entryId]);
    expect(Object.keys(room.view({ kind: 'host' }).entries)).toHaveLength(0);
  });
});

describe('match flow', () => {
  it('runs voting, reveal, overview, and finishes with a champion', () => {
    const { room, comps, voters } = setup(2, 1);
    startAndReachVoting(room);
    const matchId = room.currentMatchId!;
    room.vote(voters[0].id, matchId, 'b');
    room.vote(comps[0].id, matchId, 'b');
    expect(room.view({ kind: 'host' }).match?.votesB).toBe(2);
    vi.advanceTimersByTime(20_000);
    expect(room.phase).toBe('reveal');
    const view = room.view({ kind: 'host' });
    expect(view.match?.winner).toBe('b');
    expect(view.match?.votesB).toBe(2);
    vi.advanceTimersByTime(REVEAL);
    expect(room.phase).toBe('finished');
    const m = room.bracket!.rounds[0][0];
    expect(room.view({ kind: 'host' }).champion).toBe(m.b);
  });

  it('ends early once everyone has voted', () => {
    const { room, comps, voters } = setup(2, 1);
    startAndReachVoting(room);
    const id = room.currentMatchId!;
    for (const p of [...comps, ...voters]) room.vote(p.id, id, 'a');
    expect(room.phase).toBe('voting');
    vi.advanceTimersByTime(1500);
    expect(room.phase).toBe('reveal');
  });

  it('allows changing a vote until time runs out', () => {
    const { room, voters } = setup(2, 2);
    startAndReachVoting(room);
    const id = room.currentMatchId!;
    room.vote(voters[0].id, id, 'a');
    room.vote(voters[0].id, id, 'b');
    room.vote(voters[1].id, id, 'b');
    vi.advanceTimersByTime(20_000);
    expect(room.bracket!.rounds[0][0].votesB).toBe(2);
    expect(room.bracket!.rounds[0][0].votesA).toBe(0);
  });

  it('hides live counts when configured', () => {
    const { room, voters } = setup(2, 1);
    room.updateSettings({ showLiveVotes: false });
    startAndReachVoting(room);
    room.vote(voters[0].id, room.currentMatchId!, 'a');
    const v = room.view({ kind: 'player', playerId: voters[0].id });
    expect(v.match?.votesA).toBeNull();
    expect(v.match?.votedCount).toBe(1);
    room.skipTimer();
    expect(room.view({ kind: 'host' }).match?.votesA).toBe(1);
  });

  it('can bar contestants from voting in their own matchup', () => {
    const { room, comps, voters } = setup(2, 1);
    room.updateSettings({ allowSelfVote: false });
    startAndReachVoting(room);
    expect(() => room.vote(comps[0].id, room.currentMatchId!, 'a')).toThrow(/own matchup/);
    const v = room.view({ kind: 'player', playerId: comps[0].id });
    expect(v.me?.canVote).toBe(false);
    expect(v.me?.voteBlocked).toBe('ownMatchup');
    expect(v.match?.eligibleCount).toBe(1);
    room.vote(voters[0].id, room.currentMatchId!, 'a');
    vi.advanceTimersByTime(1500); // only eligible voter voted -> early end
    expect(room.phase).toBe('reveal');
  });

  it('pauses and resumes the timer', () => {
    const { room } = setup(2);
    room.updateSettings({ tieBreak: 'random' });
    startAndReachVoting(room);
    vi.advanceTimersByTime(5000);
    room.pause();
    expect(room.pausedRemainingMs).toBe(15_000);
    vi.advanceTimersByTime(60_000);
    expect(room.phase).toBe('voting');
    room.resume();
    vi.advanceTimersByTime(14_999);
    expect(room.phase).toBe('voting');
    vi.advanceTimersByTime(1);
    expect(room.phase).not.toBe('voting');
  });

  it('host can advance through every phase manually', () => {
    const { room, voters } = setup(3, 1);
    room.start();
    room.advance(); // overview -> voting
    expect(room.phase).toBe('voting');
    room.vote(voters[0].id, room.currentMatchId!, 'a');
    room.advance(); // voting -> reveal
    expect(room.phase).toBe('reveal');
    room.advance(); // reveal -> overview
    expect(room.phase).toBe('overview');
    room.advance();
    room.vote(voters[0].id, room.currentMatchId!, 'a');
    room.advance();
    room.advance();
    expect(room.phase).toBe('finished');
  });

  it('reports bracket status to players', () => {
    const { room, comps, voters } = setup(2, 1);
    startAndReachVoting(room);
    const m = room.bracket!.rounds[0][0];
    const loser = comps.find((c) => c.entryId === m.a)!;
    room.vote(voters[0].id, m.id, 'b');
    room.skipTimer();
    const me = room.view({ kind: 'player', playerId: loser.id }).me!;
    expect(me.entryStatus).toBe('eliminated');
    expect(me.eliminatedRound).toBe(0);
  });
});

describe('ties', () => {
  it('sudden death revote, then random', () => {
    const { room, voters } = setup(2, 2, 0.9);
    startAndReachVoting(room);
    room.vote(voters[0].id, room.currentMatchId!, 'a');
    room.vote(voters[1].id, room.currentMatchId!, 'b');
    room.skipTimer();
    expect(room.phase).toBe('voting');
    expect(room.suddenDeath).toBe(true);
    expect(room.votes.size).toBe(0);
    expect(room.phaseEndsAt! - Date.now()).toBe(10_000);
    vi.advanceTimersByTime(10_000); // nobody votes -> still tied -> random (rng 0.9 => b)
    expect(room.phase).toBe('reveal');
    const m = room.bracket!.rounds[0][0];
    expect(m.decidedBy).toBe('random');
    expect(m.winner).toBe(m.b);
  });

  it('sudden death can be won by votes', () => {
    const { room, voters } = setup(2, 1);
    startAndReachVoting(room);
    room.skipTimer(); // 0-0 tie
    room.vote(voters[0].id, room.currentMatchId!, 'a');
    room.skipTimer();
    expect(room.bracket!.rounds[0][0].decidedBy).toBe('suddenDeath');
  });

  it('host decides', () => {
    const { room } = setup(2);
    room.updateSettings({ tieBreak: 'host' });
    startAndReachVoting(room);
    room.skipTimer();
    expect(room.phase).toBe('tiebreak');
    expect(() => room.advance()).toThrow(/Pick a winner/);
    room.pickWinner('a');
    expect(room.phase).toBe('reveal');
    expect(room.bracket!.rounds[0][0].decidedBy).toBe('host');
  });

  it('random rule picks immediately', () => {
    const { room } = setup(2, 0, 0.1);
    room.updateSettings({ tieBreak: 'random' });
    startAndReachVoting(room);
    room.skipTimer();
    expect(room.phase).toBe('reveal');
    const m = room.bracket!.rounds[0][0];
    expect(m.winner).toBe(m.a);
  });
});

describe('mid-game changes', () => {
  it('removing an entry in the running match advances its opponent', () => {
    const { room } = setup(4);
    startAndReachVoting(room);
    const m = room.bracket!.rounds[0][0];
    room.removeEntry(m.a);
    expect(room.phase).toBe('reveal');
    const decided = room.bracket!.rounds[0][0];
    expect(decided.winner).toBe(m.b);
    expect(decided.decidedBy).toBe('forfeit');
    vi.advanceTimersByTime(REVEAL);
    expect(room.phase).toBe('overview');
    expect(room.nextMatchId).toBe('r0m1');
  });

  it('removing the upcoming entry during the overview skips its match', () => {
    const { room } = setup(4);
    room.start();
    const m = room.bracket!.rounds[0][0];
    room.removeEntry(m.b);
    expect(room.phase).toBe('overview');
    expect(room.nextMatchId).toBe('r0m1');
  });

  it('a disconnected competitor stays in the bracket', () => {
    const { room, comps } = setup(2);
    startAndReachVoting(room);
    room.disconnect(comps[0].id);
    expect(room.entries.has(comps[0].entryId!)).toBe(true);
    expect(room.bracket!.removed).toHaveLength(0);
  });

  it('kicking mid-game keeps the entry', () => {
    const { room, comps } = setup(2);
    startAndReachVoting(room);
    room.kick(comps[0].id);
    expect(room.view({ kind: 'host' }).entries[comps[0].entryId!]).toBeDefined();
  });

  it('late joiners become voters', () => {
    const { room } = setup(2);
    room.start();
    expect(room.join('Late').role).toBe('voter');
  });

  it('play again clears entries and roles but keeps settings and players', () => {
    const { room, deleted } = setup(2, 1);
    room.updateSettings({ voteSeconds: 30 });
    const first = [...room.players.values()][0];
    room.submitEntry(first.id, { text: 'x', imageFile: 'img.webp', removeImage: false });
    startAndReachVoting(room);
    room.playAgain();
    expect(room.phase).toBe('lobby');
    expect(room.entries.size).toBe(0);
    expect(room.bracket).toBeNull();
    expect(room.players.size).toBe(3);
    expect([...room.players.values()].every((p) => p.role === 'undecided')).toBe(true);
    expect(room.settings.voteSeconds).toBe(30);
    expect(deleted).toContain('img.webp');
    vi.advanceTimersByTime(60_000);
    expect(room.phase).toBe('lobby'); // old timers are gone
  });
});
