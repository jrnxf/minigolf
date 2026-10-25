// Per-device preferences in localStorage. Every access is guarded: private
// windows and blocked storage throw, and the game must still work.

const PREFIX = "minigolf.";

export function load(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    // Storage is optional.
  }
}

export function loadJson<T>(key: string): T | null {
  const raw = load(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

let token: string | null = null;

/** A random secret that lets this phone take its seat back in a room after a drop. */
export function deviceToken(): string {
  token ??= load("token");
  if (!token || !/^[a-f0-9]{32}$/.test(token)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    save("token", token);
  }
  return token;
}
