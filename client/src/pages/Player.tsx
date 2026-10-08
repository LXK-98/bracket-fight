import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH, SUDDEN_DEATH_SECONDS, type RoomView } from '../../../shared/types';
import { Countdown } from '../components/Countdown';
import { EntryCard } from '../components/EntryCard';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { VoteBar } from '../components/VoteBar';
import { problemText, roundLabel, tNodes, toProblem, type Problem } from '../i18n/text';
import { api } from '../lib/api';
import { looksLikeImage, prepareImage } from '../lib/image';
import { playerToken } from '../lib/storage';
import { ackProblem, remainingMs, useRoom, useTick, type RoomConnection } from '../lib/useRoom';

type Act = (event: string, payload?: object) => Promise<boolean>;
type OnError = (p: Problem) => void;

export function PlayerPage({ code }: { code: string }) {
  const { t } = useTranslation();
  const conn = useRoom(code, 'player');
  const { view, fatal, needsJoin, connected } = conn;
  const [error, setError] = useState<Problem | null>(null);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  const act: Act = async (event, payload) => {
    const res = await conn.emit(event, payload);
    if (!res.ok) setError(ackProblem(res));
    return res.ok;
  };

  let body: React.ReactNode;
  if (fatal) {
    body = (
      <div className="center-card">
        <h2>{problemText(t, fatal)}</h2>
        <a className="btn btn-primary btn-big" href="/">
          {t('common.backToStart')}
        </a>
      </div>
    );
  } else if (needsJoin) {
    body = <JoinForm code={code} conn={conn} />;
  } else if (!view?.me) {
    body = <div className="center-card muted">{t('common.connecting')}</div>;
  } else {
    body = <PlayerGame view={view} act={act} conn={conn} onError={setError} />;
  }

  return (
    <div className="player">
      <header className="player-bar">
        <span className="logo small">
          <span className="logo-a">Image</span> <span className="logo-b">Bracket</span>
        </span>
        <span className="player-bar-right">
          {view?.me && <span className="me-name">{view.me.name}</span>}
          <span className="code-pill">{code}</span>
          <LanguageSwitcher compact />
        </span>
      </header>
      {!connected && !fatal && <div className="banner banner-warn">{t('common.reconnecting')}</div>}
      <main className="player-main">{body}</main>
      {error && <div className="toast">{problemText(t, error)}</div>}
    </div>
  );
}

function JoinForm({ code, conn }: { code: string; conn: RoomConnection }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await conn.join(name);
    setBusy(false);
    if (!res.ok) setError(ackProblem(res));
  };
  return (
    <form className="center-card join-form" onSubmit={submit}>
      <h2>{tNodes(t, 'player.joinForm.title', { code: <span className="code-text">{code}</span> })}</h2>
      <label htmlFor="name">{t('player.joinForm.name')}</label>
      <input
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="nickname"
        autoFocus
        enterKeyHint="go"
        placeholder={t('player.joinForm.namePlaceholder')}
      />
      <button className="btn btn-primary btn-big" disabled={busy || !name.trim()}>
        {busy ? t('player.joinForm.joining') : t('player.joinForm.join')}
      </button>
      {error && <p className="error">{problemText(t, error)}</p>}
    </form>
  );
}

function PlayerGame({ view, act, conn, onError }: { view: RoomView; act: Act; conn: RoomConnection; onError: OnError }) {
  switch (view.phase) {
    case 'lobby':
      return <PlayerLobby view={view} act={act} onError={onError} />;
    case 'voting':
    case 'tiebreak':
    case 'reveal':
      return <PlayerMatch view={view} act={act} serverNow={conn.serverNow} />;
    case 'overview':
      return <PlayerOverview view={view} />;
    case 'finished':
      return <PlayerFinished view={view} />;
  }
}

// ------------------------------------------------------------------ lobby

