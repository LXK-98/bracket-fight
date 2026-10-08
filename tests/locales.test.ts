import { describe, expect, it } from 'vitest';
import { resources } from '../client/src/i18n/resources';
import { MESSAGES, formatMessage, problem } from '../shared/messages';

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** key (plural suffix removed) -> placeholders used by any of its forms */
function flatten(obj: object, prefix = '', out = new Map<string, Set<string>>()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      flatten(v, path, out);
      continue;
    }
    expect(typeof v, path).toBe('string');
    const key = path.replace(PLURAL_SUFFIX, '');
    const vars = out.get(key) ?? new Set<string>();
    for (const m of String(v).matchAll(/\{\{\s*(\w+)\s*\}\}/g)) vars.add(m[1]);
    out.set(key, vars);
  }
  return out;
}

const english = flatten(resources.en.translation);

describe('translations', () => {
  for (const [lng, { translation }] of Object.entries(resources)) {
    if (lng === 'en') continue;
    it(`${lng} has exactly the English keys and placeholders`, () => {
      const other = flatten(translation);
      expect([...other.keys()].sort()).toEqual([...english.keys()].sort());
      for (const [key, vars] of english) expect([...(other.get(key) ?? [])].sort(), key).toEqual([...vars].sort());
    });
  }

  it('include every server message', () => {
    for (const key of Object.keys(MESSAGES)) expect(english.has(`errors.${key.replace(PLURAL_SUFFIX, '')}`)).toBe(true);
  });
});

describe('formatMessage', () => {
  it('fills placeholders and picks English plural forms', () => {
    expect(formatMessage('bracketFull', { max: 8 })).toBe('The bracket is full (8 entries). You can still vote!');
    expect(formatMessage('waitingForEntries', { count: 1 })).toBe('Waiting for 1 competitor to submit an entry.');
    expect(formatMessage('waitingForEntries', { count: 3 })).toBe('Waiting for 3 competitors to submit an entry.');
    expect(problem('roomNotFound')).toEqual({ code: 'roomNotFound', message: 'Room not found. Check the code.' });
  });
});
