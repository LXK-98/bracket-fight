import type { ParseKeys, TFunction } from 'i18next';
import { Fragment, type ReactNode } from 'react';
import { roundKind } from '../../../shared/bracket';
import type { MessageParams } from '../../../shared/messages';

/**
 * Something to tell the user: a message code (from the server or the client,
 * translated under `errors.<code>`), its parameters, and optional English text.
 */
export interface Problem {
  code: string;
  params?: MessageParams;
  message?: string;
}

/** An error carrying a translatable Problem. */
export class CodedError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message ?? problem.code);
  }
}

export function toProblem(err: unknown): Problem {
  if (err instanceof CodedError) return err.problem;
  return { code: 'serverError', message: err instanceof Error ? err.message : String(err) };
}

type LooseT = (key: string, options?: Record<string, unknown>) => string;

/** Translated text for a Problem; falls back to the English message for unknown codes. */
export function problemText(t: TFunction, p: Problem): string {
  return (t as unknown as LooseT)(`errors.${p.code}`, { ...p.params, defaultValue: p.message ?? p.code });
}

export function roundLabel(t: TFunction, round: number, roundCount: number): string {
  return t(`rounds.${roundKind(round, roundCount)}`, { number: round + 1 });
}

const MARK = '\u0000';

/**
 * Translate `key` and put React nodes (e.g. a bold name) where its {{placeholders}}
 * are, so each language keeps its own word order. User text stays a plain text node.
 */
export function tNodes(t: TFunction, key: ParseKeys, nodes: Record<string, ReactNode>, values: Record<string, unknown> = {}): ReactNode {
  const markers = Object.fromEntries(Object.keys(nodes).map((name) => [name, `${MARK}${name}${MARK}`]));
  const text = (t as unknown as LooseT)(key, { ...values, ...markers });
  return text.split(MARK).map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{nodes[part]}</Fragment> : part));
}
