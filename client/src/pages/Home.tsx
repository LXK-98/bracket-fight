import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { problemText, toProblem, type Problem } from '../i18n/text';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { sound } from '../lib/sound';
import { hostToken } from '../lib/storage';

export function Home() {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<Problem | null>(null);
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
      setError(toProblem(err));
      setBusy(null);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length < 4) return setError({ code: 'codeLength' });
    setBusy('join');
    setError(null);
    try {
      await api.getRoom(c);
      navigate(`/join/${c}`);
    } catch {
      setError({ code: 'noRoomWithCode', params: { code: c } });
      setBusy(null);
    }
  };

  return (
    <main className="home">
      <div className="home-top">
        <LanguageSwitcher />
      </div>
      <h1 className="logo">
        <span className="logo-a">Image</span> <span className="logo-b">Bracket</span>
      </h1>
      <p className="tagline">{t('home.tagline')}</p>

      <form className="card home-join" onSubmit={join}>
        <label htmlFor="code">{t('home.joinTitle')}</label>
        <input
          id="code"
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
          placeholder={t('home.codePlaceholder')}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
        />
        <button className="btn btn-primary btn-big" disabled={busy !== null || code.length < 4}>
          {busy === 'join' ? t('home.joining') : t('home.join')}
        </button>
      </form>

      <form className="card home-create" onSubmit={create}>
        <p>{t('home.hostHint')}</p>
        {needsPassword && (
          <input
            type="password"
            className="host-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('home.hostPassword')}
            aria-label={t('home.hostPassword')}
            autoComplete="current-password"
          />
        )}
        <button className="btn btn-secondary btn-big" disabled={busy !== null || (needsPassword && !password)}>
          {busy === 'create' ? t('home.creating') : t('home.create')}
        </button>
      </form>

      {error && <p className="error">{problemText(t, error)}</p>}
    </main>
  );
}
