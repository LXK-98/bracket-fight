import type { MessageParams } from '../../../shared/messages';
import { CodedError } from '../i18n/text';

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body as { error?: string; code?: string; params?: MessageParams };
    throw new CodedError(
      err.code
        ? { code: err.code, params: err.params, message: err.error }
        : { code: 'requestFailed', params: { status: res.status }, message: err.error },
    );
  }
  return body as T;
}

export const api = {
  config: () => fetch('/api/config').then((r) => json<{ createRequiresPassword: boolean }>(r)),
  createRoom: (password?: string) =>
    fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    }).then((r) => json<{ code: string; hostToken: string }>(r)),
  getRoom: (code: string) => fetch(`/api/rooms/${encodeURIComponent(code)}`).then((r) => json<{ code: string; phase: string }>(r)),
  joinInfo: (code: string) =>
    fetch(`/api/rooms/${encodeURIComponent(code)}/join-info`).then((r) => json<{ joinUrl: string; qrSvg: string }>(r)),
  submitEntry: (code: string, token: string, form: FormData) =>
    fetch(`/api/rooms/${encodeURIComponent(code)}/entry`, {
      method: 'POST',
      headers: { 'x-player-token': token },
      body: form,
    }).then((r) => json<{ ok: true }>(r)),
};