function PlayerLobby({ view, act, onError }: { view: RoomView; act: Act; onError: OnError }) {
  const { t } = useTranslation();
  const me = view.me!;
  const [editing, setEditing] = useState(false);

  if (me.role === 'undecided') {
    return (
      <div className="stack">
        <h2 className="center">{t('player.lobby.howToPlay')}</h2>
        <button className="btn btn-primary btn-choice" disabled={view.lobby.competitorsFull} onClick={() => act('player:setRole', { role: 'competitor' })}>
          {t('player.lobby.compete')}
          <small>{view.lobby.competitorsFull ? t('player.lobby.bracketFull') : t('player.lobby.competeHint')}</small>
        </button>
        <button className="btn btn-secondary btn-choice" onClick={() => act('player:setRole', { role: 'voter' })}>
          {t('player.lobby.justVote')}
          <small>{t('player.lobby.justVoteHint')}</small>
        </button>
      </div>
    );
  }

  if (me.role === 'voter') {
    return (
      <div className="stack">
        <div className="status-card">
          <div className="status-emoji">🗳️</div>
          <h2>{t('player.lobby.youreVoter')}</h2>
          <p className="muted">{t('player.lobby.waitingForStart')}</p>
        </div>
        <button className="btn btn-ghost" disabled={view.lobby.competitorsFull} onClick={() => act('player:setRole', { role: 'competitor' })}>
          {view.lobby.competitorsFull ? t('player.lobby.bracketFullShort') : t('player.lobby.switchToCompeting')}
        </button>
      </div>
    );
  }

  // Competitor
  if (me.submitted && !editing) {
    return (
      <div className="stack">
        <div className="banner banner-ok">{t('player.lobby.submitted')}</div>
        <EntryCard entry={me.entry ?? undefined} className="preview" />
        <button className="btn btn-secondary btn-big" onClick={() => setEditing(true)}>
          {t('player.lobby.editEntry')}
        </button>
        <button className="btn btn-ghost" onClick={() => confirm(t('player.lobby.withdrawConfirm')) && act('player:setRole', { role: 'voter' })}>
          {t('player.lobby.switchToVoting')}
        </button>
      </div>
    );
  }

  return <EntryEditor view={view} onDone={() => setEditing(false)} onError={onError} act={act} />;
}

