import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserPreview } from "./components/BrowserPreview";
import { matchCommands, type PaletteCommand } from "./lib/commands";
import { ContextMenu, type MenuEntry, type MenuRequest } from "./components/ContextMenu";
import { HomeSurface } from "./components/HomeSurface";
import { LibrarySurface } from "./components/LibrarySurface";
import { type ClearDataOptions, SettingsSurface } from "./components/SettingsSurface";
import { TabSidebar } from "./components/TabSidebar";
import { type PromptChoice, type Toast, Toasts } from "./components/Toasts";
import { type PermissionChoice, type SiteInfo, SiteInfoPanel } from "./components/SiteInfoPanel";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Toolbar } from "./components/Toolbar";
import { usePersistentState } from "./hooks/usePersistentState";
import { tooltipPosition, useTooltips } from "./hooks/useTooltips";
import { kvClearAll, kvFlush } from "./lib/kv";
import { appearanceVars, applyVars } from "./lib/appearance";
import { HOME_URL, isHomeUrl, normalizeAddress, pageTitle, siteSecurity } from "./lib/browser";
import { DEFAULT_SETTINGS, SEARCH_ENGINES, SETTINGS_KEY, type Settings, stepZoom, THIRTY_DAYS } from "./lib/settings";
import {
  activateView,
  browserAction,
  allowCertificate,
  allowHttp,
  clearOriginData,
  clearSiteData,
  resolvePermission,
  setPrivacyOptions,
  defaultBrowserStatus,
  makeDefaultBrowser,
  takeLaunchUrls,
  type DefaultBrowserStatus,
  type SiteDataKind,
  closeView,
  createView,
  focusChrome,
  isTauri,
  navigateView,
  overlayHide,
  overlayPlace,
  overlayShow,
  emitEvent,
  listenEvent,
  stepHistory,
  resizeView,
  setChromeZoom,
  setDownloadDir,
  setViewMuted,
  cancelDownload as cancelNativeDownload,
  resolveDownloadCheck,
  setViewsZoom,
  subscribeToBrowserEvents,
  viewLabel,
  stopLoading,
  findInPage,
  findClear,
  printPage,
  savePagePdf,
  openExternal,
  type CrashEvent,
  type ExternalLinkEvent,
  type FindResult,
  type FullscreenEvent,
} from "./native/browserEngine";
import { FindBar } from "./components/FindBar";
import * as store from "./native/store";
import { OVERLAY_EVENTS, type OverlayAction, type OverlayKind, type OverlayRendered, type OverlaySize, overlayLabel } from "./lib/overlay";
import { neighbour, recordVisit } from "./lib/tabNav";
import { buildSuggestions, type Suggestion } from "./lib/suggest";
import { faviconFor, onFaviconsChanged, rememberFavicon, rememberFavicons } from "./lib/favicons";
import { addBookmark, type Bookmark, findByUrl, groupBookmarks, moveBookmark, removeBookmark, ungroupFolder, updateBookmark } from "./lib/bookmarks";
import { BookmarkEditor, BookmarkGrid, type BookmarkState } from "./components/BookmarkGrid";
import { type LoginItem, LoginsMenu } from "./components/LoginsMenu";
import { useVaultStatus } from "./components/Passwords";
import { type VaultEntry, vaultFill, vaultFillGenerated, vaultMatches, vaultOfferRecheck, vaultResolveOffer, vaultSetAutoLock, vaultError } from "./native/vault";
import type { AudioState, BrowserTab, CertErrorEvent, ContextEvent, HttpsFailedEvent, PermissionRequestEvent, PopupBlockedEvent, DownloadCheckEvent, DownloadEvent, DownloadStateEvent, DownloadItem, DownloadProgressEvent, HistoryEntry, SidebarMode, Surface, ViewBounds } from "./types";

const initialTab: BrowserTab = { id: "home", title: "Home", url: HOME_URL, createdAt: Date.now() };

