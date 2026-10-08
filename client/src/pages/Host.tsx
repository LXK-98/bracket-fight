import { useEffect, useRef, useState } from 'react';
import { allMatches } from '../../../shared/bracket';
import {
  MAX_VOTE_SECONDS,
  MIN_VOTE_SECONDS,
  SUDDEN_DEATH_SECONDS,
  type RoomView,
  type Settings,
} from '../../../shared/types';
import { BracketView } from '../components/Bracket';
import { Countdown } from '../components/Countdown';
import { EntryCard } from '../components/EntryCard';
import { VoteBar } from '../components/VoteBar';
import { api } from '../lib/api';
import { sound } from '../lib/sound';
import { remainingMs, useRoom, useTick } from '../lib/useRoom';

const DECIDED_BY_LABEL: Record<string, string> = {
  votes: '',
  suddenDeath: 'Won in sudden death',
  random: 'Tie broken at random',
  host: 'Tie broken by the host',
  forfeit: 'Opponent removed: advances automatically',
};

function matchProgress(view: RoomView, matchId: string | null) {
  if (!view.bracket || !matchId) return null;
  const playable = allMatches(view.bracket).filter((m) => !m.bye);
  const idx = playable.findIndex((m) => m.id === matchId);
  return idx >= 0 ? `Match ${idx + 1} of ${playable.length}` : null;
}

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg] as const;
}

/** Sound effects driven by state transitions. */
function useHostSounds(view: RoomView | null, serverNow: () => number) {
  const prev = useRef<RoomView | null>(null);
  const lastTick = useRef<number | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = view;
    if (!view || !p) return;
    if (view.phase !== p.phase) {
      if (view.phase === 'voting' && p.phase !== 'voting') sound.start();
      if (view.phase === 'reveal') sound.reveal();
      if (view.phase === 'finished') sound.champion();
    } else if (view.phase === 'lobby' && view.players.length > p.players.length) {
      sound.join();
    } else if (view.phase === 'voting' && (view.match?.votedCount ?? 0) > (p.match?.votedCount ?? 0)) {
      sound.vote();
    }
  }, [view]);
  // Countdown ticks for the last 5 seconds of a vote.
  useEffect(() => {
    if (!view || view.phase !== 'voting' || view.paused) return;
    const t = setInterval(() => {
      const ms = remainingMs(view, serverNow);
      if (ms === null) return;
      const secs = Math.ceil(ms / 1000);
      if (secs <= 5 && secs >= 1 && lastTick.current !== secs) {
        lastTick.current = secs;
        sound.tick(secs === 1);
      }
    }, 100);
    return () => clearInterval(t);
  }, [view, serverNow]);
}

