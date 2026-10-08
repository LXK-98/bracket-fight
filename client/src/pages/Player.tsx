import { useEffect, useRef, useState } from 'react';
import { roundName } from '../../../shared/bracket';
import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH, SUDDEN_DEATH_SECONDS, type RoomView } from '../../../shared/types';
import { Countdown } from '../components/Countdown';
import { EntryCard } from '../components/EntryCard';
import { VoteBar } from '../components/VoteBar';
import { api } from '../lib/api';
import { looksLikeImage, prepareImage } from '../lib/image';
import { playerToken } from '../lib/storage';
import { remainingMs, useRoom, useTick, type RoomConnection } from '../lib/useRoom';

type Act = (event: string, payload?: object) => Promise<boolean>;

export function PlayerPage({ code }: { code: string }) {
  const conn = useRoom(code, 'player');
  const { view, fatal, needsJoin, connected } = conn;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);

  const act: Act = async (event, payload) => {
    const res = await conn.emit(event, payload);
    if (!res.ok) setError(res.error);
    return res.ok;
  };

  let body: React.ReactNode;
  if (fatal) {
    body = (
      <div className="center-card">
        <h2>{fatal}</h2>
        <a className="btn btn-primary btn-big" href="/">
          Back to start
        </a>
      </div>
    );
  } else if (needsJoin) {
    body = <JoinForm code={code} conn={conn} />;
  } else if (!view?.me) {
    body = <div className="center-card muted">Connecting…</div>;
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
        </span>
      </header>
      {!connected && !fatal && <div className="banner banner-warn">Reconnecting…</div>}
      <main className="player-main">{body}</main>
      {error && <div className="toast">{error}</div>}
    </div>
  );
}

