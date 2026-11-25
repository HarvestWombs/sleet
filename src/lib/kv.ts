import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * Sleet's own saved state (tabs, settings, layout, favicons). In the desktop
 * app it lives in SQLite (src-tauri/src/store.rs), not in the webview's
 * localStorage, because pages share that storage: clearing site data would
 * otherwise wipe Sleet too. Values are loaded once before the first render
 * and read synchronously from memory afterwards; writes go through debounced.
 */

const PREFIX = "sleet.";
/** Keys from before the rename to Sleet; moved to `sleet.` on first launch. */
const OLD_PREFIX = "horizon.";
// Lists that moved to their own tables, and preview-only keys: never copied here.
const NOT_STATE = ["history", "downloads", "preview."];
const renamed = (key: string) => (key.startsWith(OLD_PREFIX) ? PREFIX + key.slice(OLD_PREFIX.length) : key);
const isTauri = () => "__TAURI_INTERNALS__" in window;

let cache: Record<string, string> = {};
const pending = new Map<string, number>();

/**
 * Several Sleet windows share this state, each with its own copy in memory.
 * Every change is announced to the other windows straight away, so none of
 * them writes back a stale value later.
 */
const KV_CHANGED = "sleet-kv-changed";
const SOURCE = Math.random().toString(36).slice(2);
const watchers = new Map<string, Set<() => void>>();
const announce = (key: string, value: string | null) => {
  if (isTauri()) void emit(KV_CHANGED, { key, value, source: SOURCE }).catch(() => undefined);
};

/** Calls `onChange` when another window changes `key`. Returns the unsubscribe function. */
export function kvSubscribe(key: string, onChange: () => void) {
  const set = watchers.get(key) ?? new Set();
  set.add(onChange);
  watchers.set(key, set);
  return () => { set.delete(onChange); };
}

function listenForOtherWindows() {
  void listen<{ key: string; value: string | null; source: string }>(KV_CHANGED, ({ payload }) => {
    if (payload.source === SOURCE) return;
    // Theirs is newer than anything this window still has waiting to write.
    window.clearTimeout(pending.get(payload.key));
    pending.delete(payload.key);
    if (payload.value === null) delete cache[payload.key];
    else cache[payload.key] = payload.value;
    watchers.get(payload.key)?.forEach((onChange) => onChange());
  });
}

const isState = (key: string) => {
  const prefix = key.startsWith(PREFIX) ? PREFIX : key.startsWith(OLD_PREFIX) ? OLD_PREFIX : null;
  if (!prefix) return false;
  const name = key.slice(prefix.length);
  return !NOT_STATE.some((skip) => name === skip || name.startsWith(skip));
};

const fromLocalStorage = () => {
  const entries: Record<string, string> = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && isState(key)) entries[renamed(key)] = localStorage.getItem(key) ?? "";
    }
  } catch { /* storage unavailable */ }
  return entries;
};

/** Loads saved state; on first run moves it over from localStorage. */
export async function loadKv() {
  if (!isTauri()) { cache = fromLocalStorage(); return; }
  listenForOtherWindows();
  try {
    cache = await invoke<Record<string, string>>("kv_all");
    // Rename: values saved as horizon.* become sleet.* (new values win).
    const oldKeys = Object.keys(cache).filter((key) => key.startsWith(OLD_PREFIX));
    if (oldKeys.length > 0) {
      const moved = Object.fromEntries(oldKeys.filter((key) => !(renamed(key) in cache)).map((key) => [renamed(key), cache[key]]));
      if (Object.keys(moved).length > 0) await invoke("kv_set_many", { entries: moved });
      await invoke("kv_delete_prefix", { prefix: OLD_PREFIX });
      oldKeys.forEach((key) => delete cache[key]);
      cache = { ...moved, ...cache };
    }
    const legacy = fromLocalStorage();
    const missing = Object.fromEntries(Object.entries(legacy).filter(([key]) => !(key in cache)));
    if (Object.keys(missing).length > 0) {
      await invoke("kv_set_many", { entries: missing });
      cache = { ...missing, ...cache };
    }
    // Moved: drop the old copies (under either prefix) so nothing reads stale values.
    try { Object.keys(localStorage).filter(isState).forEach((key) => localStorage.removeItem(key)); } catch { /* ignore */ }
  } catch {
    cache = fromLocalStorage();
  }
}

export const kvGet = (key: string): string | null => cache[key] ?? null;

export function kvSet(key: string, value: string) {
  if (cache[key] === value) return;
  cache[key] = value;
  if (!isTauri()) { try { localStorage.setItem(key, value); } catch { /* ignore */ } return; }
  announce(key, value);
  window.clearTimeout(pending.get(key));
  pending.set(key, window.setTimeout(() => {
    pending.delete(key);
    void invoke("kv_set", { key, value: cache[key] ?? value }).catch(() => undefined);
  }, 250));
}

export function kvGetJson<T>(key: string, fallback: T): T {
  const raw = kvGet(key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export const kvSetJson = (key: string, value: unknown) => kvSet(key, JSON.stringify(value));

/** Saved keys starting with `prefix`. */
export const kvKeys = (prefix: string) => Object.keys(cache).filter((key) => key.startsWith(prefix));

/** Removes one saved key. */
export function kvDelete(key: string) {
  if (!(key in cache)) return;
  delete cache[key];
  window.clearTimeout(pending.get(key));
  pending.delete(key);
  if (!isTauri()) { try { localStorage.removeItem(key); } catch { /* ignore */ } return; }
  announce(key, null);
  void invoke("kv_delete", { key }).catch(() => undefined);
}

/** Writes everything still waiting (e.g. before closing). */
export async function kvFlush() {
  if (!isTauri() || pending.size === 0) return;
  const entries = Object.fromEntries([...pending.keys()].map((key) => [key, cache[key]]));
  pending.forEach((timer) => window.clearTimeout(timer));
  pending.clear();
  await invoke("kv_set_many", { entries }).catch(() => undefined);
}

/** Forgets all of Sleet's saved state (Reset Sleet). */
export async function kvClearAll() {
  pending.forEach((timer) => window.clearTimeout(timer));
  pending.clear();
  cache = {};
  if (isTauri()) await invoke("kv_delete_prefix", { prefix: PREFIX }).catch(() => undefined);
  try { Object.keys(localStorage).filter(isState).forEach((key) => localStorage.removeItem(key)); } catch { /* ignore */ }
}
