import { HOME_URL, pageTitle } from "./browser";
import { kvGetJson, kvSetJson } from "./kv";

export type ThemeSetting = "dark" | "system" | "light";
export type Density = "compact" | "comfortable" | "detailed";
export type StartupBehavior = "new-tab" | "restore" | "page";
export type HistoryRetention = "forever" | "30-days" | "session" | "disabled";
export type SearchEngineId = "duckduckgo" | "google" | "bing" | "brave" | "startpage";

export interface Settings {
  theme: ThemeSetting;
  density: Density;
  zoom: number;
  appZoom: number;
  fullUrls: boolean;
  reducedMotion: boolean;
  startup: StartupBehavior;
  startupPage: string;
  newTabPage: string;
  searchEngine: SearchEngineId;
  preferHttps: boolean;
  historyRetention: HistoryRetention;
  downloadDir: string;
  downloadToasts: boolean;
  toastSeconds: number;
  clearCompletedDownloads: boolean;
  inactiveMinutes: number;
  userAgent: string;
  trackingPrevention: "none" | "basic" | "balanced" | "strict";
  httpsOnly: boolean;
  blockPopups: boolean;
  clearHistoryOnExit: boolean;
  clearSiteDataOnExit: boolean;
  /** Overall text size multiplier. */
  textSize: number;
  /** Extra text size per part of the UI (multiplies `textSize`). */
  textAreas: Partial<Record<"sidebar" | "toolbar" | "dropdown" | "toasts" | "pages" | "popups", number>>;
  toastPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Ask to save passwords after signing in. */
  passwordsOffer: boolean;
  /** Origins where Sleet never offers to save. */
  passwordsNever: string[];
  /** Minutes unused before the vault locks (0 = never). */
  vaultAutoLock: number;
  generatorLength: number;
  /** "Not now" on the default-browser prompt: never ask again (Settings still offers it). */
  defaultBrowserPromptDismissed: boolean;
  /** "Always allow" answers for links that open other apps, as `origin|scheme`. */
  externalAllowed: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  density: "comfortable",
  zoom: 1,
  appZoom: 1,
  fullUrls: false,
  reducedMotion: false,
  startup: "restore",
  startupPage: HOME_URL,
  newTabPage: HOME_URL,
  searchEngine: "duckduckgo",
  preferHttps: true,
  historyRetention: "forever",
  downloadDir: "",
  downloadToasts: true,
  toastSeconds: 5,
  clearCompletedDownloads: false,
  inactiveMinutes: 5,
  trackingPrevention: "balanced",
  httpsOnly: false,
  blockPopups: true,
  clearHistoryOnExit: false,
  clearSiteDataOnExit: false,
  textSize: 1,
  textAreas: {},
  toastPosition: "top-left",
  defaultBrowserPromptDismissed: false,
  externalAllowed: [],
  passwordsOffer: true,
  passwordsNever: [],
  vaultAutoLock: 15,
  generatorLength: 20,
  userAgent: "",
};

export const SEARCH_ENGINES: Record<SearchEngineId, { name: string; url: string }> = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=" },
};

export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const APP_ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
export const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/** Next zoom level up or down from `current`. */
export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? ZOOM_LEVELS[0];
}

export const SETTINGS_KEY = "sleet.settings";

export function readSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...kvGetJson<Partial<Settings>>(SETTINGS_KEY, {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function pruneHistory<T extends { visitedAt: number }>(items: T[], retention: HistoryRetention, now = Date.now()): T[] {
  if (retention === "disabled") return [];
  if (retention === "30-days") return items.filter((item) => now - item.visitedAt < THIRTY_DAYS);
  return items;
}

/**
 * Runs once before the first render: applies startup behavior. Launch-time
 * history/download pruning happens against SQLite in App.
 */
export function applyLaunchSettings() {
  const settings = readSettings();
  try {
    if (settings.startup !== "restore") {
      const url = settings.startup === "page" ? settings.startupPage || HOME_URL : settings.newTabPage || HOME_URL;
      const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      kvSetJson("sleet.tabs", [{ id, title: pageTitle(url), url, createdAt: Date.now() }]);
      kvSetJson("sleet.active-tab", id);
    }

  } catch {
    // Storage may be unavailable; fall back to stored state.
  }
}
