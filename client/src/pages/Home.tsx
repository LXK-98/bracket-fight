import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { sound } from '../lib/sound';
import { hostToken } from '../lib/storage';

export function Home() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    api.config().then((c) => setNeedsPassword(c.createRequiresPassword), () => {});
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('create');
    setError(null);
    sound.unlock();
    try {
      const room = await api.createRoom(needsPassword ? password : undefined);
      hostToken.set(room.code, room.hostToken);
      navigate(`/host/${room.code}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length < 4) return setError('Room codes have 4–5 characters.');
    setBusy('join');
    setError(null);
    try {
      await api.getRoom(c);
      navigate(`/join/${c}`);
    } catch {
      setError(`No room with code ${c}. Check the main screen.`);
      setBusy(null);
    }
  };

  return (
    <main className="home">
      <h1 className="logo">
        <span className="logo-a">Image</span> <span className="logo-b">Bracket</span>
      </h1>
      <p className="tagline">Submit something. Battle head to head. Everyone votes.</p>

      <form className="card home-join" onSubmit={join}>
        <label htmlFor="code">Join a game</label>
        <input
          id="code"
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
          placeholder="CODE"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
        />
        <button className="btn btn-primary btn-big" disabled={busy !== null || code.length < 4}>
          {busy === 'join' ? 'Joining…' : 'Join game'}
        </button>
      </form>

      <form className="card home-create" onSubmit={create}>
        <p>Hosting? Open this on a TV or laptop everyone can see.</p>
        {needsPassword && (
          <input
            type="password"
            className="host-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Host password"
            aria-label="Host password"
            autoComplete="current-password"
          />
        )}
        <button className="btn btn-secondary btn-big" disabled={busy !== null || (needsPassword && !password)}>
          {busy === 'create' ? 'Creating…' : 'Create room'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
