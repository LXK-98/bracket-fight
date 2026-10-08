// Typed translation keys: t('some.key') is checked against the English resources.
import 'i18next';
import type { Translation } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Translation };
  }
}
