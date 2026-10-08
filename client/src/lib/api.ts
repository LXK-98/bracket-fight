async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  createRoom: () => fetch('/api/rooms', { method: 'POST' }).then((r) => json<{ code: string; hostToken: string }>(r)),
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
