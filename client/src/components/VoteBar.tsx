interface Props {
  a: number;
  b: number;
  winner?: 'a' | 'b' | null;
}

/** Horizontal split bar showing the vote share of each side. */
export function VoteBar({ a, b, winner }: Props) {
  const total = a + b;
  const pa = total === 0 ? 50 : Math.round((a / total) * 100);
  return (
    <div className={`vote-bar ${winner ? `won-${winner}` : ''}`}>
      <div className="vote-bar-a" style={{ width: `${pa}%` }}>
        <span>
          {a} {total > 0 && pa >= 20 && <small>({pa}%)</small>}
        </span>
      </div>
      <div className="vote-bar-b" style={{ width: `${100 - pa}%` }}>
        <span>
          {total > 0 && 100 - pa >= 20 && <small>({100 - pa}%)</small>} {b}
        </span>
      </div>
    </div>
  );
}
