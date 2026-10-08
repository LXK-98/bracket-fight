import { useTranslation } from 'react-i18next';
import type { PublicEntry } from '../../../shared/types';
import { tNodes } from '../i18n/text';

interface Props {
  entry: PublicEntry | undefined;
  side?: 'a' | 'b';
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  selected?: boolean;
  badge?: React.ReactNode;
  children?: React.ReactNode;
}

/** An entry: image and/or text plus the owner's name. Used on the TV and phones. */
export function EntryCard({ entry, side, className = '', onClick, disabled, selected, badge, children }: Props) {
  const { t } = useTranslation();
  const Tag = onClick ? 'button' : 'div';
  const textOnly = entry && !entry.imageUrl;
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className={`entry-card ${side ? `side-${side}` : ''} ${selected ? 'selected' : ''} ${textOnly ? 'text-only' : ''} ${badge ? 'has-badge' : ''} ${className}`}
      onClick={onClick}
      disabled={onClick ? disabled : undefined}
      aria-pressed={onClick ? selected : undefined}
    >
      {badge && <div className="entry-badge">{badge}</div>}
      {entry?.imageUrl && (
        <div className="entry-image">
          <img src={entry.imageUrl} alt={entry.text ?? t('entry.imageAlt', { name: entry.ownerName })} draggable={false} />
        </div>
      )}
      {entry?.text && <div className="entry-text">{entry.text}</div>}
      <div className="entry-owner">{entry ? tNodes(t, 'entry.by', { name: <b>{entry.ownerName}</b> }) : '?'}</div>
      {children}
    </Tag>
  );
}