const DEFAULT_SIDEBAR_WIDTH = 220;
const RECENT_HISTORY = 200;
const SHORTCUTS: Record<string, string> = {
  k: "palette", l: "address", t: "new-tab", w: "close-tab", y: "history", j: "downloads", ",": "settings",
  "=": "zoom-in", "+": "zoom-in", "-": "zoom-out", "0": "zoom-reset", d: "bookmark",
  f: "find", g: "find-next", p: "print", r: "reload", tab: "next-tab", pagedown: "next-tab", pageup: "previous-tab",
};
const SHIFTED_SHORTCUTS: Record<string, string> = {
  n: "new-private-tab", w: "reopen-tab", t: "reopen-tab", tab: "previous-tab", g: "find-previous", delete: "clear-data", r: "reload",
};
const NO_MATCHES: FindResult = { count: 0, index: -1 };
const makeId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const clampSidebarWidth = (width: number) => Math.min(360, Math.max(176, Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH));
const filenameFrom = (url: string, path?: string) => {
  if (path) return path.split(/[\\/]/).at(-1) || "Download";
  try { return decodeURIComponent(new URL(url).pathname.split("/").at(-1) || "") || "Download"; } catch { return "Download"; }
};
const ALT_DIGIT_DELAY = 650;
const copyText = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); };
/** Reverse image search URL for the chosen engine (Google Lens unless the engine has its own). */
const imageSearchUrl = (engine: string, imageUrl: string) => engine === "bing"
  ? `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${encodeURIComponent(imageUrl)}`
  : `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
const prefersLight = () => window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;

export default function App() {
  const [tabs, setTabs] = usePersistentState<BrowserTab[]>("sleet.tabs", [initialTab], (items) => {
    const kept = items.filter((tab) => !tab.private).map(({ certError: _certError, ...tab }) => tab);
    return kept.length > 0 ? kept : [initialTab];
  });
  const [activeId, setActiveId] = usePersistentState("sleet.active-tab", initialTab.id);
  const [bookmarks, setBookmarks] = usePersistentState<Bookmark[]>("sleet.bookmarks", []);
  const [expandedFolders, setExpandedFolders] = usePersistentState<string[]>("sleet.bookmark-folders", []);
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const vault = useVaultStatus();
  /** Saved logins for the active page (only while unlocked). */
  const [pageLogins, setPageLogins] = useState<VaultEntry[]>([]);
  /** The fill dropdown: under a focused login field, or under the address-bar key. */
  const [loginsMenu, setLoginsMenu] = useState<{ label: string; anchor: { x: number; y: number; width: number }; items: LoginItem[]; from: "field" | "toolbar" } | null>(null);
  const waitingOffers = useRef(new Set<string>());
  const [savedSidebarWidth, setSidebarWidth] = usePersistentState("sleet.sidebar-width", DEFAULT_SIDEBAR_WIDTH);
  const [storedSettings, setStoredSettings] = usePersistentState<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS);
  const settings = useMemo(() => ({ ...DEFAULT_SETTINGS, ...storedSettings }), [storedSettings]);
  const sidebarWidth = clampSidebarWidth(savedSidebarWidth);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const tooltip = useTooltips();
  const [audio, setAudio] = useState<Record<string, AudioState>>({});
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [surface, setSurface] = useState<Surface>("browser");
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("tabs");
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  /** Ctrl+K: the address bar lists commands as well as sites and searches. */
  const [commandMode, setCommandMode] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [siteInfoOpen, setSiteInfoOpen] = useState(false);
  const [siteInfoSession, setSiteInfoSession] = useState(0);
  const [, setFaviconVersion] = useState(0);
  useEffect(() => onFaviconsChanged(() => setFaviconVersion((version) => version + 1)), []);
  const [defaultBrowser, setDefaultBrowser] = useState<DefaultBrowserStatus | null>(null);
  const [sitePermissions, setSitePermissions] = useState<Record<string, "allow" | "block">>({});
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
  const [overlaySizes, setOverlaySizes] = useState<Partial<Record<OverlayKind, { width: number; height: number }>>>({});
  const overlayReady = useRef(new Set<OverlayKind>());
  const [systemLight, setSystemLight] = useState(prefersLight);
  const [downloadDirError, setDownloadDirError] = useState<string | null>(null);
  // Restored tabs start unloaded; only the active one gets a page at launch.
  const [sleeping, setSleeping] = useState<Set<string>>(() => new Set(tabs.filter((tab) => tab.id !== activeId && !isHomeUrl(tab.url)).map((tab) => tab.id)));
  /** Tabs whose page is loading right now (never saved). */
  const [loadingTabs, setLoadingTabs] = useState<Set<string>>(() => new Set());
  /** Tabs whose page process crashed or hung; they show a "page crashed" screen. */
  const [crashed, setCrashed] = useState<Record<string, CrashEvent["kind"]>>({});
  /** A page asked for full screen (video), or F11. Both hide Sleet's interface. */
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const [windowFullscreen, setWindowFullscreen] = useState(false);
  const [find, setFind] = useState<{ open: boolean; query: string; result: FindResult; focus: number }>({ open: false, query: "", result: NO_MATCHES, focus: 0 });
  const findRef = useRef(find);
  findRef.current = find;
  const findSeq = useRef(0);
  const findTab = useRef<string | null>(null);
  const [clearRequest, setClearRequest] = useState(0);
  const loadingRef = useRef(loadingTabs);
  loadingRef.current = loadingTabs;
  const pageRef = useRef<HTMLDivElement>(null);
  const createdViews = useRef(new Set<string>());
  const lastActiveAt = useRef(new Map<string, number>());
  const suppressPageFocus = useRef(false);
  /** Tabs whose back/forward follow Sleet's saved history instead of the page's own (after an unload). */
  const savedHistoryTabs = useRef(new Set<string>());
  /** Recently closed tabs, newest last, for "Reopen closed tab" (kept for this session). */
  const closedTabs = useRef<{ tab: BrowserTab; index: number }[]>([]);
  const altDigits = useRef<{ value: string; timer: number | undefined }>({ value: "", timer: undefined });
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const vaultRef = useRef<typeof vault>(null);
  const loginItemsForRef = useRef<(entries: VaultEntry[], options: { newPassword: boolean; locked: boolean }) => LoginItem[]>(() => []);
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) ?? tabs[0], [activeId, tabs]);
  const tabKey = tabs.map((tab) => tab.id).join(",");
  const activeIsHome = isHomeUrl(activeTab?.url);
  const activeAsleep = !!activeTab && sleeping.has(activeTab.id);
  // ---- Site info panel (lock icon)
  const siteOrigin = (() => {
    if (!activeTab || isHomeUrl(activeTab.url)) return "";
    try { return new URL(activeTab.url).origin; } catch { return ""; }
  })();
  const siteInfo: SiteInfo | null = activeTab ? {
    host: siteOrigin ? new URL(activeTab.url).host : "",
    origin: siteOrigin,
    security: siteSecurity(activeTab),
    problem: activeTab.certError?.problem,
    private: !!activeTab.private,
    permissions: sitePermissions,
    trackingPrevention: { none: "off", basic: "basic", balanced: "balanced", strict: "strict" }[settings.trackingPrevention],
  } : null;

  const updateSettings = useCallback((patch: Partial<Settings>) => setStoredSettings((current) => ({ ...DEFAULT_SETTINGS, ...current, ...patch })), [setStoredSettings]);

  const addressOptions = () => ({ searchUrl: SEARCH_ENGINES[settingsRef.current.searchEngine]?.url, preferHttps: settingsRef.current.preferHttps });
  const tabZoom = (tabId: string) => tabsRef.current.find((tab) => tab.id === tabId)?.zoom ?? settingsRef.current.zoom;

  const showMessage = useCallback((message: string) => {
    setToasts((items) => [...items, { id: makeId(), message, expiresAt: Date.now() + settingsRef.current.toastSeconds * 1000 }]);
  }, []);

  /** Page bounds in window logical pixels (CSS pixels scaled by interface zoom). */
  const getBounds = useCallback((): ViewBounds | null => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    const scale = settingsRef.current.appZoom || 1;
    return { x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistory(await store.historyList(RECENT_HISTORY));
    setHistoryVersion((version) => version + 1);
  }, []);

  const addHistory = useCallback((url: string, title: string) => {
    if (!url.startsWith("http") || settingsRef.current.historyRetention === "disabled") return;
    void store.historyAdd(url, title || pageTitle(url)).then((entry) => {
      setHistory((items) => [entry, ...items.filter((item) => item.url !== url)].slice(0, RECENT_HISTORY));
      setHistoryVersion((version) => version + 1);
    }).catch(() => undefined);
  }, []);

  /** Updates a tab's address and saved history from a page event. */
  const recordUrl = useCallback((tabId: string, url: string) => {
    let host = "";
    try { host = new URL(url).hostname; } catch { /* keep empty */ }
    setTabs((items) => items.map((tab) => tab.id === tabId
      ? { ...tab, url, nav: recordVisit(tab.nav, tab.url, url), certError: tab.certError?.host === host ? tab.certError : undefined }
      : tab));
  }, [setTabs]);

  const focusAddress = useCallback(async () => {
    setSurface("browser");
    await focusChrome();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>("[data-address-input]");
      input?.focus();
      input?.select();
    }));
  }, []);

  /** Creates the page webview for a tab if it has none (new, unloaded, or leaving home). */
  const ensureView = useCallback(async (tabId: string, url: string) => {
    if (isHomeUrl(url) || createdViews.current.has(tabId)) return;
    const bounds = getBounds();
    if (!bounds) return;
    createdViews.current.add(tabId);
    lastActiveAt.current.set(tabId, Date.now());
    setCrashed((current) => { if (!(tabId in current)) return current; const next = { ...current }; delete next[tabId]; return next; });
    if ((tabsRef.current.find((tab) => tab.id === tabId)?.nav?.stack.length ?? 0) > 1) savedHistoryTabs.current.add(tabId);
    setSleeping((current) => { if (!current.has(tabId)) return current; const next = new Set(current); next.delete(tabId); return next; });
    const isPrivate = tabsRef.current.find((tab) => tab.id === tabId)?.private ?? false;
    await createView(tabId, url, bounds, { zoom: tabZoom(tabId), userAgent: settingsRef.current.userAgent, private: isPrivate });
  }, [getBounds]);

  /**
   * `background` adds the tab without switching to it; its page loads when first
   * selected. `nextToActive` places it right after the current tab (link opens).
   */
  const newTab = useCallback(async (input?: string, options: { focusAddress?: boolean; background?: boolean; nextToActive?: boolean; private?: boolean; bookmarkId?: string } = {}) => {
    const url = normalizeAddress(input ?? (options.private ? HOME_URL : settingsRef.current.newTabPage || HOME_URL), addressOptions());
    // Links opened from a private tab stay private.
    const opener = tabsRef.current.find((item) => item.id === activeIdRef.current);
    const isPrivate = options.private ?? (options.nextToActive ? opener?.private : false) ?? false;
    const tab: BrowserTab = { id: makeId(), title: isHomeUrl(url) && isPrivate ? "Private tab" : pageTitle(url), url, createdAt: Date.now(), ...(isPrivate ? { private: true } : {}), ...(options.bookmarkId ? { bookmarkId: options.bookmarkId } : {}) };
    const items = tabsRef.current;
    const at = options.nextToActive ? Math.max(0, items.findIndex((item) => item.id === activeIdRef.current)) + 1 : items.length;
    const next = [...items.slice(0, at), tab, ...items.slice(at)];
    tabsRef.current = next;
    setTabs(next);
    if (options.background) {
      if (!isHomeUrl(url)) setSleeping((current) => new Set([...current, tab.id]));
      return;
    }
    setActiveId(tab.id);
    setSurface("browser");
    setSidebarMode("tabs");
    await ensureView(tab.id, url);
    if (options.focusAddress) void focusAddress();
  }, [ensureView, focusAddress, setActiveId, setTabs]);

  const navigate = useCallback(async (input: string) => {
    if (!activeTab) return;
    const url = normalizeAddress(input, addressOptions());
    setTabs((items) => items.map((tab) => tab.id === activeTab.id ? { ...tab, url, title: pageTitle(url) } : tab));
    setSurface("browser");
    if (isHomeUrl(url)) return;
    if (createdViews.current.has(activeTab.id)) await navigateView(activeTab.id, url);
    else await ensureView(activeTab.id, url);
    await activateView(activeTab.id, tabsRef.current.map((tab) => tab.id), true);
  }, [activeTab, ensureView, setTabs]);

  const selectTab = useCallback((id: string) => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!tab) return;
    setActiveId(id);
    setSurface("browser");
    void (async () => {
      await ensureView(id, tab.url);
      if (!isHomeUrl(tab.url)) await activateView(id, tabsRef.current.map((item) => item.id), true);
    })();
  }, [ensureView, setActiveId]);

  /**
   * Closes several tabs at once. The tab list is computed once up front, so
   * "close tabs above/below/others" removes every tab, not just the first few.
   */
  const closeTabs = useCallback(async (ids: string[]) => {
    const closing = new Set(ids);
    const before = tabsRef.current;
    if (!before.some((tab) => closing.has(tab.id))) return;
    const remaining = before.filter((tab) => !closing.has(tab.id));
    const activeIndex = before.findIndex((tab) => tab.id === activeIdRef.current);
    before.forEach((tab, index) => {
      if (closing.has(tab.id)) closedTabs.current.push({ tab: { ...tab, certError: undefined }, index });
    });
    closedTabs.current = closedTabs.current.slice(-25);
    tabsRef.current = remaining;
    ids.forEach((id) => {
      createdViews.current.delete(id);
      lastActiveAt.current.delete(id);
      savedHistoryTabs.current.delete(id);
    });
    setAudio((current) => { const next = { ...current }; ids.forEach((id) => delete next[id]); return next; });
    setSleeping((current) => { const next = new Set(current); ids.forEach((id) => next.delete(id)); return next; });
    setLoadingTabs((current) => { const next = new Set(current); ids.forEach((id) => next.delete(id)); return next; });
    setCrashed((current) => { const next = { ...current }; ids.forEach((id) => delete next[id]); return next; });
    setTabs(remaining);
    await Promise.all(ids.map((id) => closeView(id)));
    if (remaining.length === 0) {
      await newTab();
      return;
    }
    if (closing.has(activeIdRef.current)) {
      // Prefer the nearest surviving tab before the closed active one, else the first.
      const previous = before.slice(0, Math.max(0, activeIndex)).reverse().find((tab) => !closing.has(tab.id));
      selectTab((previous ?? remaining[0]).id);
    }
  }, [newTab, selectTab, setTabs]);

  const closeTab = useCallback((id: string) => closeTabs([id]), [closeTabs]);

  /** Brings back the most recently closed tab where it was, with its history. */
  const reopenClosedTab = useCallback(async () => {
    const entry = closedTabs.current.pop();
    if (!entry) return;
    const tab: BrowserTab = { ...entry.tab, id: makeId(), createdAt: Date.now() };
    const items = tabsRef.current;
    const at = Math.min(entry.index, items.length);
    const next = [...items.slice(0, at), tab, ...items.slice(at)];
    tabsRef.current = next;
    setTabs(next);
    setSidebarMode("tabs");
    selectTab(tab.id);
  }, [selectTab, setTabs]);

  /**
   * Back/forward: the page's own history first; when it has nowhere to go (a
   * tab reloaded after unloading, or the first page after Home) Sleet's saved
   * history for the tab takes over, and keeps driving that tab from then on.
   */
  const goHistory = useCallback(async (back: boolean) => {
    const tab = tabsRef.current.find((item) => item.id === activeIdRef.current);
    if (!tab) return;
    const hasView = createdViews.current.has(tab.id);
    const useSaved = savedHistoryTabs.current.has(tab.id) || isHomeUrl(tab.url);
    if (hasView && !useSaved && await stepHistory(tab.id, back)) return;
    const step = neighbour(tab.nav, back);
    if (!step) return;
    savedHistoryTabs.current.add(tab.id);
    setTabs((items) => items.map((item) => item.id === tab.id
      ? { ...item, url: step.url, title: isHomeUrl(step.url) ? pageTitle(step.url) : item.title, nav: { stack: item.nav?.stack ?? [step.url], index: step.index } }
      : item));
    setSurface("browser");
    if (isHomeUrl(step.url)) return;
    if (hasView) await navigateView(tab.id, step.url);
    else await ensureView(tab.id, step.url);
    await activateView(tab.id, tabsRef.current.map((item) => item.id), true);
  }, [ensureView, setTabs]);

  const reorderTab = useCallback((id: string, toIndex: number) => {
    setTabs((items) => {
      const from = items.findIndex((tab) => tab.id === id);
      if (from === -1) return items;
      const target = from < toIndex ? toIndex - 1 : toIndex;
      if (target === from) return items;
      const next = items.filter((tab) => tab.id !== id);
      next.splice(Math.max(0, Math.min(target, next.length)), 0, items[from]);
      return next;
    });
  }, [setTabs]);

  const toggleMute = useCallback((id: string) => {
    const muted = !(audio[id]?.muted ?? false);
    setAudio((current) => ({ ...current, [id]: { playing: current[id]?.playing ?? false, muted } }));
    void setViewMuted(id, muted);
  }, [audio]);

  /** Puts a tab's page to sleep now, keeping its entry. */
  const unloadTab = useCallback((id: string) => {
    if (id === activeIdRef.current || !createdViews.current.has(id)) return;
    createdViews.current.delete(id);
    void closeView(id);
    setSleeping((current) => new Set([...current, id]));
    setAudio((current) => { const next = { ...current }; delete next[id]; return next; });
  }, []);

  /** Reloads a page; an unloaded or crashed tab gets a fresh page. */
  const reloadTab = useCallback((id: string) => {
    if (isHomeUrl(tabsRef.current.find((item) => item.id === id)?.url)) return;
    if (createdViews.current.has(id)) void browserAction(id, "reload");
    else selectTab(id);
  }, [selectTab]);

  const setZoom = useCallback((direction: 1 | -1 | 0) => {
    const tab = tabsRef.current.find((item) => item.id === activeId);
    if (!tab || isHomeUrl(tab.url)) return;
    const base = settingsRef.current.zoom;
    const next = direction === 0 ? base : stepZoom(tab.zoom ?? base, direction);
    setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, zoom: Math.abs(next - base) < 0.001 ? undefined : next } : item));
    void setViewsZoom([tab.id], next);
  }, [activeId, setTabs]);

  const saveDownload = (item: DownloadItem) => {
    const tabId = item.id.slice(0, item.id.indexOf(":")).replace(/^page-/, "");
    if (tabsRef.current.find((tab) => tab.id === tabId)?.private) return;
    void store.downloadPut(item).catch(() => undefined);
  };

  const handleDownload = useCallback((event: DownloadEvent) => {
    const id = `${event.label}:${event.url}`;
    if (event.phase === "requested") {
      const item: DownloadItem = { id, filename: filenameFrom(event.url, event.path), url: event.url, path: event.path, status: "active", startedAt: Date.now() };
      setDownloads((items) => [item, ...items.filter((existing) => existing.id !== id)]);
      saveDownload(item);
      if (settingsRef.current.downloadToasts) setToasts((items) => [...items.filter((toast) => toast.id !== id), { id, downloadId: id, expiresAt: Date.now() + settingsRef.current.toastSeconds * 1000 }]);
      return;
    }
    // Fallback for platforms without Sleet's own end-state event. The address
    // here can be the redirected one, so match the newest running download from
    // the same tab rather than creating a duplicate entry.
    const previous = downloadsRef.current.find((item) => item.id === id && item.status === "active")
      ?? downloadsRef.current.find((item) => item.status === "active" && item.id.startsWith(`${event.label}:`));
    if (!previous) return;
    finishDownload(previous.id, event.success ? "complete" : "failed", event.path ?? undefined);
  }, []);

  /** Marks a download finished (complete / cancelled / failed) and times out its toast. */
  const finishDownload = (id: string, status: "complete" | "cancelled" | "failed", path?: string, error?: string) => {
    const previous = downloadsRef.current.find((item) => item.id === id);
    if (!previous || previous.status !== "active") return;
    const finished: DownloadItem = {
      ...previous,
      path: path ?? previous.path,
      filename: filenameFrom(previous.url, path ?? previous.path),
      status,
      error: status === "failed" ? error ?? "Download failed" : undefined,
      received: status === "complete" && previous.total ? previous.total : previous.received,
    };
    downloadsRef.current = downloadsRef.current.map((item) => item.id === id ? finished : item);
    setDownloads((items) => items.map((item) => item.id === id ? finished : item));
    saveDownload(finished);
    const hideAt = Date.now() + settingsRef.current.toastSeconds * 1000;
    setToasts((items) => items.map((toast) => toast.id === id && toast.expiresAt !== null ? { ...toast, expiresAt: hideAt, leaving: false } : toast));
  };

  const handleDownloadState = useCallback((event: DownloadStateEvent) => {
    finishDownload(`${event.label}:${event.url}`, event.state, event.path ?? undefined, event.reason ?? undefined);
  }, []);

  const handleDownloadCheck = useCallback((event: DownloadCheckEvent) => {
    setToasts((items) => [...items, { id: `check-${event.checkId}`, check: event, expiresAt: null }]);
  }, []);

  /** Hovering a toast pauses its timer; leaving restarts it. Prompts that wait for an answer are left alone. */
  const dismissToast = (id: string) => {
    const toast = toasts.find((item) => item.id === id);
    if (toast?.prompt?.kind === "password") void vaultResolveOffer(toast.prompt.pendingId, true).catch(() => undefined);
    setToasts((items) => items.filter((item) => item.id !== id));
  };

  const holdToast = useCallback((id: string, hovering: boolean) => {
    setToasts((items) => items.map((toast) => {
      if (toast.id !== id || toast.check || (toast.prompt && toast.prompt.kind !== "popup")) return toast;
      return { ...toast, leaving: false, expiresAt: hovering ? null : Date.now() + Math.max(2000, settingsRef.current.toastSeconds * 500) };
    }));
  }, []);

  const resolveCheck = useCallback((check: DownloadCheckEvent, keep: boolean) => {
    setToasts((items) => items.filter((toast) => toast.id !== `check-${check.checkId}`));
    void resolveDownloadCheck(check.checkId, keep);
  }, []);

  const cancelDownload = useCallback((download: DownloadItem) => {
    if (download.status !== "active") return;
    void cancelNativeDownload(download.id);
    // Mark it straight away; the engine's own "cancelled" report changes nothing further.
    finishDownload(download.id, "cancelled");
  }, []);

  const handleDownloadProgress = useCallback((event: DownloadProgressEvent) => {
    const id = `${event.label}:${event.url}`;
    setDownloads((items) => items.map((item) => item.id === id && item.status === "active" ? { ...item, received: event.received, total: event.total } : item));
  }, []);

  const openDownload = useCallback((download: DownloadItem) => {
    store.openDownload(download.id).catch((error) => showMessage(String(error)));
  }, [showMessage]);
  const revealDownload = useCallback((download: DownloadItem) => {
    store.revealDownload(download.id).catch((error) => showMessage(String(error)));
  }, [showMessage]);
  const openFolder = useCallback(() => {
    store.openDownloadsFolder().catch((error) => showMessage(String(error)));
  }, [showMessage]);

  const openSettings = useCallback((section?: string) => {
    setSettingsSection(section);
    setSurface("settings");
  }, []);

  const toggleSurface = useCallback((next: Surface) => setSurface((current) => current === next ? "browser" : next), []);

  /** Ctrl+K: focus the address bar and list every command in its dropdown. */
  const openPalette = useCallback(async () => {
    await focusAddress();
    setCommandMode(true);
    setSelectedSuggestion(-1);
    setSuggestions(commandRows(""));
  }, [focusAddress]);

  /** Leaves command mode and hands keyboard focus back to the page. */
  const closePalette = useCallback((refocusPage = true) => {
    setCommandMode(false);
    setSuggestions([]);
    (document.activeElement as HTMLElement | null)?.blur();
    if (!refocusPage) return;
    const tab = tabsRef.current.find((item) => item.id === activeIdRef.current);
    if (surfaceRef.current === "browser" && tab && !isHomeUrl(tab.url) && createdViews.current.has(tab.id)) {
      void activateView(tab.id, tabsRef.current.map((item) => item.id), true);
    } else {
      void focusChrome();
    }
  }, []);

  /** Ends an Alt+digits sequence (Alt released or the pause ran out). */
  const commitTabDigits = useCallback(() => {
    const buffer = altDigits.current;
    window.clearTimeout(buffer.timer);
    buffer.value = "";
  }, []);

  /**
   * Alt+digits selects a tab immediately: Alt+1 jumps to tab 1 at once, and a
   * second digit typed quickly (Alt+1, 5) moves on to tab 15. The sequence ends
   * when Alt is released, after a short pause, or when no longer number exists.
   */
  const pushTabDigit = useCallback((digit: string) => {
    const buffer = altDigits.current;
    const candidate = buffer.value + digit;
    const number = Number(candidate);
    if (!number) return;
    const count = tabsRef.current.length;
    window.clearTimeout(buffer.timer);
    setSidebarMode("tabs");
    if (number > count) {
      // Too big as a continuation: treat this digit as a fresh number.
      buffer.value = "";
      if (buffer.value !== candidate && Number(digit) >= 1 && Number(digit) <= count) {
        buffer.value = digit;
        selectTab(tabsRef.current[Number(digit) - 1].id);
      }
    } else {
      buffer.value = candidate;
      selectTab(tabsRef.current[number - 1].id);
    }
    if (!buffer.value || Number(buffer.value) * 10 > count) { buffer.value = ""; return; }
    buffer.timer = window.setTimeout(commitTabDigits, ALT_DIGIT_DELAY);
  }, [commitTabDigits, selectTab]);

  /** Commands added later (tabs by position, find, print, full screen...). */
  const moreShortcutsRef = useRef<(command: string) => boolean>(() => false);

  /** Shared by the chrome's own key handler and keys forwarded from pages. */
  const runShortcut = useCallback((command: string) => {
    if (moreShortcutsRef.current(command)) return;
    const digit = /^tab-digit-([0-9])$/.exec(command);
    if (digit) { pushTabDigit(digit[1]); return; }
    if (command === "tab-commit") { commitTabDigits(); return; }
    if (command === "back" || command === "forward") { void goHistory(command === "back"); return; }
    if (command === "palette") { if (commandMode) closePalette(); else void openPalette(); }
    if (command === "address") void focusAddress();
    if (command === "new-tab") void newTab(undefined, { focusAddress: true });
    if (command === "close-tab" && activeTab) void closeTab(activeTab.id);
    if (command === "new-private-tab") void newTab(undefined, { private: true, focusAddress: true });
    if (command === "reopen-tab") void reopenClosedTab();
    if (command === "bookmark") toggleBookmarkRef.current();
    if (command === "history") toggleSurface("history");
    if (command === "downloads") toggleSurface("downloads");
    if (command === "settings") { if (surface === "settings") setSurface("browser"); else openSettings(); }
    if (command === "zoom-in") setZoom(1);
    if (command === "zoom-out") setZoom(-1);
    if (command === "zoom-reset") setZoom(0);
  }, [activeTab, closePalette, closeTab, commitTabDigits, focusAddress, goHistory, newTab, openPalette, openSettings, commandMode, pushTabDigit, reopenClosedTab, setZoom, surface, toggleSurface]);
  const runShortcutRef = useRef(runShortcut);
  runShortcutRef.current = runShortcut;

  const runPaletteCommand = (command: PaletteCommand) => {
    if (command.kind === "navigate") void navigate(command.value);
    if (command.kind === "new-tab") void newTab(undefined, { focusAddress: true });
    if (command.kind === "history") setSurface("history");
    if (command.kind === "downloads") setSurface("downloads");
    if (command.kind === "settings") openSettings(command.section);
    if (command.kind === "new-private-tab") void newTab(undefined, { private: true, focusAddress: true });
    if (command.kind === "reopen-tab") void reopenClosedTab();
    if (command.kind === "bookmark") toggleBookmarkRef.current();
    if (command.kind === "find") void openFind();
    if (command.kind === "print") void printActive();
    if (command.kind === "save-pdf") void savePdfActive();
    if (command.kind === "fullscreen") setWindowFullscreen((on) => !on);
    if (command.kind === "toggle-theme") {
      const light = settings.theme === "light" || (settings.theme === "system" && systemLight);
      updateSettings({ theme: light ? "dark" : "light" });
    }
  };

  // Launch: move old localStorage lists into SQLite, apply retention, load lists.
  useEffect(() => {
    void (async () => {
      await store.importLegacyLists();
      const { historyRetention, clearCompletedDownloads } = settingsRef.current;
      if (historyRetention === "session" || historyRetention === "disabled") await store.historyClear();
      if (historyRetention === "30-days") await store.historyClear(Date.now() - THIRTY_DAYS);
      if (clearCompletedDownloads) await store.downloadsClear(true);
      // Downloads still "active" belong to a previous run and can't resume.
      const rows = await store.downloadsList(500);
      setDownloads(rows.map((row) => row.status === "active" ? { ...row, status: "failed" } : row));
      await refreshHistory();
    })().catch(() => undefined);
  }, [refreshHistory]);

  // ---- Passwords: save prompts, the fill dropdown, logins for this page.
  useEffect(() => { void vaultSetAutoLock(settings.vaultAutoLock); }, [settings.vaultAutoLock]);

  useEffect(() => {
    const url = activeTab && !isHomeUrl(activeTab.url) ? activeTab.url : "";
    if (!vault?.unlocked || !url) { setPageLogins([]); return; }
    void vaultMatches(url).then(setPageLogins).catch(() => setPageLogins([]));
  }, [activeTab?.url, vault?.unlocked, vault?.count]);

  // After unlocking, re-ask about logins that were waiting for it.
  useEffect(() => {
    if (!vault?.unlocked || waitingOffers.current.size === 0) return;
    const waiting = [...waitingOffers.current];
    waitingOffers.current.clear();
    waiting.forEach((pendingId) => void vaultOfferRecheck(pendingId).then((offer) => {
      setToasts((items) => [...items.filter((toast) => toast.id !== `password-${pendingId}`), { id: `password-${pendingId}`, prompt: { kind: "password", pendingId, label: "", origin: offer.origin, username: offer.username, offer: offer.kind }, expiresAt: null }]);
    }).catch(() => undefined));
  }, [vault?.unlocked]);

  const loginItemsFor = (entries: VaultEntry[], options: { newPassword: boolean; locked: boolean }): LoginItem[] => {
    if (options.locked) return [{ key: "unlock", kind: "unlock", title: "Unlock passwords to fill", subtitle: "Opens Settings → Passwords" }];
    const items: LoginItem[] = entries.map((entry) => ({ key: entry.id, kind: "login", id: entry.id, title: entry.username || "(no username)", subtitle: entry.origin.replace(/^https?:\/\//, ""), origin: entry.origin }));
    if (options.newPassword) items.push({ key: "generate", kind: "generate", title: "Use a strong password", subtitle: `${settingsRef.current.generatorLength} random characters, saved for you` });
    if (items.length > 0) items.push({ key: "manage", kind: "manage", title: "Manage passwords" });
    return items;
  };

  const pickLogin = (item: LoginItem) => {
    const menu = loginsMenuRef.current;
    setLoginsMenu(null);
    if (item.kind === "unlock" || item.kind === "manage") { openSettings("passwords"); return; }
    if (!menu) return;
    if (item.kind === "login" && item.id) void vaultFill(menu.label, item.id).catch((error) => showMessage(vaultError(error)));
    if (item.kind === "generate") {
      void vaultFillGenerated(menu.label, settingsRef.current.generatorLength, true).then((offer) => {
        if (offer) setToasts((items) => [...items, { id: `password-${offer.pendingId}`, prompt: { kind: "password", pendingId: offer.pendingId, label: menu.label, origin: offer.origin, username: offer.username, offer: offer.kind }, expiresAt: null }]);
      }).catch((error) => showMessage(vaultError(error)));
    }
  };
  vaultRef.current = vault;
  loginItemsForRef.current = loginItemsFor;
  const loginsMenuRef = useRef(loginsMenu);
  loginsMenuRef.current = loginsMenu;

  /** Address-bar key: the logins dropdown under the address field, for the active tab. */
  const openToolbarLogins = () => {
    if (!activeTab) return;
    const field = document.querySelector<HTMLElement>(".address")?.getBoundingClientRect();
    const zoom = settingsRef.current.appZoom || 1;
    const items = loginItemsFor(pageLogins, { newPassword: false, locked: !vault?.unlocked });
    setLoginsMenu({ label: viewLabel(activeTab.id), anchor: { x: (field?.right ?? 600) * zoom - 300 * zoom, y: ((field?.bottom ?? 44) + 6) * zoom, width: 300 * zoom }, items, from: "toolbar" });
  };

  useEffect(() => {
    if (!isTauri()) return;
    let blurTimer: number | undefined;
    const stops = [
      listenEvent<{ label: string; pendingId: string; origin: string; username: string; kind: "new" | "update" | "locked" }>("sleet-password-offer", ({ payload }) => {
        const current = settingsRef.current;
        if (!current.passwordsOffer || (current.passwordsNever ?? []).includes(payload.origin)) {
          void vaultResolveOffer(payload.pendingId, true).catch(() => undefined);
          return;
        }
        setToasts((items) => [...items.filter((toast) => toast.id !== `password-${payload.pendingId}`), {
          id: `password-${payload.pendingId}`,
          prompt: { kind: "password", pendingId: payload.pendingId, label: payload.label, origin: payload.origin, username: payload.username, offer: payload.kind },
          expiresAt: null,
        }]);
      }),
      listenEvent<{ label: string; origin: string; x: number; y: number; width: number; height: number; newPassword: boolean }>("sleet-login-focus", ({ payload }) => {
        window.clearTimeout(blurTimer);
        void (async () => {
          const status = vaultRef.current;
          if (!status?.exists && !payload.newPassword) return;
          const tab = tabsRef.current.find((item) => viewLabel(item.id) === payload.label);
          if (!tab || tab.id !== activeIdRef.current) return;
          const entries = status?.unlocked ? await vaultMatches(payload.origin).catch(() => []) : [];
          const locked = !!status?.exists && !status.unlocked;
          const items = loginItemsForRef.current(entries, { newPassword: payload.newPassword && !!status?.unlocked, locked });
          if (items.length === 0) { setLoginsMenu(null); return; }
          // Field box (page CSS px) → window logical px: page bounds + zoomed offset.
          const bounds = getBounds();
          const pageZoom = tab.zoom ?? settingsRef.current.zoom;
          if (!bounds) return;
          setLoginsMenu({
            label: payload.label,
            anchor: { x: bounds.x + payload.x * pageZoom, y: bounds.y + (payload.y + payload.height) * pageZoom + 4, width: payload.width * pageZoom },
            items,
            from: "field",
          });
        })();
      }),
      listenEvent<string>("sleet-login-blur", () => {
        window.clearTimeout(blurTimer);
        blurTimer = window.setTimeout(() => setLoginsMenu((menu) => (menu?.from === "field" ? null : menu)), 250);
      }),
    ];
    return () => { window.clearTimeout(blurTimer); stops.forEach((stop) => void stop.then((fn) => fn())); };
  }, []);

  // The toolbar dropdown closes on any click in Sleet's own window, or when the tab changes.
  useEffect(() => {
    if (loginsMenu?.from !== "toolbar") return;
    const close = () => setLoginsMenu(null);
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [loginsMenu?.from]);
  useEffect(() => { setLoginsMenu(null); }, [activeId, surface]);

  // Links Sleet was launched with; default-browser status and a one-time prompt.
  useEffect(() => {
    void takeLaunchUrls().then((urls) => urls.forEach((url) => void newTab(url)));
    void defaultBrowserStatus().then((status) => {
      setDefaultBrowser(status);
      if (status.supported && !status.isDefault && !settingsRef.current.defaultBrowserPromptDismissed) {
        window.setTimeout(() => setToasts((items) => [...items, { id: "default-browser", prompt: { kind: "default-browser" }, expiresAt: null }]), 6000);
      }
    });
  }, []);

  // Re-check when Settings opens (the user may have changed it in Windows).
  useEffect(() => {
    if (surface === "settings") void defaultBrowserStatus().then(setDefaultBrowser);
  }, [surface]);

  // Create the active tab's page once the page slot has a size.
  useEffect(() => {
    if (!isTauri()) return;
    const tab = tabsRef.current.find((item) => item.id === activeId);
    if (!tab) return;
    void (async () => {
      await ensureView(tab.id, tab.url);
      await activateView(isHomeUrl(tab.url) ? null : tab.id, tabsRef.current.map((item) => item.id));
    })();
  }, [ensureView]);

  // Subscribe once; handlers read the latest state through refs.
  const tabIdOf = (label: string) => label.replace(/^page-/, "");
  const pushPrompt = (toast: Toast) => setToasts((items) => [...items.filter((item) => item.id !== toast.id), toast]);

  const handlePopupBlocked = useCallback((event: PopupBlockedEvent) => {
    pushPrompt({ id: `popup-${event.label}`, prompt: { kind: "popup", ...event }, expiresAt: Date.now() + 15_000 });
  }, []);

  const handlePermissionRequest = useCallback((event: PermissionRequestEvent) => {
    pushPrompt({ id: `permission-${event.requestId}`, prompt: { kind: "permission", requestId: event.requestId, origin: event.origin, permission: event.kind, private: event.private }, expiresAt: null });
  }, []);

  const handleCertError = useCallback((event: CertErrorEvent) => {
    const id = tabIdOf(event.label);
    setTabs((items) => items.map((tab) => tab.id === id ? { ...tab, certError: { host: event.host, problem: event.problem } } : tab));
    pushPrompt({ id: `cert-${event.label}`, prompt: { kind: "cert", label: event.label, host: event.host, problem: event.problem }, expiresAt: null });
  }, [setTabs]);

  const handleHttpsFailed = useCallback((event: HttpsFailedEvent) => {
    pushPrompt({ id: `https-${event.label}`, prompt: { kind: "https", ...event }, expiresAt: null });
  }, []);

  /** Answers a prompt toast. */
  const answerPrompt = (toast: Toast, choice: PromptChoice) => {
    setToasts((items) => items.filter((item) => item.id !== toast.id));
    const prompt = toast.prompt;
    if (!prompt) return;
    if (prompt.kind === "permission") {
      const allow = choice.startsWith("allow");
      void resolvePermission(prompt.requestId, allow, !choice.endsWith(":once"));
    }
    if (prompt.kind === "popup") {
      if (choice === "always" && prompt.origin) void store.permissionSet(prompt.origin, "popups", "allow");
      void newTab(prompt.url, { nextToActive: true });
    }
    if (prompt.kind === "https" && choice === "continue") {
      void allowHttp(prompt.host).then(() => navigateView(tabIdOf(prompt.label), prompt.httpUrl));
    }
    if (prompt.kind === "password") {
      if (choice === "save") {
        void vaultResolveOffer(prompt.pendingId, false).then(() => showMessage(prompt.offer === "update" ? "Password updated" : "Password saved")).catch((error) => showMessage(vaultError(error)));
      } else if (choice === "never") {
        updateSettings({ passwordsNever: [...new Set([...(settingsRef.current.passwordsNever ?? []), prompt.origin])] });
        void vaultResolveOffer(prompt.pendingId, true);
      } else if (choice === "unlock") {
        waitingOffers.current.add(prompt.pendingId);
        openSettings("passwords");
      }
      return;
    }
    if (prompt.kind === "default-browser") {
      // Either answer ends the prompt for good; Settings keeps the option.
      updateSettings({ defaultBrowserPromptDismissed: true });
      if (choice === "make-default") void makeDefault();
    }
    if (prompt.kind === "cert" && choice === "continue") void proceedDespiteCertificate(tabIdOf(prompt.label), prompt.host);
    if (prompt.kind === "external" && (choice === "open" || choice === "always")) {
      if (choice === "always" && prompt.origin) {
        updateSettings({ externalAllowed: [...new Set([...(settingsRef.current.externalAllowed ?? []), `${prompt.origin}|${prompt.scheme}`])] });
      }
      void openExternal(prompt.url).catch((error) => showMessage(String(error)));
    }
  };

  /** A page link wants another app (mailto:, tel:, zoommtg: ...): ask first unless always allowed. */
  const handleExternalLink = useCallback((event: ExternalLinkEvent) => {
    const tab = tabsRef.current.find((item) => item.id === tabIdOf(event.label));
    let origin = "";
    try { origin = tab ? new URL(tab.url).origin : ""; } catch { /* no origin */ }
    if (origin === "null") origin = "";
    const scheme = event.url.split(":")[0].toLowerCase();
    if (origin && (settingsRef.current.externalAllowed ?? []).includes(`${origin}|${scheme}`)) {
      void openExternal(event.url).catch((error) => showMessage(String(error)));
      return;
    }
    pushPrompt({ id: `external-${event.label}`, prompt: { kind: "external", label: event.label, url: event.url, origin, scheme }, expiresAt: null });
  }, [showMessage]);

  /** The page's process died or hung: drop its view and show the crash screen. */
  const handleCrash = useCallback((event: CrashEvent) => {
    const id = tabIdOf(event.label);
    if (!tabsRef.current.some((tab) => tab.id === id)) return;
    createdViews.current.delete(id);
    void closeView(id);
    setSleeping((current) => new Set([...current, id]));
    setLoadingTabs((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setAudio((current) => { const next = { ...current }; delete next[id]; return next; });
    setCrashed((current) => ({ ...current, [id]: event.kind }));
    if (id === activeIdRef.current) setPageFullscreen(false);
  }, []);

  const handleFullscreen = useCallback((event: FullscreenEvent) => {
    if (tabIdOf(event.label) === activeIdRef.current) setPageFullscreen(event.fullscreen);
  }, []);

  const makeDefault = async () => {
    try { await makeDefaultBrowser(); } catch (error) { showMessage(String(error)); }
  };

  /** Opens a site despite its certificate error (this session only) and reloads it. */
  const proceedDespiteCertificate = async (tabId: string, host: string) => {
    await allowCertificate(host);
    setToasts((items) => items.filter((item) => item.id !== `cert-page-${tabId}`));
    if (createdViews.current.has(tabId)) await browserAction(tabId, "reload");
  };

  const handleContext = useCallback((event: ContextEvent) => {
    if (event.action === "open-tab") void newTab(event.url, { nextToActive: true });
    if (event.action === "open-background-tab") void newTab(event.url, { background: true, nextToActive: true });
    if (event.action === "open-image-tab") void newTab(event.url, { nextToActive: true });
    if (event.action === "search-image") void newTab(imageSearchUrl(settingsRef.current.searchEngine, event.url), { nextToActive: true });
  }, [newTab]);

  const handlersRef = useRef({ handleExternalLink, handleCrash, handleFullscreen, addHistory, handleCertError, handleContext, handleDownload, handleDownloadCheck, handleDownloadProgress, handleDownloadState, handleHttpsFailed, handlePermissionRequest, handlePopupBlocked, newTab, recordUrl, setTabs });
  handlersRef.current = { handleExternalLink, handleCrash, handleFullscreen, addHistory, handleCertError, handleContext, handleDownload, handleDownloadCheck, handleDownloadProgress, handleDownloadState, handleHttpsFailed, handlePermissionRequest, handlePopupBlocked, newTab, recordUrl, setTabs };
  useEffect(() => {
    let disposed = false;
    let dispose: () => void = () => undefined;
    void subscribeToBrowserEvents({
      onNavigation: ({ label, url }) => {
        const id = label.replace(/^page-/, "");
        handlersRef.current.recordUrl(id, url);
        const tab = tabsRef.current.find((item) => item.id === id);
        if (!tab?.private) handlersRef.current.addHistory(url, tab?.title ?? pageTitle(url));
      },
      onUrl: ({ label, url }) => handlersRef.current.recordUrl(label.replace(/^page-/, ""), url),
      onTitle: ({ label, title }) => {
        const id = label.replace(/^page-/, "");
        handlersRef.current.setTabs((items) => items.map((tab) => tab.id === id ? { ...tab, title: title || pageTitle(tab.url) } : tab));
      },
      onDownload: (event) => handlersRef.current.handleDownload(event),
      onDownloadProgress: (event) => handlersRef.current.handleDownloadProgress(event),
      onDownloadState: (event) => handlersRef.current.handleDownloadState(event),
      onDownloadCheck: (event) => handlersRef.current.handleDownloadCheck(event),
      onNewTab: (url) => void handlersRef.current.newTab(url, { nextToActive: true }),
      onAudio: ({ label, playing, muted }) => {
        const id = label.replace(/^page-/, "");
        setAudio((current) => ({ ...current, [id]: { playing, muted } }));
      },
      onContext: (event) => handlersRef.current.handleContext(event),
      onFavicon: ({ label, icon }) => {
        const id = label.replace(/^page-/, "");
        const tab = tabsRef.current.find((item) => item.id === id);
        handlersRef.current.setTabs((items) => items.map((item) => item.id === id ? { ...item, favicon: icon ?? undefined } : item));
        if (icon && tab && !tab.private) rememberFavicon(tab.url, icon);
      },
      onOpenUrls: (urls) => urls.forEach((url) => void handlersRef.current.newTab(url)),
      onPopupBlocked: (event) => handlersRef.current.handlePopupBlocked(event),
      onPermissionRequest: (event) => handlersRef.current.handlePermissionRequest(event),
      onCertError: (event) => handlersRef.current.handleCertError(event),
      onHttpsFailed: (event) => handlersRef.current.handleHttpsFailed(event),
      onCommand: (command) => runShortcutRef.current(command),
      onLoading: ({ label, loading }) => {
        const id = label.replace(/^page-/, "");
        setLoadingTabs((current) => {
          if (current.has(id) === loading) return current;
          const next = new Set(current);
          if (loading) next.add(id); else next.delete(id);
          return next;
        });
      },
      onOpenLink: ({ url, background }) => void handlersRef.current.newTab(url, { background, nextToActive: true }),
      onFullscreen: (event) => handlersRef.current.handleFullscreen(event),
      onExternalLink: (event) => handlersRef.current.handleExternalLink(event),
      onCrashed: (event) => handlersRef.current.handleCrash(event),
    }).then((unlisten) => {
      if (disposed) unlisten();
      else dispose = unlisten;
    });
    return () => { disposed = true; dispose(); };
  }, []);

  // Show the active page only on the browser surface. Focus moves to the page
  // when it becomes visible, unless a command just moved focus elsewhere.
  const lastShown = useRef<string | null>(null);
  useEffect(() => {
    const visibleId = surface === "browser" && !activeIsHome && !activeAsleep ? activeId : null;
    const changed = lastShown.current !== visibleId;
    lastShown.current = visibleId;
    const focusPage = changed && !!visibleId && !suppressPageFocus.current;
    suppressPageFocus.current = false;
    void (async () => {
      await activateView(visibleId, tabKey ? tabKey.split(",") : [], focusPage);
      if (!visibleId && changed) await focusChrome();
    })();
  }, [activeAsleep, activeId, activeIsHome, surface, tabKey]);

  // ---- Overlays: palette and toasts drawn above the page webview.
  const overlayTheme = settings.theme === "light" || (settings.theme === "system" && systemLight) ? "light" : "dark";
  const overlayVars = appearanceVars(settings);
  const overlayVarsKey = JSON.stringify(overlayVars);
  const overlayStateRef = useRef<Record<OverlayKind, unknown>>({ toasts: null, suggest: null, siteinfo: null, tooltip: null, logins: null });
  overlayStateRef.current = {
    toasts: { kind: "toasts", theme: overlayTheme, vars: overlayVars, toasts, downloads: downloads.filter((item) => toasts.some((toast) => toast.downloadId === item.id)) },
    logins: { kind: "logins", theme: overlayTheme, vars: overlayVars, items: loginsMenu?.items ?? [] },
    tooltip: { kind: "tooltip", theme: overlayTheme, vars: overlayVars, text: tooltip?.text ?? "", seq: tooltip?.seq ?? 0 },
    suggest: { kind: "suggest", theme: overlayTheme, vars: overlayVars, items: suggestions, selected: selectedSuggestion },
    siteinfo: { kind: "siteinfo", theme: overlayTheme, vars: overlayVars, open: siteInfoOpen, session: siteInfoSession, info: siteInfo },
  };

  /** Overlay rectangle in window logical pixels for its reported content size. */
  const overlayBounds = (kind: OverlayKind): ViewBounds => {
    const zoom = settingsRef.current.appZoom || 1;
    const size = overlaySizes[kind];
    if (kind === "tooltip") {
      const width = Math.min(size?.width ?? 200, 340);
      const height = size?.height ?? 28;
      const { left, top } = tooltipPosition(tooltip ?? { x: 0, y: 0 }, width, height);
      return { x: Math.round(left * zoom), y: Math.round(top * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) };
    }
    if (kind === "logins") {
      // Anchor is already in window logical pixels.
      const anchor = loginsMenu?.anchor ?? { x: 0, y: 0, width: 280 };
      const width = Math.max(anchor.width, 280 * zoom);
      const height = (size?.height ?? 120) * zoom;
      const x = Math.min(anchor.x, window.innerWidth * zoom - width - 8);
      const y = anchor.y + height > window.innerHeight * zoom - 8 ? Math.max(8, anchor.y - height - 40 * zoom) : anchor.y;
      return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    }
    if (kind === "siteinfo") {
      const field = document.querySelector<HTMLElement>(".address")?.getBoundingClientRect();
      const x = (field?.left ?? sidebarWidth + 120) - 2;
      const y = (field?.bottom ?? 44) + 6;
      const height = Math.min(size?.height ?? 420, window.innerHeight - y - 16);
      return { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(340 * zoom), height: Math.round(height * zoom) };
    }
    if (kind === "suggest") {
      const field = document.querySelector<HTMLElement>(".address")?.getBoundingClientRect();
      const x = field?.left ?? sidebarWidth + 120;
      const y = (field?.bottom ?? 44) + 4;
      const width = field?.width ?? 600;
      const height = Math.min(size?.height ?? 300, window.innerHeight - y - 16);
      return { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) };
    }
    const width = Math.round(300 * Math.min(1.6, settings.textSize * (settings.textAreas.toasts ?? 1)));
    const height = size?.height ?? 64;
    const position = settings.toastPosition;
    const x = position.endsWith("right") ? window.innerWidth - width - 12 : sidebarWidth + 10;
    const y = position.startsWith("bottom") ? window.innerHeight - height - 12 : 52 + 10;
    return { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) };
  };

  // Tooltip overlay: hidden while the new text is drawn, then shown at its
  // measured size once the overlay confirms it rendered this tooltip.
  const tooltipRef = useRef(tooltip);
  tooltipRef.current = tooltip;
  useEffect(() => {
    if (!isTauri()) return;
    void overlayHide(overlayLabel("tooltip"));
    if (tooltip) void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.tooltip);
  }, [tooltip?.seq]);

  const showRenderedTooltip = (rendered: OverlayRendered) => {
    const current = tooltipRef.current;
    if (!current || rendered.seq !== current.seq) return;
    const zoom = settingsRef.current.appZoom || 1;
    const width = Math.min(rendered.width, 340);
    const { left, top } = tooltipPosition(current, width, rendered.height);
    void overlayShow(overlayLabel("tooltip"), "tooltip", {
      x: Math.round(left * zoom), y: Math.round(top * zoom), width: Math.round(width * zoom), height: Math.round(rendered.height * zoom),
    }, false, zoom);
  };
  const showRenderedTooltipRef = useRef(showRenderedTooltip);
  showRenderedTooltipRef.current = showRenderedTooltip;

  const toastsVisible = toasts.length > 0;
  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.toasts);
    if (toastsVisible) void overlayShow(overlayLabel("toasts"), "toasts", overlayBounds("toasts"), false, settings.appZoom);
    else void overlayHide(overlayLabel("toasts"));
  }, [toastsVisible]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.toasts);
    if (toastsVisible) void overlayPlace(overlayLabel("toasts"), overlayBounds("toasts"));
  }, [toasts, downloads, overlayTheme, overlayVarsKey, settings.toastPosition, overlaySizes.toasts?.height, settings.appZoom, sidebarWidth]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.siteinfo);
    if (siteInfoOpen) void overlayShow(overlayLabel("siteinfo"), "siteinfo", overlayBounds("siteinfo"), true, settings.appZoom);
    else void overlayHide(overlayLabel("siteinfo"));
  }, [siteInfoOpen, siteInfoSession]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.siteinfo);
    if (siteInfoOpen) void overlayPlace(overlayLabel("siteinfo"), overlayBounds("siteinfo"));
  }, [sitePermissions, activeTab?.certError, overlayTheme, overlayVarsKey, overlaySizes.siteinfo?.height, settings.appZoom, sidebarWidth]);

  const loginsVisible = !!loginsMenu && loginsMenu.items.length > 0;
  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.logins);
    if (loginsVisible) void overlayShow(overlayLabel("logins"), "logins", overlayBounds("logins"), false, settings.appZoom);
    else void overlayHide(overlayLabel("logins"));
  }, [loginsVisible]);
  useEffect(() => {
    if (!isTauri() || !loginsVisible) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.logins);
    void overlayPlace(overlayLabel("logins"), overlayBounds("logins"));
  }, [loginsMenu, overlayTheme, overlayVarsKey, overlaySizes.logins?.height]);

  const suggestVisible = suggestions.length > 0;
  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.suggest);
    if (suggestVisible) void overlayShow(overlayLabel("suggest"), "suggest", overlayBounds("suggest"), false, settings.appZoom);
    else void overlayHide(overlayLabel("suggest"));
  }, [suggestVisible]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.suggest);
    if (suggestVisible) void overlayPlace(overlayLabel("suggest"), overlayBounds("suggest"));
  }, [suggestions, selectedSuggestion, overlayTheme, overlayVarsKey, overlaySizes.suggest?.height, settings.appZoom, sidebarWidth]);

  // Overlay messages: ready (resend state), size, and user actions.
  const overlayActionRef = useRef<(action: OverlayAction) => void>(() => undefined);
  const pickSuggestionRef = useRef<(item: Suggestion) => void>(() => undefined);
  const dismissToastRef = useRef<(id: string) => void>(() => undefined);
  const pickLoginRef = useRef<(item: LoginItem) => void>(() => undefined);
  const siteInfoActionRef = useRef<(action: Extract<OverlayAction, { kind: "siteinfo" }>) => void>(() => undefined);
  overlayActionRef.current = (action) => {
    if (action.kind === "suggest" && action.type === "pick") pickSuggestionRef.current(action.item);
    if (action.kind === "siteinfo") siteInfoActionRef.current(action);
    if (action.kind === "suggest" && action.type === "hover") setSelectedSuggestion(action.index);
    if (action.kind === "toasts" && action.type === "dismiss") dismissToastRef.current(action.id);
    if (action.kind === "logins" && action.type === "pick") pickLoginRef.current(action.item);
    if (action.kind === "toasts" && action.type === "cancel-download") {
      const download = downloadsRef.current.find((item) => item.id === action.id);
      if (download) cancelDownload(download);
    }
    if (action.kind === "toasts" && action.type === "resolve-check") resolveCheck(action.check, action.keep);
    if (action.kind === "toasts" && action.type === "prompt") answerPrompt(action.toast, action.choice);
    if (action.kind === "toasts" && action.type === "hover") holdToast(action.id, action.hovering);
    if (action.kind === "toasts" && action.type === "open-download") {
      const download = downloadsRef.current.find((item) => item.id === action.id);
      if (download) openDownload(download);
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    const stops: Promise<() => void>[] = [
      listenEvent<{ kind: OverlayKind }>(OVERLAY_EVENTS.ready, ({ payload }) => {
        overlayReady.current.add(payload.kind);
        void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current[payload.kind]);
      }),
      listenEvent<OverlaySize>(OVERLAY_EVENTS.size, ({ payload }) => {
        setOverlaySizes((current) => current[payload.kind]?.height === payload.height && current[payload.kind]?.width === payload.width ? current : { ...current, [payload.kind]: { width: payload.width, height: payload.height } });
      }),
      listenEvent<OverlayAction>(OVERLAY_EVENTS.action, ({ payload }) => overlayActionRef.current(payload)),
      listenEvent<OverlayRendered>(OVERLAY_EVENTS.rendered, ({ payload }) => { if (payload.kind === "tooltip") showRenderedTooltipRef.current(payload); }),
    ];
    // Warm both overlays off-screen so the first palette/toast appears instantly.
    const offscreen = { x: -4000, y: -4000, width: 10, height: 10 };
    void (async () => {
      for (const kind of ["toasts", "suggest", "siteinfo", "tooltip", "logins"] as OverlayKind[]) {
        await overlayShow(overlayLabel(kind), kind, offscreen, false, settingsRef.current.appZoom);
        await overlayHide(overlayLabel(kind));
      }
    })();
    return () => { stops.forEach((stop) => void stop.then((fn) => fn())); };
  }, []);

  // Track when each tab was last in front.
  useEffect(() => {
    const now = Date.now();
    lastActiveAt.current.set(activeId, now);
    return () => { lastActiveAt.current.set(activeId, Date.now()); };
  }, [activeId]);

  // Unload pages of tabs left in the background, keeping their entries.
  useEffect(() => {
    if (!isTauri() || settings.inactiveMinutes <= 0) return;
    const limit = settings.inactiveMinutes * 60_000;
    const timer = window.setInterval(() => {
      const now = Date.now();
      const busy = new Set(downloadsRef.current.filter((item) => item.status === "active").map((item) => item.id.split(":")[0]));
      const toSleep = tabsRef.current.filter((tab) =>
        tab.id !== activeId
        && createdViews.current.has(tab.id)
        && !busy.has(viewLabel(tab.id))
        && !audioRef.current[tab.id]?.playing
        && !tab.private
        && now - (lastActiveAt.current.get(tab.id) ?? now) > limit);
      if (toSleep.length === 0) return;
      toSleep.forEach((tab) => {
        createdViews.current.delete(tab.id);
        void closeView(tab.id);
      });
      setSleeping((current) => new Set([...current, ...toSleep.map((tab) => tab.id)]));
      setAudio((current) => { const next = { ...current }; toSleep.forEach((tab) => delete next[tab.id]); return next; });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [activeId, settings.inactiveMinutes]);

  // Keep the active page sized to its slot.
  useEffect(() => {
    const slot = pageRef.current;
    if (!slot || !activeTab) return;
    const resizeActiveView = () => {
      const bounds = getBounds();
      if (bounds) void resizeView(activeTab.id, bounds);
    };
    resizeActiveView();
    const observer = new ResizeObserver(resizeActiveView);
    observer.observe(slot);
    window.addEventListener("resize", resizeActiveView);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeActiveView);
    };
  }, [activeTab?.id, activeAsleep, getBounds, settings.appZoom]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (/^[0-9]$/.test(event.key)) { event.preventDefault(); runShortcut(`tab-digit-${event.key}`); return; }
        const inField = (event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]");
        if (!inField && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          runShortcut(event.key === "ArrowLeft" ? "back" : "forward");
          return;
        }
      }
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (plain) {
        const fkey = ({ F5: "reload", F11: "fullscreen", F3: event.shiftKey ? "find-previous" : "find-next" } as Record<string, string>)[event.key];
        if (fkey) { event.preventDefault(); runShortcut(fkey); return; }
        const inField = (event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]");
        if (event.key === "Escape" && !inField && loadingRef.current.has(activeIdRef.current)) { runShortcut("stop"); return; }
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const command = !event.shiftKey && /^[1-9]$/.test(event.key)
        ? `tab-index-${event.key}`
        : event.shiftKey && SHIFTED_SHORTCUTS[key] ? SHIFTED_SHORTCUTS[key] : SHORTCUTS[key];
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      runShortcut(command);
    };
    // Ctrl+scroll over the chrome must never zoom Sleet itself.
    const onWheel = (event: WheelEvent) => { if (event.ctrlKey) event.preventDefault(); };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Alt" && altDigits.current.value) { event.preventDefault(); runShortcut("tab-commit"); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("wheel", onWheel);
    };
  }, [runShortcut]);

  // Hide finished toasts after their time is up.
  useEffect(() => {
    if (!toasts.some((toast) => toast.expiresAt !== null)) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setToasts((items) => {
        const next = items
          .filter((toast) => toast.expiresAt === null || toast.expiresAt > now)
          .map((toast) => {
            const leaving = toast.expiresAt !== null && toast.expiresAt - now < 600;
            return leaving === !!toast.leaving ? toast : { ...toast, leaving };
          });
        return next.length === items.length && next.every((toast, index) => toast === items[index]) ? items : next;
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [toasts]);

  // Appearance settings live on the root element so CSS can react to them.
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media) return;
    const update = () => setSystemLight(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme === "light" || (settings.theme === "system" && systemLight) ? "light" : "dark";
    root.dataset.density = settings.density;
    root.dataset.motion = settings.reducedMotion ? "reduced" : "full";
    applyVars(appearanceVars(settings));
  }, [settings.density, settings.reducedMotion, settings.theme, settings.textSize, settings.textAreas, systemLight]);

  useEffect(() => { void setChromeZoom(settings.appZoom); }, [settings.appZoom]);

  useEffect(() => {
    void setPrivacyOptions({ httpsOnly: settings.httpsOnly, blockPopups: settings.blockPopups, trackingPrevention: settings.trackingPrevention });
  }, [settings.blockPopups, settings.httpsOnly, settings.trackingPrevention]);

  // "Clear when Sleet closes": runs before the window goes away.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async () => {
      const { clearHistoryOnExit, clearSiteDataOnExit } = settingsRef.current;
      const work: Promise<unknown>[] = [kvFlush()];
      if (clearHistoryOnExit) work.push(store.historyClear());
      if (clearSiteDataOnExit) work.push(clearSiteData(["cookies", "cache", "storage"]));
      await Promise.race([Promise.allSettled(work), new Promise((resolve) => window.setTimeout(resolve, 4000))]);
    }).then((unlisten) => { stop = unlisten; });
    return () => stop?.();
  }, []);

  // New default zoom applies to every tab without its own zoom.
  useEffect(() => {
    const ids = tabsRef.current.filter((tab) => tab.zoom === undefined).map((tab) => tab.id);
    void setViewsZoom(ids, settings.zoom);
  }, [settings.zoom]);

  useEffect(() => {
    setDownloadDir(settings.downloadDir)
      .then(() => setDownloadDirError(null))
      .catch((error) => setDownloadDirError(String(error)));
  }, [settings.downloadDir]);

  const firstRetention = useRef(true);
  useEffect(() => {
    if (firstRetention.current) { firstRetention.current = false; return; }
    void (async () => {
      if (settings.historyRetention === "disabled") await store.historyClear();
      if (settings.historyRetention === "30-days") await store.historyClear(Date.now() - THIRTY_DAYS);
      await refreshHistory();
    })();
  }, [refreshHistory, settings.historyRetention]);

  const clearHistory = async () => {
    await store.historyClear();
    await refreshHistory();
  };

  const clearDownloads = async (since?: number) => {
    await store.downloadsClear(false, since);
    setDownloads((items) => items.filter((item) => item.status === "active" || (since !== undefined && item.startedAt < since)));
  };

  const clearData = async (options: ClearDataOptions) => {
    // Site data first: clearing storage restores Sleet's saved state from a snapshot.
    const kinds = (["cookies", "cache", "storage", "autofill"] as SiteDataKind[]).filter((kind) => options[kind]);
    await clearSiteData(kinds, options.since);
    if (options.history) {
      await store.historyClear(undefined, options.since);
      await refreshHistory();
    }
    if (options.downloads) await clearDownloads(options.since);
  };

  const resetHorizon = async () => {
    await Promise.all(tabsRef.current.map((tab) => closeView(tab.id)));
    await Promise.all([store.historyClear(), store.downloadsClear(false)]).catch(() => undefined);
    await kvClearAll();
    window.location.reload();
  };

  const openUrl = (url: string) => { void newTab(url); };

  // ---- Bookmarks (grid at the top of the sidebar)
  const activeBookmark = activeTab && !isHomeUrl(activeTab.url) && !activeTab.private ? findByUrl(bookmarks, activeTab.url) : undefined;

  /** Adds or removes a bookmark for a tab (Ctrl+D / the star). */
  const toggleTabBookmark = (tab: BrowserTab | undefined) => {
    if (!tab || isHomeUrl(tab.url)) return;
    const existing = findByUrl(bookmarks, tab.url);
    if (existing) {
      setBookmarks((tree) => removeBookmark(tree, existing.id));
      return;
    }
    const next = addBookmark(bookmarks, { title: tab.title || pageTitle(tab.url), url: tab.url });
    const created = next[next.length - 1];
    setBookmarks(next);
    setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, bookmarkId: created.id } : item));
  };
  const toggleBookmarkRef = useRef(() => undefined as void);
  toggleBookmarkRef.current = () => toggleTabBookmark(tabsRef.current.find((tab) => tab.id === activeIdRef.current));

  /** Arc-style: a bookmark jumps to its tab when open, else opens one tied to it. */
  const openBookmark = (bookmark: Bookmark, inNewTab: boolean) => {
    if (!bookmark.url) return;
    const linked = !inNewTab && tabs.find((tab) => tab.bookmarkId === bookmark.id && !tab.private);
    if (linked) { setSidebarMode("tabs"); selectTab(linked.id); return; }
    void newTab(bookmark.url, inNewTab ? { nextToActive: true } : { bookmarkId: bookmark.id });
  };

  const bookmarkState = (bookmark: Bookmark): BookmarkState => {
    const linked = tabs.filter((tab) => tab.bookmarkId === bookmark.id);
    if (linked.some((tab) => tab.id === activeId) && surface === "browser") return "active";
    return linked.length > 0 ? "open" : null;
  };

  const toggleFolder = (folderId: string) =>
    setExpandedFolders((open) => (open.includes(folderId) ? open.filter((id) => id !== folderId) : [...open, folderId]));

  const bookmarkMenu = (bookmark: Bookmark): MenuEntry[] => bookmark.kind === "folder"
    ? [
      { label: expandedFolders.includes(bookmark.id) ? "Collapse" : "Expand", key: "x", onSelect: () => toggleFolder(bookmark.id) },
      { label: "Open all in new tabs", key: "o", onSelect: () => (bookmark.children ?? []).forEach((child) => child.url && void newTab(child.url, { background: true })) },
      "separator",
      { label: "Edit label and color", key: "e", onSelect: () => setEditingBookmark(bookmark) },
      { label: "Ungroup", key: "u", onSelect: () => setBookmarks((tree) => ungroupFolder(tree, bookmark.id)) },
      "separator",
      { label: "Delete folder and its bookmarks", key: "d", danger: true, onSelect: () => setBookmarks((tree) => removeBookmark(tree, bookmark.id)) },
    ]
    : [
      { label: "Open", key: "o", onSelect: () => openBookmark(bookmark, false) },
      { label: "Open in new tab", key: "t", onSelect: () => openBookmark(bookmark, true) },
      { label: "Open in private tab", key: "p", onSelect: () => bookmark.url && void newTab(bookmark.url, { private: true }) },
      "separator",
      { label: "Copy link", key: "c", onSelect: () => bookmark.url && copyText(bookmark.url) },
      { label: "Edit", key: "e", onSelect: () => setEditingBookmark(bookmark) },
      "separator",
      { label: "Remove bookmark", key: "r", danger: true, onSelect: () => setBookmarks((tree) => removeBookmark(tree, bookmark.id)) },
    ];

  const loadSitePermissions = async (origin: string) => {
    const rows = origin ? await store.permissionsList(origin) : [];
    setSitePermissions(Object.fromEntries(rows.map((row) => [row.kind, row.state])));
  };

  const openSiteInfo = () => {
    void loadSitePermissions(siteOrigin);
    setSiteInfoSession((session) => session + 1);
    setSiteInfoOpen(true);
  };

  const closeSiteInfo = (refocusPage: boolean) => {
    setSiteInfoOpen(false);
    if (refocusPage && activeTab && createdViews.current.has(activeTab.id) && !activeIsHome) {
      void activateView(activeTab.id, tabsRef.current.map((item) => item.id), true);
    }
  };

  const setSitePermission = async (permission: string, choice: PermissionChoice) => {
    if (!siteOrigin) return;
    if (choice === "ask") await store.permissionDelete(siteOrigin, permission);
    else await store.permissionSet(siteOrigin, permission, choice);
    await loadSitePermissions(siteOrigin);
  };

  const clearCurrentSite = async () => {
    if (!activeTab || !siteOrigin) return;
    await clearOriginData(activeTab.id, siteOrigin);
    if (createdViews.current.has(activeTab.id)) await browserAction(activeTab.id, "reload");
  };

  siteInfoActionRef.current = (action) => {
    if (action.type === "close") closeSiteInfo(action.refocusPage);
    if (action.type === "set-permission") void setSitePermission(action.permission, action.choice);
    if (action.type === "clear-site") void clearCurrentSite();
    if (action.type === "allow-certificate" && activeTab?.certError) { closeSiteInfo(false); void proceedDespiteCertificate(activeTab.id, activeTab.certError.host); }
    if (action.type === "open-settings") { closeSiteInfo(false); openSettings("privacy"); }
  };

  const commandRows = (text: string, limit?: number): Suggestion[] => matchCommands(text, limit).map((entry) => ({
    kind: "command",
    title: entry.title,
    subtitle: entry.detail,
    url: entry.id,
    commandId: entry.id,
    shortcut: entry.shortcut,
  }));

  const onAddressInput = (text: string | null) => {
    setSelectedSuggestion(-1);
    if (text === null) setCommandMode(false);
    if (text !== null && commandMode && !text.trim()) { setSuggestions(commandRows("")); return; }
    setSuggestions(text === null ? [] : buildSuggestions(text, history, SEARCH_ENGINES[settings.searchEngine]?.name ?? "the web")
      .map((item) => item.kind === "domain" || item.kind === "history" ? { ...item, icon: faviconFor(item.url) } : item)
      .reduce<Suggestion[]>((rows, item, index, all) => {
        // Matching commands go after a site the text autocompletes to, else first.
        const commands = commandRows(text, commandMode ? 6 : 3);
        if (index === 0) return all[0]?.autocomplete ? [item, ...commands] : [...commands, item];
        return [...rows, item];
      }, []));
  };

  /** Opens a suggestion; search rows always search, even for text that looks like an address. */
  const pickItem = (item: Suggestion | undefined) => {
    if (!item) return;
    if (item.kind === "command") {
      const entry = matchCommands("").find((command) => command.id === item.commandId);
      setSuggestions([]);
      setCommandMode(false);
      (document.activeElement as HTMLElement | null)?.blur();
      if (entry) runPaletteCommand(entry.command);
      return;
    }
    const target = item.kind === "search"
      ? `${SEARCH_ENGINES[settings.searchEngine]?.url ?? SEARCH_ENGINES.duckduckgo.url}${encodeURIComponent(item.url)}`
      : item.url;
    setSuggestions([]);
    setSelectedSuggestion(-1);
    (document.activeElement as HTMLElement | null)?.blur();
    void navigate(target);
  };
  const pickSuggestion = (index: number) => pickItem(suggestions[index]);
  pickSuggestionRef.current = pickItem;
  dismissToastRef.current = dismissToast;
  pickLoginRef.current = (item) => pickLogin(item);
  const showMenu = (x: number, y: number, items: MenuEntry[], inSidebar = false) => setMenu({ x, y, items, maxX: inSidebar ? sidebarWidth : undefined });

  const tabMenu = (tab: BrowserTab, index: number): MenuEntry[] => {
    const sound = audio[tab.id];
    const isHome = isHomeUrl(tab.url);
    return [
      { label: "New tab below", key: "n", onSelect: () => void newTab(undefined, { nextToActive: tab.id === activeId }) },
      { label: "New private tab", key: "p", onSelect: () => void newTab(undefined, { private: true, focusAddress: true }) },
      { label: "Reopen closed tab", key: "z", onSelect: () => void reopenClosedTab(), disabled: closedTabs.current.length === 0 },
      "separator",
      { label: "Reload", key: "r", onSelect: () => reloadTab(tab.id), disabled: isHome },
      { label: "Duplicate", key: "d", onSelect: () => void newTab(tab.url, { nextToActive: tab.id === activeId }), disabled: isHome },
      { label: sound?.muted ? "Unmute tab" : "Mute tab", key: "m", onSelect: () => toggleMute(tab.id), disabled: !createdViews.current.has(tab.id) },
      { label: "Copy link", key: "c", onSelect: () => copyText(tab.url), disabled: isHome },
      { label: findByUrl(bookmarks, tab.url) ? "Remove bookmark" : "Bookmark tab", key: "s", onSelect: () => toggleTabBookmark(tab), disabled: isHome || tab.private },
      { label: "Unload tab", key: "u", onSelect: () => unloadTab(tab.id), disabled: tab.id === activeId || !createdViews.current.has(tab.id) },
      "separator",
      { label: "Move up", key: "k", onSelect: () => reorderTab(tab.id, index - 1), disabled: index === 0 },
      { label: "Move down", key: "j", onSelect: () => reorderTab(tab.id, index + 2), disabled: index === tabs.length - 1 },
      "separator",
      { label: "Close", key: "w", onSelect: () => void closeTab(tab.id) },
      { label: "Close other tabs", key: "o", onSelect: () => void closeTabs(tabs.filter((item) => item.id !== tab.id).map((item) => item.id)), disabled: tabs.length < 2 },
      { label: "Close tabs above", key: "a", onSelect: () => void closeTabs(tabs.slice(0, index).map((item) => item.id)), disabled: index === 0 },
      { label: "Close tabs below", key: "b", onSelect: () => void closeTabs(tabs.slice(index + 1).map((item) => item.id)), disabled: index === tabs.length - 1 },
    ];
  };

  const historyMenu = (entry: HistoryEntry): MenuEntry[] => [
    { label: "Open", key: "o", onSelect: () => void navigate(entry.url) },
    { label: "Open in new tab", key: "t", onSelect: () => void newTab(entry.url, { nextToActive: true }) },
    { label: "Open in background tab", key: "b", onSelect: () => void newTab(entry.url, { background: true, nextToActive: true }) },
    "separator",
    { label: "Copy link", key: "c", onSelect: () => copyText(entry.url) },
    "separator",
    { label: "Delete from history", key: "d", danger: true, onSelect: () => {
      void store.historyDelete(entry.id).then(() => {
        setHistory((items) => items.filter((item) => item.id !== entry.id));
        setHistoryVersion((version) => version + 1);
      }).catch((error) => showMessage(String(error)));
    } },
  ];

  const downloadMenu = (download: DownloadItem): MenuEntry[] => [
    { label: "Open file", key: "o", onSelect: () => openDownload(download), disabled: download.status !== "complete" },
    { label: "Cancel download", key: "x", onSelect: () => cancelDownload(download), disabled: download.status !== "active" },
    { label: "Show in folder", key: "f", onSelect: () => revealDownload(download), disabled: download.status !== "complete" },
    "separator",
    { label: "Copy download link", key: "c", onSelect: () => copyText(download.url) },
    { label: "Download again", key: "a", onSelect: () => {
      const target = activeTab && createdViews.current.has(activeTab.id) ? activeTab.id : null;
      if (target) void navigateView(target, download.url);
      else void newTab(download.url, { nextToActive: true });
    } },
    "separator",
    { label: "Remove from list", key: "r", danger: true, disabled: download.status === "active", onSelect: () => {
      void store.downloadDelete(download.id).then(() => setDownloads((items) => items.filter((item) => item.id !== download.id)))
        .catch((error) => showMessage(String(error)));
    } },
  ];
  // ---- Find in page, print, full screen, loading, crashes
  const activeHasPage = () => {
    const id = activeIdRef.current;
    return createdViews.current.has(id) && surfaceRef.current === "browser" ? id : null;
  };

  const runFind = async (query: string, backwards: boolean, restart: boolean) => {
    const id = activeHasPage();
    const seq = ++findSeq.current;
    let result = NO_MATCHES;
    if (id) findTab.current = id;
    if (id && query) result = await findInPage(id, query, backwards, restart);
    else if (id) await findClear(id);
    if (seq === findSeq.current) setFind((current) => ({ ...current, result }));
  };

  async function openFind() {
    setSurface("browser");
    await focusChrome();
    setFind((current) => ({ ...current, open: true, focus: current.focus + 1 }));
    if (findRef.current.query) void runFind(findRef.current.query, false, true);
  }

  const closeFind = (refocusPage = true) => {
    findSeq.current++;
    setFind((current) => ({ ...current, open: false, result: NO_MATCHES }));
    // Clear highlights in the page that was searched, even after switching tabs.
    if (findTab.current && createdViews.current.has(findTab.current)) void findClear(findTab.current);
    findTab.current = null;
    const id = activeHasPage();
    if (id && refocusPage) void activateView(id, tabsRef.current.map((tab) => tab.id), true);
  };

  const stepFind = (backwards: boolean) => {
    const current = findRef.current;
    if (!current.open || !current.query) { void openFind(); return; }
    void runFind(current.query, backwards, false);
  };

  async function printActive() {
    const id = activeHasPage();
    if (!id) { showMessage("Open a page to print it"); return; }
    try { await printPage(id); } catch (error) { showMessage(String(error)); }
  }

  async function savePdfActive() {
    const id = activeHasPage();
    const tab = tabsRef.current.find((item) => item.id === id);
    if (!id || !tab) { showMessage("Open a page to save it as a PDF"); return; }
    try {
      const path = await savePagePdf(id, tab.title);
      showMessage(`Saved ${path.split(/[\\/]/).at(-1)} to Downloads`);
    } catch (error) {
      if (String(error) !== "print-dialog") showMessage(`Couldn't save the PDF: ${String(error)}`);
    }
  }

  const stopTab = (id: string) => {
    setLoadingTabs((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    if (createdViews.current.has(id)) void stopLoading(id);
  };

  moreShortcutsRef.current = (command: string) => {
    const index = /^tab-index-([1-9])$/.exec(command);
    if (index) {
      const items = tabsRef.current;
      const number = Number(index[1]);
      const tab = number === 9 ? items.at(-1) : items[number - 1];
      if (tab) { setSidebarMode("tabs"); selectTab(tab.id); }
      return true;
    }
    if (command === "next-tab" || command === "previous-tab") {
      const items = tabsRef.current;
      const at = items.findIndex((tab) => tab.id === activeIdRef.current);
      const next = items[(at + (command === "next-tab" ? 1 : -1) + items.length) % items.length];
      if (next) { setSidebarMode("tabs"); selectTab(next.id); }
      return true;
    }
    if (command === "reload") { reloadTab(activeIdRef.current); return true; }
    if (command === "stop") { stopTab(activeIdRef.current); return true; }
    if (command === "fullscreen") { if (pageFullscreen) setPageFullscreen(false); else setWindowFullscreen((on) => !on); return true; }
    if (command === "find") { void openFind(); return true; }
    if (command === "find-next" || command === "find-previous") { stepFind(command === "find-previous"); return true; }
    if (command === "print") { void printActive(); return true; }
    if (command === "clear-data") { openSettings("privacy"); setClearRequest((count) => count + 1); return true; }
    return false;
  };

  const immersive = pageFullscreen || windowFullscreen;
  useEffect(() => {
    if (!isTauri()) return;
    void getCurrentWindow().setFullscreen(immersive).catch(() => undefined);
  }, [immersive]);
  // Leaving the tab (or the page view) ends a page's full screen; the find bar belongs to one page.
  useEffect(() => {
    setPageFullscreen(false);
    if (findRef.current.open) closeFind(false);
  }, [activeId, surface]);
  useEffect(() => {
    if (windowFullscreen) showMessage("Full screen. Press F11 to leave.");
  }, [windowFullscreen, showMessage]);

  const activeCrash = activeTab ? crashed[activeTab.id] : undefined;
  const activeLoading = !!activeTab && loadingTabs.has(activeTab.id) && !activeIsHome;

  const searchName = SEARCH_ENGINES[settings.searchEngine]?.name ?? "the web";
  const zoomShown = activeTab && !activeIsHome && activeTab.zoom !== undefined ? activeTab.zoom : undefined;

  return (
    <div className={`app-shell ${immersive ? "is-immersive" : ""}`} style={{ "--sidebar": `${sidebarWidth}px` } as CSSProperties}>
      <TabSidebar
        bookmarks={(
          <BookmarkGrid
            bookmarks={bookmarks}
            expanded={expandedFolders}
            stateOf={bookmarkState}
            onOpen={openBookmark}
            onToggleFolder={toggleFolder}
            onMove={(id, parentId, index) => setBookmarks((tree) => moveBookmark(tree, id, parentId, index))}
            onGroup={(dragId, targetId) => {
              const next = groupBookmarks(bookmarks, dragId, targetId);
              const created = next.find((node) => node.kind === "folder" && !bookmarks.some((old) => old.id === node.id));
              setBookmarks(next);
              if (created) {
                setExpandedFolders((open) => [...open, created.id]);
                setEditingBookmark(created);
              }
            }}
            onEditFolder={(folder) => setEditingBookmark(folder)}
            onContextMenu={(x, y, bookmark) => showMenu(x, y, bookmarkMenu(bookmark), true)}
          />
        )}
        bookmarkEditor={editingBookmark && (
          <BookmarkEditor
            bookmark={editingBookmark}
            onCancel={() => setEditingBookmark(null)}
            onSave={(patch) => { setBookmarks((tree) => updateBookmark(tree, editingBookmark.id, patch)); setEditingBookmark(null); }}
            onColor={(color) => setBookmarks((tree) => updateBookmark(tree, editingBookmark.id, { color }))}
          />
        )}
        onBookmarkTab={(id) => {
          const tab = tabsRef.current.find((item) => item.id === id);
          if (tab && !tab.private && !isHomeUrl(tab.url) && !findByUrl(bookmarks, tab.url)) toggleTabBookmark(tab);
        }}
        tabs={tabs}
        history={history}
        downloads={downloads}
        activeId={activeId}
        sleeping={sleeping}
        loading={loadingTabs}
        crashed={crashed}
        audio={audio}
        detailed={settings.density === "detailed"}
        surface={surface}
        mode={sidebarMode}
        onModeChange={setSidebarMode}
        onActivate={selectTab}
        onClose={(id) => void closeTab(id)}
        onReorder={reorderTab}
        onToggleMute={toggleMute}
        onContextMenu={(x, y, items) => showMenu(x, y, items, true)}
        tabMenu={tabMenu}
        historyMenu={historyMenu}
        downloadMenu={downloadMenu}
        onNew={() => void newTab(undefined, { focusAddress: true })}
        onNewPrivate={() => void newTab(undefined, { private: true, focusAddress: true })}
        onOpenUrl={openUrl}
        onOpenDownload={openDownload}
        onRevealDownload={revealDownload}
        onSurfaceChange={(next) => next === "settings" ? openSettings() : setSurface(next)}
        sidebarWidth={sidebarWidth}
        onSidebarResize={(width) => setSidebarWidth(clampSidebarWidth(width))}
      />
      <section className="main-stage">
        <Toolbar
          tab={activeTab}
          fullUrls={settings.fullUrls}
          zoom={zoomShown}
          onResetZoom={() => setZoom(0)}
          bookmarked={activeTab && !isHomeUrl(activeTab.url) && !activeTab.private ? !!activeBookmark : undefined}
          onToggleBookmark={() => toggleTabBookmark(activeTab)}
          onNavigate={(value) => void navigate(value)}
          loading={activeLoading}
          onAction={(action) => {
            if (action === "back" || action === "forward") void goHistory(action === "back");
            else if (action === "stop") { if (activeTab) stopTab(activeTab.id); }
            else if (activeTab) reloadTab(activeTab.id);
          }}
          onMore={() => void openPalette()}
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          onAddressInput={onAddressInput}
          onSelectSuggestion={setSelectedSuggestion}
          onPickSuggestion={pickSuggestion}
          commandMode={commandMode}
          onOpenSiteInfo={() => (siteInfoOpen ? closeSiteInfo(true) : openSiteInfo())}
          logins={activeTab && !isHomeUrl(activeTab.url) && vault?.exists && (pageLogins.length > 0 || !vault.unlocked) ? { count: pageLogins.length, locked: !vault.unlocked } : undefined}
          onOpenLogins={() => (loginsMenu ? setLoginsMenu(null) : openToolbarLogins())}
        />
        <div id="browser-viewport" className="viewport">
          {find.open && surface === "browser" && (
            <FindBar
              query={find.query}
              result={find.result}
              focusSignal={find.focus}
              onQuery={(query) => { setFind((current) => ({ ...current, query })); void runFind(query, false, true); }}
              onStep={stepFind}
              onClose={() => closeFind(true)}
            />
          )}
          <div className="page-slot" ref={pageRef}>
            {surface === "browser" && activeIsHome && <HomeSurface searchName={searchName} private={!!activeTab?.private} onNavigate={(value) => void navigate(value)} />}
            {surface === "browser" && !activeIsHome && !isTauri() && <BrowserPreview />}
            {surface === "browser" && !activeIsHome && activeAsleep && !activeCrash && <div className="page-waking">Reloading…</div>}
            {surface === "browser" && !activeIsHome && activeCrash && activeTab && (
              <div className="page-crashed" role="alert">
                <strong>{activeCrash === "unresponsive" ? "This page stopped responding" : "This page crashed"}</strong>
                <p>{activeCrash === "engine" ? "The browser engine stopped unexpectedly." : "Something went wrong while showing this page."} Reloading usually fixes it.</p>
                <button className="settings-button is-primary" onClick={() => reloadTab(activeTab.id)}>Reload</button>
              </div>
            )}
            {(surface === "history" || surface === "downloads") && (
              <LibrarySurface
                surface={surface}
                historyVersion={historyVersion}
                downloads={downloads}
                onOpen={openUrl}
                onClearHistory={() => void clearHistory()}
                onOpenDownload={openDownload}
                onRevealDownload={revealDownload}
                onCancelDownload={cancelDownload}
                onOpenFolder={openFolder}
                onClearDownloads={() => void clearDownloads()}
                onContextMenu={(x, y, items) => showMenu(x, y, items)}
                historyMenu={historyMenu}
                downloadMenu={downloadMenu}
              />
            )}
            {surface === "settings" && (
              <SettingsSurface
                settings={settings}
                section={settingsSection}
                downloadDirError={downloadDirError}
                onChange={updateSettings}
                onResetSidebar={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
                onClearData={clearData}
                onOpenDevtools={() => activeTab && createdViews.current.has(activeTab.id) && void browserAction(activeTab.id, "devtools")}
                onReset={() => void resetHorizon()}
                defaultBrowser={defaultBrowser}
                bookmarks={bookmarks}
                onImportBookmarks={(tree, icons) => { setBookmarks(tree); rememberFavicons(icons); setSidebarMode("tabs"); }}
                onRemoveAllBookmarks={() => { setBookmarks([]); setExpandedFolders([]); }}
                onMakeDefault={() => void makeDefault()}
                clearRequest={clearRequest}
              />
            )}
          </div>
        </div>
      </section>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {!isTauri() && <Toasts toasts={toasts} downloads={downloads} onDismiss={(id) => setToasts((items) => items.filter((toast) => toast.id !== id))} onOpenDownload={openDownload} onCancelDownload={cancelDownload} onResolveCheck={resolveCheck} onPromptChoice={answerPrompt} position={settings.toastPosition} onHover={holdToast} />}
      {!isTauri() && loginsMenu && <div className="logins-anchor" style={{ left: loginsMenu.anchor.x, top: loginsMenu.anchor.y, width: Math.max(280, loginsMenu.anchor.width) }}><LoginsMenu items={loginsMenu.items} onPick={pickLogin} /></div>}
      {!isTauri() && tooltip && <InlineTooltip tip={tooltip} />}
      {!isTauri() && siteInfoOpen && siteInfo && (
        <div className="site-info-anchor">
          <SiteInfoPanel
            info={siteInfo}
            onSetPermission={(permission, choice) => void setSitePermission(permission, choice)}
            onClearSite={() => void clearCurrentSite()}
            onAllowCertificate={() => activeTab?.certError && void proceedDespiteCertificate(activeTab.id, activeTab.certError.host)}
            onOpenSettings={() => { closeSiteInfo(false); openSettings("privacy"); }}
          />
        </div>
      )}
      <span className="sr-only" aria-live="polite">{tabs.length} tabs open. Active view {activeTab ? viewLabel(activeTab.id) : "none"}.</span>
    </div>
  );
}

/** Tooltip drawn in the chrome itself (browser preview; the desktop app uses an overlay). */
function InlineTooltip({ tip }: { tip: { text: string; x: number; y: number } }) {
  const { left, top } = tooltipPosition(tip, Math.min(340, tip.text.length * 7 + 20), 26);
  return (
    <div className="tooltip is-inline" role="tooltip" style={{ left, top }}>
      {tip.text}
    </div>
  );
}
