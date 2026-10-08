import type { TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { allMatches } from '../../../shared/bracket';
import {
  AUTO_MAX_ENTRIES,
  MAX_VOTE_SECONDS,
  MIN_VOTE_SECONDS,
  SUDDEN_DEATH_SECONDS,
  type DecidedBy,
  type RoomView,
  type Settings,
} from '../../../shared/types';
import { BracketView } from '../components/Bracket';
import { Countdown } from '../components/Countdown';
import { EntryCard } from '../components/EntryCard';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { VoteBar } from '../components/VoteBar';
import { problemText, roundLabel, tNodes, toProblem, type Problem } from '../i18n/text';
import { api } from '../lib/api';
import { sound } from '../lib/sound';
import { ackProblem, remainingMs, useRoom, useTick } from '../lib/useRoom';

type Act = (event: string, payload?: object) => Promise<boolean>;

function decidedByText(t: TFunction, decidedBy: DecidedBy | null): string | null {
  switch (decidedBy) {
    case 'suddenDeath':
      return t('host.match.decidedBy.suddenDeath');
    case 'random':
      return t('host.match.decidedBy.random');
    case 'host':
      return t('host.match.decidedBy.host');
    case 'forfeit':
      return t('host.match.decidedBy.forfeit');
    default:
      return null;
  }
}

function matchProgress(t: TFunction, view: RoomView, matchId: string | null) {
  if (!view.bracket || !matchId) return null;
  const playable = allMatches(view.bracket).filter((m) => !m.bye);
  const idx = playable.findIndex((m) => m.id === matchId);
  return idx >= 0 ? t('host.match.progress', { current: idx + 1, total: playable.length }) : null;
}

function useToast() {
  const [msg, setMsg] = useState<Problem | null>(null);
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
  const { t } = useTranslation();
  const conn = useRoom(code, 'host');
  const { view, fatal, connected, emit, serverNow } = conn;
  const [toast, setToast] = useToast();
  const [manage, setManage] = useState(false);
  const [soundOn, setSoundOn] = useState(sound.enabled);
  useHostSounds(view, serverNow);

  const act: Act = async (event, payload) => {
    sound.unlock();
    const res = await emit(event, payload);
    if (!res.ok) setToast(ackProblem(res));
    return res.ok;
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => setToast({ code: 'fullscreenUnavailable' }));
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
        <h1>{problemText(t, fatal)}</h1>
        <a className="btn btn-primary btn-big" href="/">
          {t('common.backToStart')}
        </a>
      </main>
    );
  }
  if (!view) return <main className="center-screen">{t('common.connecting')}</main>;

  const inGame = view.phase !== 'lobby';

  return (
    <div className={`host phase-${view.phase}`} onPointerDown={() => sound.unlock()}>
      <header className="host-bar">
        <div className="host-bar-left">
          <span className="logo small">
            <span className="logo-a">Image</span> <span className="logo-b">Bracket</span>
          </span>
          {inGame && <span className="host-code">{tNodes(t, 'host.join', { code: <b>{view.code}</b> })}</span>}
          {!connected && <span className="pill pill-warn">{t('common.reconnecting')}</span>}
        </div>
        <div className="host-bar-right">
          <LanguageSwitcher />
          <button className="btn btn-ghost" onClick={() => setManage(true)}>
            {t('host.players', { count: view.players.length })}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              sound.setEnabled(!soundOn);
              setSoundOn(!soundOn);
            }}
            aria-pressed={soundOn}
            title={t('host.toggleSound')}
          >
            {soundOn ? '🔊' : '🔇'}
          </button>
          <button className="btn btn-ghost" onClick={toggleFullscreen} title={t('host.fullscreen')}>
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
      {toast && <div className="toast">{problemText(t, toast)}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ lobby

function Lobby({ view, act, onError }: { view: RoomView; act: Act; onError: (p: Problem) => void }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<{ joinUrl: string; qrSvg: string } | null>(null);
  useEffect(() => {
    api.joinInfo(view.code).then(setInfo, (e) => onError(toProblem(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.code]);

  const { lobby } = view;
  const sorted = [...view.players].sort((a, b) => {
    const order = { competitor: 0, voter: 1, undecided: 2 };
    return order[a.role] - order[b.role];
  });

  return (
    <div className="lobby">
      <section className="lobby-join">
        <div className="join-steps">{t('host.lobby.scanToJoin')}</div>
        <div className="join-url">{info ? info.joinUrl.replace(/^https?:\/\//, '').replace(/\/join\/.*$/, '') : '…'}</div>
        <div className="qr" dangerouslySetInnerHTML={info ? { __html: info.qrSvg } : undefined} aria-label={t('host.lobby.qrLabel')} />
        <div className="room-code-label">{t('host.lobby.roomCode')}</div>
        <div className="room-code">{view.code}</div>
      </section>

      <section className="lobby-side">
        <div className="lobby-players">
          <h2>
            {t('host.lobby.players')} <span className="muted">{view.players.length}</span>
          </h2>
          {view.players.length === 0 && <p className="muted big-hint">{t('host.lobby.waitingForPlayers')}</p>}
          <ul className="player-grid">
            {sorted.map((p) => (
              <li key={p.id} className={`player-chip role-${p.role} ${p.connected ? '' : 'offline'}`}>
                <span className="player-name">{p.name}</span>
                <span className="player-role">
                  {t(`roles.${p.role}`)}
                  {p.role === 'competitor' && (p.submitted ? ' ✓' : ' ⏳')}
                </span>
                <button
                  className="kick"
                  title={t('host.lobby.kick', { name: p.name })}
                  onClick={() => confirm(t('host.lobby.kickConfirm', { name: p.name })) && act('host:kick', { playerId: p.id })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="lobby-status">
          <div className="stat">
            {tNodes(t, 'host.lobby.submitted', {
              submitted: (
                <b>
                  {lobby.submittedCount}/{lobby.competitorCount}
                </b>
              ),
            })}
          </div>
          {lobby.competitorCount >= 2 && lobby.competitorCount <= lobby.maxEntries && (
            <div className="stat">
              {tNodes(t, 'host.lobby.bracketSize', { size: <b>{lobby.bracketSize}</b> })}
              {lobby.byes > 0 && <> · {tNodes(t, 'host.lobby.byes', { n: <b>{lobby.byes}</b> }, { count: lobby.byes })}</>}
            </div>
          )}
          {lobby.competitorsFull && <div className="stat warn">{t('host.lobby.bracketFull')}</div>}
        </div>

        <button className="btn btn-primary btn-huge" disabled={!lobby.canStart} onClick={() => act('host:start')}>
          {t('host.lobby.start')}
        </button>
        {lobby.startBlocked && <p className="start-reason">{problemText(t, lobby.startBlocked)}</p>}

        <SettingsPanel settings={view.settings} act={act} />
      </section>
    </div>
  );
}

function SettingsPanel({ settings, act }: { settings: Settings; act: Act }) {
  const { t } = useTranslation();
  const set = (patch: Partial<Settings>) => act('host:settings', patch);
  const timerOptions = [...new Set([10, 15, 20, 30, 45, 60, 90, 120, settings.voteSeconds])]
    .filter((s) => s >= MIN_VOTE_SECONDS && s <= MAX_VOTE_SECONDS)
    .sort((a, b) => a - b);
  return (
    <details className="settings" open>
      <summary>{t('host.settings.title')}</summary>
      <div className="settings-grid">
        <label>
          {t('host.settings.maxEntries')}
          <select
            value={String(settings.maxEntries)}
            onChange={(e) => set({ maxEntries: e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as Settings['maxEntries']) })}
          >
            <option value="auto">{t('host.settings.auto', { max: AUTO_MAX_ENTRIES })}</option>
            {[4, 8, 16, 32].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('host.settings.voteTimer')}
          <select value={settings.voteSeconds} onChange={(e) => set({ voteSeconds: Number(e.target.value) })}>
            {timerOptions.map((s) => (
              <option key={s} value={s}>
                {t('host.settings.seconds', { count: s })}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('host.settings.entries')}
          <select value={settings.entryMode} onChange={(e) => set({ entryMode: e.target.value as Settings['entryMode'] })}>
            <option value="imageOrText">{t('host.settings.imageOrText')}</option>
            <option value="image">{t('host.settings.imageOnly')}</option>
            <option value="text">{t('host.settings.textOnly')}</option>
          </select>
        </label>
        <label>
          {t('host.settings.ties')}
          <select value={settings.tieBreak} onChange={(e) => set({ tieBreak: e.target.value as Settings['tieBreak'] })}>
            <option value="suddenDeath">{t('host.settings.suddenDeath', { seconds: SUDDEN_DEATH_SECONDS })}</option>
            <option value="random">{t('host.settings.random')}</option>
            <option value="host">{t('host.settings.hostDecides')}</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.showLiveVotes} onChange={(e) => set({ showLiveVotes: e.target.checked })} />
          {t('host.settings.showLiveVotes')}
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.allowSelfVote} onChange={(e) => set({ allowSelfVote: e.target.checked })} />
          {t('host.settings.allowSelfVote')}
        </label>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ match

function MatchScreen({ view, serverNow, act }: { view: RoomView; serverNow: () => number; act: Act }) {
  const { t } = useTranslation();
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
  const decidedBy = reveal ? decidedByText(t, m.decidedBy) : null;
  const card = (side: 'a' | 'b') => (
    <EntryCard
      entry={side === 'a' ? ea : eb}
      side={side}
      className={`big ${cardClass(side)}`}
      badge={reveal && m.winner === side ? t('host.match.winner') : undefined}
    >
      {tie && (
        <button className="btn btn-primary pick" onClick={() => act('host:pickWinner', { side })}>
          {t('host.match.pickThis')}
        </button>
      )}
    </EntryCard>
  );

  return (
    <div className="match-screen">
      <div className="match-head">
        <h2>{roundLabel(t, m.round, view.bracket!.rounds.length)}</h2>
        <span className="muted">{matchProgress(t, view, m.matchId)}</span>
        {m.suddenDeath && view.phase === 'voting' && <span className="pill pill-hot">{t('host.match.suddenDeath')}</span>}
      </div>

      <div className="versus">
        {card('a')}
        <div className="vs-col">
          {view.phase === 'voting' ? (
            <Countdown ms={ms} totalMs={total} paused={view.paused} />
          ) : (
            <div className="vs">{tie ? t('host.match.tie') : t('host.match.vs')}</div>
          )}
        </div>
        {card('b')}
      </div>

      <div className="match-foot">
        {showCounts && m.decidedBy !== 'forfeit' && <VoteBar a={m.votesA!} b={m.votesB!} winner={m.winner} />}
        {view.phase === 'voting' && (
          <div className="voted-count">
            {tNodes(t, 'host.match.voted', { voted: <b>{m.votedCount}</b> }, { eligible: m.eligibleCount })}
            {!showCounts && <> · {t('host.match.resultsAtReveal')}</>}
          </div>
        )}
        {tie && <div className="tie-msg">{t('host.match.tieHost')}</div>}
        {decidedBy && <div className="decided-by">{decidedBy}</div>}
      </div>
    </div>
  );
}

function Overview({ view, serverNow }: { view: RoomView; serverNow: () => number }) {
  const { t } = useTranslation();
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
          {tNodes(t, 'host.overview.upNext', {
            a: <span className="side-a-text">{ea?.ownerName}</span>,
            b: <span className="side-b-text">{eb?.ownerName}</span>,
          })}
        </h2>
        <span className="muted">
          {matchProgress(t, view, view.nextMatchId)}
          {ms !== null && !view.paused && ` · ${t('host.overview.startingIn', { count: Math.ceil(ms / 1000) })}`}
          {view.paused && ` · ${t('host.overview.paused')}`}
        </span>
      </div>
      <BracketView bracket={b} entries={view.entries} highlight={view.nextMatchId} focusRound={focusRound} />
    </div>
  );
}

function Finished({ view }: { view: RoomView }) {
  const { t } = useTranslation();
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
          <div className="champion-title">{t('host.finished.champion')}</div>
          <EntryCard entry={champ} className="champion-card" />
        </div>
      ) : (
        <div className="champion">
          <div className="champion-title">{t('host.finished.noChampion')}</div>
        </div>
      )}
      <div className="finished-bracket">
        <BracketView bracket={view.bracket!} entries={view.entries} maxScale={1.2} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ controls

function HostControls({ view, act }: { view: RoomView; act: Act }) {
  const { t } = useTranslation();
  const timed = view.phase === 'voting' || view.phase === 'reveal' || view.phase === 'overview';
  const nextLabel = view.phase === 'reveal' ? t('host.controls.next') : view.phase === 'overview' ? t('host.controls.startMatch') : null;
  return (
    <footer className="host-controls">
      {view.phase === 'finished' ? (
        <button className="btn btn-primary btn-big" onClick={() => act('host:playAgain')}>
          {t('host.controls.playAgain')}
        </button>
      ) : (
        <>
          {timed && (
            <button className="btn btn-secondary" onClick={() => act(view.paused ? 'host:resume' : 'host:pause')}>
              {view.paused ? t('host.controls.resume') : t('host.controls.pause')}
            </button>
          )}
          {view.phase === 'voting' && (
            <button className="btn btn-secondary" onClick={() => act('host:skipTimer')}>
              {t('host.controls.skipTimer')}
            </button>
          )}
          {nextLabel && (
            <button className="btn btn-primary" onClick={() => act('host:advance')}>
              {nextLabel}
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => confirm(t('host.controls.resetConfirm')) && act('host:playAgain')}>
            {t('host.controls.reset')}
          </button>
        </>
      )}
    </footer>
  );
}

function ManageDialog({ view, act, onClose }: { view: RoomView; act: Act; onClose: () => void }) {
  const { t } = useTranslation();
  const inGame = view.bracket !== null && view.phase !== 'finished';
  const removed = new Set(view.bracket?.removed ?? []);
  const entries = Object.values(view.entries);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('host.manage.label')}>
        <div className="modal-head">
          <h2>{t('host.manage.players')}</h2>
          <button className="btn btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <ul className="manage-list">
          {view.players.map((p) => (
            <li key={p.id}>
              <span className={`dot ${p.connected ? 'on' : 'off'}`} />
              <span className="grow">{p.name}</span>
              <span className="muted">{t(`roles.${p.role}`)}</span>
              <button
                className="btn btn-small btn-danger"
                onClick={() => confirm(t('host.lobby.kickConfirm', { name: p.name })) && act('host:kick', { playerId: p.id })}
              >
                {t('host.manage.kick')}
              </button>
            </li>
          ))}
          {view.players.length === 0 && <li className="muted">{t('host.manage.noPlayers')}</li>}
        </ul>
        {inGame && entries.length > 0 && (
          <>
            <h2>{t('host.manage.entries')}</h2>
            <p className="muted">{t('host.manage.entriesHint')}</p>
            <ul className="manage-list">
              {entries.map((e) => (
                <li key={e.id}>
                  <span className="grow">
                    {e.ownerName}
                    {e.text && <span className="muted"> · {e.text.slice(0, 40)}</span>}
                  </span>
                  {removed.has(e.id) ? (
                    <span className="muted">{t('host.manage.removed')}</span>
                  ) : (
                    <button
                      className="btn btn-small btn-danger"
                      onClick={() =>
                        confirm(t('host.manage.removeConfirm', { name: e.ownerName })) && act('host:removeEntry', { entryId: e.id })
                      }
                    >
                      {t('host.manage.remove')}
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
