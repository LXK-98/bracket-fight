import { useLayoutEffect, useRef, useState } from 'react';
import { roundName } from '../../../shared/bracket';
import type { Bracket, Match, PublicEntry } from '../../../shared/types';

interface Props {
  bracket: Bracket;
  entries: Record<string, PublicEntry>;
  /** Match to highlight (current or up next). */
  highlight?: string | null;
  /**
   * Focus mode for big brackets: show only this round and the next, splitting
   * long columns in two so each card stays readable from across the room.
   */
  focusRound?: number | null;
  /** Allow scaling small brackets up to fill the space. */
  maxScale?: number;
}

function Slot({ id, match, entries, removed }: { id: string | null; match: Match; entries: Record<string, PublicEntry>; removed: Set<string> }) {
  if (id === null) {
    return <div className="slot slot-empty">{match.bye ? '' : 'TBD'}</div>;
  }
  const e = entries[id];
  const state = match.winner === null || match.bye ? '' : match.winner === id ? 'won' : 'lost';
  const votes = match.winner !== null && !match.bye && match.decidedBy !== 'forfeit' ? (id === match.a ? match.votesA : match.votesB) : null;
  return (
    <div className={`slot ${state} ${removed.has(id) ? 'removed' : ''}`} title={e?.text ?? undefined}>
      <div className="slot-thumb">{e?.imageUrl ? <img src={e.imageUrl} alt="" loading="lazy" /> : <span>Aa</span>}</div>
      <div className="slot-label">
        <span className="slot-name">{e?.ownerName ?? '?'}</span>
        {match.bye ? (
          <span className="slot-text slot-bye-note">advances automatically</span>
        ) : (
          e?.text && <span className="slot-text">{e.text}</span>
        )}
      </div>
      {votes !== null && <span className="slot-votes">{votes}</span>}
    </div>
  );
}

/**
 * Classic left-to-right bracket. The content is measured and scaled to fit
 * its container, so 32-entry brackets still fit on a TV.
 */
const MAX_PER_COLUMN = 8;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function BracketView({ bracket, entries, highlight, focusRound = null, maxScale = 1.6 }: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const removed = new Set(bracket.removed);
  const rounds = focusRound === null ? bracket.rounds : bracket.rounds.slice(focusRound, focusRound + 2);
  const split = focusRound !== null;

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const fit = () => {
      const w = i.scrollWidth;
      const h = i.scrollHeight;
      if (!w || !h) return;
      setScale(Math.min(maxScale, o.clientWidth / w, o.clientHeight / h));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, [maxScale, rounds.length, bracket.size, focusRound]);

  return (
    <div className="bracket-outer" ref={outer}>
      <div className="bracket" ref={inner} style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        {rounds.map((round) => (
          <div className="bracket-round" key={round[0].round}>
            <div className="bracket-round-title">{roundName(round[0].round, bracket.rounds.length)}</div>
            <div className="bracket-columns">
              {(split ? chunk(round, MAX_PER_COLUMN) : [round]).map((column, ci) => (
                <div className="bracket-matches" key={ci}>
                  {column.map((m) => (
                    <div
                      key={m.id}
                      className={`bracket-match ${m.id === highlight ? 'highlight' : ''} ${m.bye ? 'bye' : ''} ${m.winner ? 'decided' : ''}`}
                    >
                      <Slot id={m.a} match={m} entries={entries} removed={removed} />
                      {!m.bye && <Slot id={m.b} match={m} entries={entries} removed={removed} />}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
