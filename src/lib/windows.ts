import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { kvDelete, kvGetJson, kvKeys, kvSetJson } from "./kv";

/**
 * Sleet can have several windows. Each runs its own copy of this app with its
 * own tabs; the first is "main", the others "window-<id>". Settings,
 * bookmarks and the rest are shared (kv.ts keeps windows in step).
 */
const isTauri = () => "__TAURI_INTERNALS__" in window;

export const WINDOW_LABEL: string = (() => {
  if (!isTauri()) return "main";
  try { return getCurrentWindow().label; } catch { return "main"; }
})();
export const IS_MAIN_WINDOW = WINDOW_LABEL === "main";

/** This window's own saved-state key (tabs, active tab). The main window keeps the original names. */
export const sessionKey = (base: string) => (IS_MAIN_WINDOW ? base : `${base}@${WINDOW_LABEL}`);

const TABS_KEY = "sleet.tabs";
const ACTIVE_KEY = "sleet.active-tab";
const SESSION_KEYS = [TABS_KEY, ACTIVE_KEY];
const labelOfKey = (key: string) => key.slice(key.indexOf("@") + 1);

/**
 * What a window opens with: its tabs (as BrowserTab JSON), which is active,
 * and which of them arrive with their page still loaded (moved, not reloaded).
 */
export interface WindowStart { tabs: unknown[]; activeId: string; live?: string[] }

/** Tabs this window was opened with whose pages came along loaded. */
let adoptedPages: string[] = [];
export const startedWithPages = () => adoptedPages;

export interface WindowInfo { label: string; title: string }

/** Windows other than "main" saved when Sleet last closed, to reopen at launch. */
let toReopen: string[] = [];
export const windowsToReopen = () => { const labels = toReopen; toReopen = []; return labels; };

/**
 * Main window, before the first render: picks which saved windows come back.
 * If the main window had been closed while others stayed open, it takes over
 * one of theirs so nothing is lost.
 */
export function prepareSavedWindows(restore: boolean) {
  const saved = kvKeys(`${TABS_KEY}@`).filter((key) => kvGetJson<unknown[]>(key, []).length > 0).map(labelOfKey);
  if (!restore) {
    saved.forEach(forgetSession);
    return;
  }
  if (kvGetJson<unknown[]>(TABS_KEY, []).length === 0 && saved.length > 0) {
    const label = saved.shift()!;
    kvSetJson(TABS_KEY, kvGetJson(`${TABS_KEY}@${label}`, []));
    kvSetJson(ACTIVE_KEY, kvGetJson(`${ACTIVE_KEY}@${label}`, ""));
    forgetSession(label);
  }
  toReopen = saved;
}

/** Other windows, before the first render: the tabs this window was opened with. */
export async function takeWindowStart() {
  if (IS_MAIN_WINDOW || !isTauri()) return;
  const raw = await invoke<string | null>("take_window_start").catch(() => null);
  if (!raw) return;
  try {
    const start = JSON.parse(raw) as WindowStart;
    if (!Array.isArray(start.tabs) || start.tabs.length === 0) return;
    kvSetJson(sessionKey(TABS_KEY), start.tabs);
    kvSetJson(sessionKey(ACTIVE_KEY), start.activeId);
    adoptedPages = Array.isArray(start.live) ? start.live : [];
  } catch { /* ignore a bad start */ }
}

/** Drops a window's saved tabs (it was closed while other windows stayed open). */
export function forgetSession(label: string) {
  if (label === "main") kvSetJson(TABS_KEY, []);
  else SESSION_KEYS.forEach((key) => kvDelete(`${key}@${label}`));
}

/** Opens a window. `start` gives it tabs; `movePages` moves those tabs' live pages along. */
export async function openWindow(options: { label?: string; start?: WindowStart; movePages?: string[]; position?: [number, number] } = {}) {
  if (!isTauri()) return null;
  return invoke<string>("open_window", {
    request: {
      label: options.label ?? null,
      start: options.start ? JSON.stringify(options.start) : null,
      movePages: options.movePages ?? [],
      position: options.position ?? null,
    },
  });
}

export async function moveTabsToWindow(window: string, start: WindowStart, pages: string[]) {
  await invoke("move_tabs_to_window", { window, tabs: JSON.stringify(start), pages });
}

export async function listWindows(): Promise<WindowInfo[]> {
  if (!isTauri()) return [{ label: WINDOW_LABEL, title: document.title }];
  return invoke<WindowInfo[]>("list_windows").catch(() => [{ label: WINDOW_LABEL, title: document.title }]);
}

/** The other Sleet window under a screen point (physical pixels), if any. */
export async function windowAt(x: number, y: number) {
  if (!isTauri()) return null;
  return invoke<string | null>("window_at", { x, y }).catch(() => null);
}
