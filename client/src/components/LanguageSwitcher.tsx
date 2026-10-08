import { useTranslation } from 'react-i18next';
import { setLanguage } from '../i18n';
import { LANGUAGES, type LanguageCode } from '../i18n/resources';

/** Language picker. `compact` shows codes (EN, DE) to save space, e.g. on phones. */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  return (
    <select
      className="lang-select"
      value={i18n.resolvedLanguage}
      onChange={(e) => setLanguage(e.target.value as LanguageCode)}
      aria-label={t('language.label')}
      title={t('language.label')}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {compact ? l.code.toUpperCase() : l.label}
        </option>
      ))}
    </select>
  );
}