function JoinForm({ code, conn }: { code: string; conn: RoomConnection }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await conn.join(name);
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  return (
    <form className="center-card join-form" onSubmit={submit}>
      <h2>
        Joining room <span className="code-text">{code}</span>
      </h2>
      <label htmlFor="name">Your name</label>
      <input
        id="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={MAX_NAME_LENGTH}
        autoComplete="nickname"
        autoFocus
        enterKeyHint="go"
        placeholder="e.g. Sam"
      />
      <button className="btn btn-primary btn-big" disabled={busy || !name.trim()}>
        {busy ? 'Joining…' : 'Join'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function PlayerGame({ view, act, conn, onError }: { view: RoomView; act: Act; conn: RoomConnection; onError: (m: string) => void }) {
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

function PlayerLobby({ view, act, onError }: { view: RoomView; act: Act; onError: (m: string) => void }) {
  const me = view.me!;
  const [editing, setEditing] = useState(false);

  if (me.role === 'undecided') {
    return (
      <div className="stack">
        <h2 className="center">How do you want to play?</h2>
        <button className="btn btn-primary btn-choice" disabled={view.lobby.competitorsFull} onClick={() => act('player:setRole', { role: 'competitor' })}>
          🥊 Compete
          <small>{view.lobby.competitorsFull ? 'The bracket is full' : 'Submit an entry into the bracket'}</small>
        </button>
        <button className="btn btn-secondary btn-choice" onClick={() => act('player:setRole', { role: 'voter' })}>
          🗳️ Just vote
          <small>Pick the winners of every matchup</small>
        </button>
      </div>
    );
  }

  if (me.role === 'voter') {
    return (
      <div className="stack">
        <div className="status-card">
          <div className="status-emoji">🗳️</div>
          <h2>You're a voter</h2>
          <p className="muted">Waiting for the host to start the game…</p>
        </div>
        <button className="btn btn-ghost" disabled={view.lobby.competitorsFull} onClick={() => act('player:setRole', { role: 'competitor' })}>
          {view.lobby.competitorsFull ? 'Bracket is full' : 'Switch to competing'}
        </button>
      </div>
    );
  }

  // Competitor
  if (me.submitted && !editing) {
    return (
      <div className="stack">
        <div className="banner banner-ok">Entry submitted! Waiting for the host to start…</div>
        <EntryCard entry={me.entry ?? undefined} className="preview" />
        <button className="btn btn-secondary btn-big" onClick={() => setEditing(true)}>
          Edit entry
        </button>
        <button className="btn btn-ghost" onClick={() => confirm('Withdraw your entry and just vote?') && act('player:setRole', { role: 'voter' })}>
          Switch to just voting
        </button>
      </div>
    );
  }

  return <EntryEditor view={view} onDone={() => setEditing(false)} onError={onError} act={act} />;
}

function EntryEditor({ view, onDone, onError, act }: { view: RoomView; onDone: () => void; onError: (m: string) => void; act: Act }) {
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
    if (!looksLikeImage(file)) return onError('Please choose an image file.');
    setProcessing(true);
    try {
      const blob = await prepareImage(file);
      setImage(blob);
      setRemoveImage(false);
      setPreview(URL.createObjectURL(blob));
    } catch (err) {
      onError((err as Error).message);
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
    if (!token) return onError('Session lost. Please rejoin.');
    const form = new FormData();
    form.append('text', allowText ? text : '');
    if (removeImage) form.append('removeImage', '1');
    if (image) form.append('image', image, image.type === 'image/webp' ? 'entry.webp' : 'entry.jpg');
    setUploading(true);
    try {
      await api.submitEntry(view.code, token, form);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const hint = mode === 'image' ? 'Add an image' : mode === 'text' ? 'Write your entry' : 'Add an image, some text, or both';

  return (
    <div className="stack entry-editor">
      <h2>Your entry</h2>
      <p className="muted">{hint}. It will be shown with your name.</p>

      {allowImage && (
        <div className="image-picker">
          {preview ? (
            <div className="image-preview">
              <img src={preview} alt="Your entry" />
              <button className="btn btn-small btn-ghost remove-image" onClick={clearImage}>
                Remove image
              </button>
            </div>
          ) : (
            <div className="image-placeholder">{processing ? 'Processing…' : 'No image yet'}</div>
          )}
          <div className="row">
            <button className="btn btn-secondary grow" disabled={processing} onClick={() => cameraRef.current?.click()}>
              📷 Camera
            </button>
            <button className="btn btn-secondary grow" disabled={processing} onClick={() => galleryRef.current?.click()}>
              🖼️ Gallery
            </button>
          </div>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
          <input ref={galleryRef} type="file" accept="image/*,.heic,.heif" hidden onChange={onFile} />
        </div>
      )}

      {allowText && (
        <label className="text-field">
          {mode === 'text' ? 'Text' : 'Text (optional caption)'}
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={MAX_TEXT_LENGTH} rows={3} placeholder="Type something…" />
          <span className="muted counter">
            {text.length}/{MAX_TEXT_LENGTH}
          </span>
        </label>
      )}

      <button className="btn btn-primary btn-big" disabled={!valid || uploading || processing} onClick={submit}>
        {uploading ? 'Uploading…' : me.entry ? 'Save entry' : 'Submit entry'}
      </button>
      {me.submitted && (
        <button className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
      )}
      {!me.submitted && (
        <button className="btn btn-ghost" onClick={() => act('player:setRole', { role: 'voter' })}>
          Actually, I'll just vote
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ in game

function EntryStatusLine({ view }: { view: RoomView }) {
  const me = view.me!;
  if (!view.bracket) return null;
  const rounds = view.bracket.rounds.length;
  switch (me.entryStatus) {
    case 'alive':
      return <div className="status-line ok">Your entry is still in the running 💪</div>;
    case 'eliminated':
      return <div className="status-line bad">Your entry was eliminated in the {roundName(me.eliminatedRound ?? 0, rounds)}.</div>;
    case 'removed':
      return <div className="status-line bad">Your entry was removed by the host.</div>;
    case 'champion':
      return <div className="status-line ok">Your entry won! 🏆</div>;
    default:
      return null;
  }
}

function PlayerMatch({ view, act, serverNow }: { view: RoomView; act: Act; serverNow: () => number }) {
  useTick(250);
  const m = view.match;
  const me = view.me!;
  if (!m) return <div className="center-card muted">Waiting for the next match…</div>;
  const myEntry = me.entry?.id;
  const mySide = myEntry === m.a ? 'a' : myEntry === m.b ? 'b' : null;
  const voting = view.phase === 'voting';
  const ms = remainingMs(view, serverNow);
  const total = (m.suddenDeath ? SUDDEN_DEATH_SECONDS : view.settings.voteSeconds) * 1000;
  const showCounts = m.votesA !== null && m.votesB !== null;

  let banner: React.ReactNode = null;
  if (view.phase === 'reveal') {
    if (mySide && m.winner === mySide) banner = <div className="banner banner-ok big">Your entry advances! 🎉</div>;
    else if (mySide) banner = <div className="banner banner-bad big">You've been eliminated 😢</div>;
    else if (me.vote === m.winner && me.vote) banner = <div className="banner banner-ok">Your pick won!</div>;
    else banner = <div className="banner">{view.entries[m.winner === 'a' ? m.a : m.b]?.ownerName} wins!</div>;
  } else if (view.phase === 'tiebreak') {
    banner = <div className="banner banner-warn">It's a tie! The host is deciding…</div>;
  } else if (mySide) {
    banner = <div className="banner banner-hot">Your entry is up! 🔥</div>;
  } else if (m.suddenDeath) {
    banner = <div className="banner banner-hot">Sudden death! Vote again!</div>;
  }

  const vote = (side: 'a' | 'b') => {
    if (!me.canVote) return;
    navigator.vibrate?.(15);
    void act('player:vote', { matchId: m.matchId, side });
  };

  const sideClass = (side: 'a' | 'b') => (view.phase === 'reveal' ? (m.winner === side ? 'winner' : 'loser') : '');

  return (
    <div className="stack match-phone">
      <div className="match-phone-head">
        <span className="round-name">{m.roundName}</span>
        {voting && <Countdown ms={ms} totalMs={total} paused={view.paused} size="small" />}
      </div>
      {banner}
      {voting && (
        <p className="vote-hint">
          {me.voteBlockedReason ?? (me.vote ? 'Vote saved, tap the other one to change it.' : 'Tap your favourite!')}
        </p>
      )}
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
            badge={me.vote === side ? '✓ Your vote' : mySide === side ? 'You' : undefined}
          />
        ))}
      </div>
      {showCounts && m.decidedBy !== 'forfeit' && <VoteBar a={m.votesA!} b={m.votesB!} winner={m.winner} />}
      {voting && (
        <p className="muted center">
          {m.votedCount}/{m.eligibleCount} voted
        </p>
      )}
      <EntryStatusLine view={view} />
    </div>
  );
}

function PlayerOverview({ view }: { view: RoomView }) {
  const me = view.me!;
  const next = view.nextMatchId ? view.bracket?.rounds.flat().find((m) => m.id === view.nextMatchId) : null;
  const mine = !!next && !!me.entry && (next.a === me.entry.id || next.b === me.entry.id);
  return (
    <div className="stack">
      <div className="status-card">
        <div className="status-emoji">{mine ? '🔥' : '⏳'}</div>
        <h2>{mine ? 'Your entry is up next!' : 'Waiting for the next match'}</h2>
        {next?.a && next.b && (
          <p className="muted">
            {view.entries[next.a]?.ownerName} vs {view.entries[next.b]?.ownerName}
          </p>
        )}
        {view.paused && <p className="muted">The host paused the game.</p>}
      </div>
      <EntryStatusLine view={view} />
    </div>
  );
}

function PlayerFinished({ view }: { view: RoomView }) {
  const champ = view.champion ? view.entries[view.champion] : undefined;
  const mine = view.me!.entryStatus === 'champion';
  return (
    <div className="stack">
      <div className="status-card">
        <div className="status-emoji">🏆</div>
        <h2>{mine ? 'You won the bracket!' : champ ? `${champ.ownerName} is the champion!` : 'Game over'}</h2>
      </div>
      {champ && <EntryCard entry={champ} className="preview" />}
      <p className="muted center">Waiting for the host to start another round…</p>
    </div>
  );
}
