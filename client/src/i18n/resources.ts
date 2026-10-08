// Translation resources. No side effects, so tests can import this too.
//
// To add a language: create locales/<code>.json with the same keys as de.json
// (tests/locales.test.ts checks this), import it below and add it to LANGUAGES.
import { MESSAGES } from '../../../shared/messages';
import de from './locales/de.json';
import en from './locales/en.json';

/** Languages offered in the switcher, each labelled in its own language. */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'Deutsch' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export const FALLBACK_LANGUAGE: LanguageCode = 'en';

// English server messages live in shared/messages.ts, which the server uses too.
const enTranslation = { ...en, errors: { ...MESSAGES, ...en.errors } };
export type Translation = typeof enTranslation;

export const resources = {
  en: { translation: enTranslation },
  de: { translation: de },
} satisfies Record<LanguageCode, { translation: object }>;
