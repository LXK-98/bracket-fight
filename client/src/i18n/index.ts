import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import { prefs } from '../lib/storage';
import { FALLBACK_LANGUAGE, LANGUAGES, resources, type LanguageCode } from './resources';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true, // de-AT, de-CH, ... use de
    load: 'languageOnly',
    detection: {
      // A language picked in the switcher wins; otherwise follow the browser.
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'ib:pref:lang', // same key as prefs.set('lang')
      caches: [], // only remember explicit choices (see setLanguage)
    },
    interpolation: { escapeValue: false }, // React escapes rendered text
  });

function syncDocumentLanguage() {
  document.documentElement.lang = i18n.resolvedLanguage ?? FALLBACK_LANGUAGE;
}
syncDocumentLanguage();
i18n.on('languageChanged', syncDocumentLanguage);

/** Switch language and remember the choice on this device. */
export function setLanguage(code: LanguageCode) {
  prefs.set('lang', code);
  void i18n.changeLanguage(code);
}

export default i18n;
