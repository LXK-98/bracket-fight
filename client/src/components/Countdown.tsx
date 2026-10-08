interface Props {
  ms: number | null;
  totalMs: number;
  paused?: boolean;
  size?: 'big' | 'small';
}

/** Circular countdown ring with the remaining seconds in the middle. */
export function Countdown({ ms, totalMs, paused, size = 'big' }: Props) {
  if (ms === null) return null;
  const secs = Math.ceil(ms / 1000);
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, ms / totalMs)) : 0;
  const r = 45;
  const c = 2 * Math.PI * r;
  const urgent = secs <= 5 && !paused;
  return (
    <div className={`countdown countdown-${size} ${urgent ? 'urgent' : ''} ${paused ? 'paused' : ''}`} role="timer" aria-live="off">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="countdown-track" cx="50" cy="50" r={r} />
        <circle
          className="countdown-fill"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <span className="countdown-num">{paused ? '❚❚' : secs}</span>
    </div>
  );
}