function EntryEditor({ view, onDone, onError, act }: { view: RoomView; onDone: () => void; onError: OnError; act: Act }) {
  const { t } = useTranslation();
  const me = view.me!;
  const mode = view.settings.entryMode;
  const [text, setText] = useState(me.entry?.text ?? '');
  const [image, setImage] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(me.entry?.imageUrl ?? null);
  const [removeImage, setRemoveImage] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview);
  }, [preview]);

  const allowImage = mode !== 'text';
  const allowText = mode !== 'image';

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!looksLikeImage(file)) return onError({ code: 'notAnImage' });
    setProcessing(true);
    try {
      const blob = await prepareImage(file);
      setImage(blob);
      setRemoveImage(false);
      setPreview(URL.createObjectURL(blob));
    } catch (err) {
      onError(toProblem(err));
    } finally {
      setProcessing(false);
    }
  };

  const clearImage = () => {
    setImage(null);
    setPreview(null);
    setRemoveImage(true);
  };

  const hasImage = allowImage && preview !== null;
  const hasText = allowText && text.trim().length > 0;
  const valid = mode === 'image' ? hasImage : mode === 'text' ? hasText : hasImage || hasText;

  const submit = async () => {
    const token = playerToken.get(view.code);
    if (!token) return onError({ code: 'sessionLost' });
    const form = new FormData();
    form.append('text', allowText ? text : '');
    if (removeImage) form.append('removeImage', '1');
    if (image) form.append('image', image, image.type === 'image/webp' ? 'entry.webp' : 'entry.jpg');
    setUploading(true);
    try {
      await api.submitEntry(view.code, token, form);
      onDone();
    } catch (err) {
      onError(toProblem(err));
    } finally {
      setUploading(false);
    }
  };

  const hint = mode === 'image' ? t('player.editor.hintImage') : mode === 'text' ? t('player.editor.hintText') : t('player.editor.hintBoth');

  return (
    <div className="stack entry-editor">
      <h2>{t('player.editor.title')}</h2>
      <p className="muted">{hint}</p>

      {allowImage && (
        <div className="image-picker">
          {preview ? (
            <div className="image-preview">
              <img src={preview} alt={t('player.editor.imageAlt')} />
              <button className="btn btn-small btn-ghost remove-image" onClick={clearImage}>
                {t('player.editor.removeImage')}
              </button>
            </div>
          ) : (
            <div className="image-placeholder">{processing ? t('player.editor.processing') : t('player.editor.noImage')}</div>
          )}
          <div className="row">
            <button className="btn btn-secondary grow" disabled={processing} onClick={() => cameraRef.current?.click()}>
              {t('player.editor.camera')}
            </button>
            <button className="btn btn-secondary grow" disabled={processing} onClick={() => galleryRef.current?.click()}>
              {t('player.editor.gallery')}
            </button>
          </div>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
          <input ref={galleryRef} type="file" accept="image/*,.heic,.heif" hidden onChange={onFile} />
        </div>
      )}

      {allowText && (
        <label className="text-field">
          {mode === 'text' ? t('player.editor.text') : t('player.editor.caption')}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_TEXT_LENGTH}
            rows={3}
            placeholder={t('player.editor.textPlaceholder')}
          />
          <span className="muted counter">
            {text.length}/{MAX_TEXT_LENGTH}
          </span>
        </label>
      )}

      <button className="btn btn-primary btn-big" disabled={!valid || uploading || processing} onClick={submit}>
        {uploading ? t('player.editor.uploading') : me.entry ? t('player.editor.save') : t('player.editor.submit')}
      </button>
      {me.submitted && (
        <button className="btn btn-ghost" onClick={onDone}>
          {t('player.editor.cancel')}
        </button>
      )}
      {!me.submitted && (
        <button className="btn btn-ghost" onClick={() => act('player:setRole', { role: 'voter' })}>
          {t('player.editor.justVote')}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ in game

function EntryStatusLine({ view }: { view: RoomView }) {
  const { t } = useTranslation();
  const me = view.me!;
  if (!view.bracket) return null;
  const rounds = view.bracket.rounds.length;
  switch (me.entryStatus) {
    case 'alive':
      return <div className="status-line ok">{t('player.status.alive')}</div>;
    case 'eliminated':
      return (
        <div className="status-line bad">{t('player.status.eliminated', { round: roundLabel(t, me.eliminatedRound ?? 0, rounds) })}</div>
      );
    case 'removed':
      return <div className="status-line bad">{t('player.status.removed')}</div>;
    case 'champion':
      return <div className="status-line ok">{t('player.status.champion')}</div>;
    default:
      return null;
  }
}

function PlayerMatch({ view, act, serverNow }: { view: RoomView; act: Act; serverNow: () => number }) {
  const { t } = useTranslation();
  useTick(250);
  const m = view.match;
  const me = view.me!;
  if (!m) return <div className="center-card muted">{t('player.match.waiting')}</div>;
  const myEntry = me.entry?.id;
  const mySide = myEntry === m.a ? 'a' : myEntry === m.b ? 'b' : null;
  const voting = view.phase === 'voting';
  const ms = remainingMs(view, serverNow);
  const total = (m.suddenDeath ? SUDDEN_DEATH_SECONDS : view.settings.voteSeconds) * 1000;
  const showCounts = m.votesA !== null && m.votesB !== null;

  let banner: React.ReactNode = null;
  if (view.phase === 'reveal') {
    if (mySide && m.winner === mySide) banner = <div className="banner banner-ok big">{t('player.match.advances')}</div>;
    else if (mySide) banner = <div className="banner banner-bad big">{t('player.match.eliminated')}</div>;
    else if (me.vote === m.winner && me.vote) banner = <div className="banner banner-ok">{t('player.match.pickWon')}</div>;
    else banner = <div className="banner">{t('player.match.wins', { name: view.entries[m.winner === 'a' ? m.a : m.b]?.ownerName })}</div>;
  } else if (view.phase === 'tiebreak') {
    banner = <div className="banner banner-warn">{t('player.match.tieDeciding')}</div>;
  } else if (mySide) {
    banner = <div className="banner banner-hot">{t('player.match.yourEntryUp')}</div>;
  } else if (m.suddenDeath) {
    banner = <div className="banner banner-hot">{t('player.match.suddenDeath')}</div>;
  }

  const vote = (side: 'a' | 'b') => {
    if (!me.canVote) return;
    navigator.vibrate?.(15);
    void act('player:vote', { matchId: m.matchId, side });
  };

  const sideClass = (side: 'a' | 'b') => (view.phase === 'reveal' ? (m.winner === side ? 'winner' : 'loser') : '');
  const hint = me.voteBlocked
    ? t(`player.match.blocked.${me.voteBlocked}`)
    : me.vote
      ? t('player.match.voteSaved')
      : t('player.match.tapFavourite');

  return (
    <div className="stack match-phone">
      <div className="match-phone-head">
        <span className="round-name">{roundLabel(t, m.round, view.bracket!.rounds.length)}</span>
        {voting && <Countdown ms={ms} totalMs={total} paused={view.paused} size="small" />}
      </div>
      {banner}
      {voting && <p className="vote-hint">{hint}</p>}
      <div className="phone-versus">
        {(['a', 'b'] as const).map((side) => (
          <EntryCard
            key={side}
            side={side}
            entry={view.entries[side === 'a' ? m.a : m.b]}
            onClick={voting ? () => vote(side) : undefined}
            disabled={!me.canVote}
            selected={me.vote === side}
            className={sideClass(side)}
            badge={me.vote === side ? t('player.match.yourVote') : mySide === side ? t('player.match.you') : undefined}
          />
        ))}
      </div>
      {showCounts && m.decidedBy !== 'forfeit' && <VoteBar a={m.votesA!} b={m.votesB!} winner={m.winner} />}
      {voting && <p className="muted center">{t('player.match.voted', { voted: m.votedCount, eligible: m.eligibleCount })}</p>}
      <EntryStatusLine view={view} />
    </div>
  );
}

function PlayerOverview({ view }: { view: RoomView }) {
  const { t } = useTranslation();
  const me = view.me!;
  const next = view.nextMatchId ? view.bracket?.rounds.flat().find((m) => m.id === view.nextMatchId) : null;
  const mine = !!next && !!me.entry && (next.a === me.entry.id || next.b === me.entry.id);
  return (
    <div className="stack">
      <div className="status-card">
        <div className="status-emoji">{mine ? '🔥' : '⏳'}</div>
        <h2>{mine ? t('player.overview.upNextYou') : t('player.overview.waiting')}</h2>
        {next?.a && next.b && (
          <p className="muted">
            {t('player.overview.versus', { a: view.entries[next.a]?.ownerName, b: view.entries[next.b]?.ownerName })}
          </p>
        )}
        {view.paused && <p className="muted">{t('player.overview.paused')}</p>}
      </div>
      <EntryStatusLine view={view} />
    </div>
  );
}

function PlayerFinished({ view }: { view: RoomView }) {
  const { t } = useTranslation();
  const champ = view.champion ? view.entries[view.champion] : undefined;
  const mine = view.me!.entryStatus === 'champion';
  return (
    <div className="stack">
      <div className="status-card">
        <div className="status-emoji">🏆</div>
        <h2>
          {mine ? t('player.finished.youWon') : champ ? t('player.finished.champion', { name: champ.ownerName }) : t('player.finished.gameOver')}
        </h2>
      </div>
      {champ && <EntryCard entry={champ} className="preview" />}
      <p className="muted center">{t('player.finished.waiting')}</p>
    </div>
  );
}
