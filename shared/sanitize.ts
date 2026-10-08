import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from './types';

// Control chars, zero-width/bidi overrides and other invisible formatting.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g;

/** Trimmed single-line display name, or null if nothing usable is left. */
export function sanitizeName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = Array.from(input.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_NAME_LENGTH)
    .join('')
    .trim();
  return name.length > 0 ? name : null;
}

/** Entry text: keeps up to a few line breaks, strips invisible chars. */
export function sanitizeText(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = Array.from(
    input
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(INVISIBLE, '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  )
    .slice(0, MAX_TEXT_LENGTH)
    .join('')
    .trim();
  return text.length > 0 ? text : null;
}

export function normalizeCode(input: unknown): string {
  return typeof input === 'string' ? input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) : '';
}
