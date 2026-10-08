// localStorage can throw (private mode, blocked storage); never let that break the app.
function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export const hostToken = {
  get: (code: string) => get(`ib:host:${code}`),
  set: (code: string, token: string) => set(`ib:host:${code}`, token),
};

export const playerToken = {
  get: (code: string) => get(`ib:player:${code}`),
  set: (code: string, token: string | null) => set(`ib:player:${code}`, token),
};

export const prefs = {
  get: (key: string) => get(`ib:pref:${key}`),
  set: (key: string, value: string) => set(`ib:pref:${key}`, value),
};