export function HostPage({ code }: { code: string }) {
  const conn = useRoom(code, 'host');
  const { view, fatal, connected, emit, serverNow } = conn;
  const [toast, setToast] = useToast();
  const [manage, setManage] = useState(false);
  const [soundOn, setSoundOn] = useState(sound.enabled);
  useHostSounds(view, serverNow);

  const act = async (event: string, payload?: object) => {
    sound.unlock();
    const res = await emit(event, payload);
    if (!res.ok) setToast(res.error);
    return res.ok;
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => setToast('Fullscreen is not available here.'));
  };

  // Keyboard shortcuts for laptops: F fullscreen, Space pause/resume, N next.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!view || (e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
      if (view.phase === 'lobby' || view.phase === 'finished') return;
      if (e.key === ' ') {
        e.preventDefault();
        void act(view.paused ? 'host:resume' : 'host:pause');
      }
      if (e.key === 'n' || e.key === 'N') void act('host:advance');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (fatal) {
    return (
      <main className="center-screen">
        <h1>{fatal}</h1>
        <a className="btn btn-primary btn-big" href="/">
          Back to start
        </a>
      </main>
    );
  }
  if (!view) return <main className="center-screen">Connecting…</main>;

  const inGame = view.phase !== 'lobby';

  return (
    <div className={`host phase-${view.phase}`} onPointerDown={() => sound.unlock()}>
      <header className="host-bar">
        <div className="host-bar-left">
          <span className="logo small">
            <span className="logo-a">Image</span> <span className="logo-b">Bracket</span>
          </span>
          {inGame && (
            <span className="host-code">
              Join: <b>{view.code}</b>
            </span>
          )}
          {!connected && <span className="pill pill-warn">Reconnecting…</span>}
        </div>
        <div className="host-bar-right">
          <button className="btn btn-ghost" onClick={() => setManage(true)}>
            Players ({view.players.length})
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              sound.setEnabled(!soundOn);
              setSoundOn(!soundOn);
            }}
            aria-pressed={soundOn}
            title="Toggle sound effects"
          >
            {soundOn ? '🔊' : '🔇'}
          </button>
          <button className="btn btn-ghost" onClick={toggleFullscreen} title="Full screen (F)">
            ⛶
          </button>
        </div>
      </header>

      <main className="host-main">
        {view.phase === 'lobby' && <Lobby view={view} act={act} onError={setToast} />}
        {(view.phase === 'voting' || view.phase === 'tiebreak' || view.phase === 'reveal') && (
          <MatchScreen view={view} serverNow={serverNow} act={act} />
        )}
        {view.phase === 'overview' && <Overview view={view} serverNow={serverNow} />}
        {view.phase === 'finished' && <Finished view={view} />}
      </main>

      {inGame && <HostControls view={view} act={act} />}
      {manage && <ManageDialog view={view} act={act} onClose={() => setManage(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ lobby

function Lobby({
  view,
  act,
  onError,
}: {
  view: RoomView;
  act: (e: string, p?: object) => Promise<boolean>;
  onError: (m: string) => void;
}) {
  const [info, setInfo] = useState<{ joinUrl: string; qrSvg: string } | null>(null);
  useEffect(() => {
    api.joinInfo(view.code).then(setInfo, (e) => onError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.code]);

  const { lobby } = view;
  const roleLabel = { undecided: 'Choosing…', competitor: 'Competing', voter: 'Voting' } as const;
  const sorted = [...view.players].sort((a, b) => {
    const order = { competitor: 0, voter: 1, undecided: 2 };
    return order[a.role] - order[b.role];
  });

  return (
    <div className="lobby">
      <section className="lobby-join">
        <div className="join-steps">Scan to join, or go to</div>
        <div className="join-url">{info ? info.joinUrl.replace(/^https?:\/\//, '').replace(/\/join\/.*$/, '') : '…'}</div>
        <div className="qr" dangerouslySetInnerHTML={info ? { __html: info.qrSvg } : undefined} aria-label="QR code to join" />
        <div className="room-code-label">Room code</div>
        <div className="room-code">{view.code}</div>
      </section>

      <section className="lobby-side">
        <div className="lobby-players">
          <h2>
            Players <span className="muted">{view.players.length}</span>
          </h2>
          {view.players.length === 0 && <p className="muted big-hint">Waiting for players to join…</p>}
          <ul className="player-grid">
            {sorted.map((p) => (
              <li key={p.id} className={`player-chip role-${p.role} ${p.connected ? '' : 'offline'}`}>
                <span className="player-name">{p.name}</span>
                <span className="player-role">
                  {roleLabel[p.role]}
                  {p.role === 'competitor' && (p.submitted ? ' ✓' : ' ⏳')}
                </span>
                <button className="kick" title={`Kick ${p.name}`} onClick={() => confirm(`Kick ${p.name}?`) && act('host:kick', { playerId: p.id })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="lobby-status">
          <div className="stat">
            <b>
              {lobby.submittedCount}/{lobby.competitorCount}
            </b>{' '}
            entries submitted
          </div>
          {lobby.competitorCount >= 2 && lobby.competitorCount <= lobby.maxEntries && (
            <div className="stat">
              Bracket of <b>{lobby.bracketSize}</b>
              {lobby.byes > 0 && (
                <>
                  {' '}
                  · <b>{lobby.byes}</b> bye{lobby.byes === 1 ? '' : 's'}
                </>
              )}
            </div>
          )}
          {lobby.competitorsFull && <div className="stat warn">Bracket full: new players can only vote</div>}
        </div>

        <button className="btn btn-primary btn-huge" disabled={!lobby.canStart} onClick={() => act('host:start')}>
          Start game
        </button>
        {lobby.startBlockedReason && <p className="start-reason">{lobby.startBlockedReason}</p>}

        <SettingsPanel settings={view.settings} act={act} />
      </section>
    </div>
  );
}

function SettingsPanel({ settings, act }: { settings: Settings; act: (e: string, p?: object) => Promise<boolean> }) {
  const set = (patch: Partial<Settings>) => act('host:settings', patch);
  const timerOptions = [...new Set([10, 15, 20, 30, 45, 60, 90, 120, settings.voteSeconds])]
    .filter((s) => s >= MIN_VOTE_SECONDS && s <= MAX_VOTE_SECONDS)
    .sort((a, b) => a - b);
  return (
    <details className="settings" open>
      <summary>Settings</summary>
      <div className="settings-grid">
        <label>
          Max entries
          <select
            value={String(settings.maxEntries)}
            onChange={(e) => set({ maxEntries: e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as Settings['maxEntries']) })}
          >
            <option value="auto">Auto (up to 32)</option>
            {[4, 8, 16, 32].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Vote timer
          <select value={settings.voteSeconds} onChange={(e) => set({ voteSeconds: Number(e.target.value) })}>
            {timerOptions.map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </label>
        <label>
          Entries
          <select value={settings.entryMode} onChange={(e) => set({ entryMode: e.target.value as Settings['entryMode'] })}>
            <option value="imageOrText">Image and/or text</option>
            <option value="image">Image only</option>
            <option value="text">Text only</option>
          </select>
        </label>
        <label>
          Ties
          <select value={settings.tieBreak} onChange={(e) => set({ tieBreak: e.target.value as Settings['tieBreak'] })}>
            <option value="suddenDeath">{SUDDEN_DEATH_SECONDS}s sudden death, then random</option>
            <option value="random">Random</option>
            <option value="host">Host decides</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.showLiveVotes} onChange={(e) => set({ showLiveVotes: e.target.checked })} />
          Show live vote counts
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.allowSelfVote} onChange={(e) => set({ allowSelfVote: e.target.checked })} />
          Contestants may vote in their own matchup
        </label>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ match

function MatchScreen({
  view,
  serverNow,
  act,
}: {
  view: RoomView;
  serverNow: () => number;
  act: (e: string, p?: object) => Promise<boolean>;
}) {
  useTick(200);
  const m = view.match;
  if (!m) return null;
  const ea = view.entries[m.a];
  const eb = view.entries[m.b];
  const reveal = view.phase === 'reveal';
  const tie = view.phase === 'tiebreak';
  const ms = remainingMs(view, serverNow);
  const total = (m.suddenDeath ? SUDDEN_DEATH_SECONDS : view.settings.voteSeconds) * 1000;
  const showCounts = m.votesA !== null && m.votesB !== null;
  const cardClass = (side: 'a' | 'b') => (reveal ? (m.winner === side ? 'winner' : 'loser') : '');

  return (
    <div className="match-screen">
      <div className="match-head">
        <h2>{m.roundName}</h2>
        <span className="muted">{matchProgress(view, m.matchId)}</span>
        {m.suddenDeath && view.phase === 'voting' && <span className="pill pill-hot">Sudden death!</span>}
      </div>

      <div className="versus">
        <EntryCard entry={ea} side="a" className={`big ${cardClass('a')}`} badge={reveal && m.winner === 'a' ? 'WINNER' : undefined}>
          {tie && (
            <button className="btn btn-primary pick" onClick={() => act('host:pickWinner', { side: 'a' })}>
              Pick this one
            </button>
          )}
        </EntryCard>
        <div className="vs-col">
          {view.phase === 'voting' ? (
            <Countdown ms={ms} totalMs={total} paused={view.paused} />
          ) : (
            <div className="vs">{tie ? 'TIE' : 'VS'}</div>
          )}
        </div>
        <EntryCard entry={eb} side="b" className={`big ${cardClass('b')}`} badge={reveal && m.winner === 'b' ? 'WINNER' : undefined}>
          {tie && (
            <button className="btn btn-primary pick" onClick={() => act('host:pickWinner', { side: 'b' })}>
              Pick this one
            </button>
          )}
        </EntryCard>
      </div>

      <div className="match-foot">
        {showCounts && m.decidedBy !== 'forfeit' && <VoteBar a={m.votesA!} b={m.votesB!} winner={m.winner} />}
        {view.phase === 'voting' && (
          <div className="voted-count">
            <b>{m.votedCount}</b> / {m.eligibleCount} voted{!showCounts && ' · results at the reveal'}
          </div>
        )}
        {tie && <div className="tie-msg">It's a tie! Host, pick the winner.</div>}
        {reveal && m.decidedBy && DECIDED_BY_LABEL[m.decidedBy] && <div className="decided-by">{DECIDED_BY_LABEL[m.decidedBy]}</div>}
      </div>
    </div>
  );
}

function Overview({ view, serverNow }: { view: RoomView; serverNow: () => number }) {
  useTick(250);
  const b = view.bracket!;
  const next = view.nextMatchId ? allMatches(b).find((m) => m.id === view.nextMatchId) : null;
  const ms = remainingMs(view, serverNow);
  const focusRound = b.size >= 16 && next ? next.round : null;
  const ea = next?.a ? view.entries[next.a] : undefined;
  const eb = next?.b ? view.entries[next.b] : undefined;
  return (
    <div className="overview">
      <div className="overview-head">
        <h2>
          Up next: <span className="side-a-text">{ea?.ownerName}</span> vs <span className="side-b-text">{eb?.ownerName}</span>
        </h2>
        <span className="muted">
          {matchProgress(view, view.nextMatchId)}
          {ms !== null && !view.paused && ` · starting in ${Math.ceil(ms / 1000)}s`}
          {view.paused && ' · paused'}
        </span>
      </div>
      <BracketView bracket={b} entries={view.entries} highlight={view.nextMatchId} focusRound={focusRound} />
    </div>
  );
}

function Finished({ view }: { view: RoomView }) {
  const champ = view.champion ? view.entries[view.champion] : undefined;
  return (
    <div className="finished">
      {champ ? (
        <div className="champion">
          <div className="confetti" aria-hidden="true">
            {Array.from({ length: 40 }, (_, i) => (
              <i
                key={i}
                style={{
                  left: `${(i * 37) % 100}%`,
                  background: `hsl(${i * 47}, 90%, 60%)`,
                  animationDuration: `${2.5 + ((i * 13) % 20) / 10}s`,
                  animationDelay: `${((i * 7) % 15) / 10}s`,
                }}
              />
            ))}
          </div>
          <div className="champion-title">🏆 Champion 🏆</div>
          <EntryCard entry={champ} className="champion-card" />
        </div>
      ) : (
        <div className="champion">
          <div className="champion-title">No champion: every entry was removed.</div>
        </div>
      )}
      <div className="finished-bracket">
        <BracketView bracket={view.bracket!} entries={view.entries} maxScale={1.2} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ controls

function HostControls({ view, act }: { view: RoomView; act: (e: string, p?: object) => Promise<boolean> }) {
  const timed = view.phase === 'voting' || view.phase === 'reveal' || view.phase === 'overview';
  const nextLabel = { voting: 'End vote', reveal: 'Next', overview: 'Start match', tiebreak: '', lobby: '', finished: '' }[view.phase];
  return (
    <footer className="host-controls">
      {view.phase === 'finished' ? (
        <button className="btn btn-primary btn-big" onClick={() => act('host:playAgain')}>
          Play again
        </button>
      ) : (
        <>
          {timed && (
            <button className="btn btn-secondary" onClick={() => act(view.paused ? 'host:resume' : 'host:pause')}>
              {view.paused ? '▶ Resume' : '❚❚ Pause'}
            </button>
          )}
          {view.phase === 'voting' && (
            <button className="btn btn-secondary" onClick={() => act('host:skipTimer')}>
              ⏭ Skip timer
            </button>
          )}
          {nextLabel && view.phase !== 'voting' && (
            <button className="btn btn-primary" onClick={() => act('host:advance')}>
              {nextLabel} →
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={() => confirm('End this game and go back to the lobby? Entries will be cleared.') && act('host:playAgain')}
          >
            Reset
          </button>
        </>
      )}
    </footer>
  );
}

function ManageDialog({
  view,
  act,
  onClose,
}: {
  view: RoomView;
  act: (e: string, p?: object) => Promise<boolean>;
  onClose: () => void;
}) {
  const inGame = view.bracket !== null && view.phase !== 'finished';
  const removed = new Set(view.bracket?.removed ?? []);
  const entries = Object.values(view.entries);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Manage players">
        <div className="modal-head">
          <h2>Players</h2>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <ul className="manage-list">
          {view.players.map((p) => (
            <li key={p.id}>
              <span className={`dot ${p.connected ? 'on' : 'off'}`} />
              <span className="grow">{p.name}</span>
              <span className="muted">{p.role}</span>
              <button className="btn btn-small btn-danger" onClick={() => confirm(`Kick ${p.name}?`) && act('host:kick', { playerId: p.id })}>
                Kick
              </button>
            </li>
          ))}
          {view.players.length === 0 && <li className="muted">No players yet.</li>}
        </ul>
        {inGame && entries.length > 0 && (
          <>
            <h2>Entries</h2>
            <p className="muted">Removing an entry lets its opponent advance.</p>
            <ul className="manage-list">
              {entries.map((e) => (
                <li key={e.id}>
                  <span className="grow">
                    {e.ownerName}
                    {e.text && <span className="muted"> · {e.text.slice(0, 40)}</span>}
                  </span>
                  {removed.has(e.id) ? (
                    <span className="muted">removed</span>
                  ) : (
                    <button
                      className="btn btn-small btn-danger"
                      onClick={() => confirm(`Remove ${e.ownerName}'s entry from the bracket?`) && act('host:removeEntry', { entryId: e.id })}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
