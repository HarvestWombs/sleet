import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserPreview } from "./components/BrowserPreview";
import { matchCommands, type PaletteCommand } from "./lib/commands";
import { ContextMenu, type MenuEntry, type MenuRequest, toMenuSpec } from "./components/ContextMenu";
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
  setDockedVisible,
  setChromeZoom,
  setDownloadDir,
  setViewMuted,
  cancelDownload as cancelNativeDownload,
  pauseDownload as pauseNativeDownload,
  setDownloadAsk,
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
import { isModalPrompt, PromptModal } from "./components/PromptModal";
import * as store from "./native/store";
import { OVERLAY_EVENTS, type OverlayAction, type OverlayKind, type OverlayRendered, type OverlaySize, overlayLabel } from "./lib/overlay";
import { neighbour, recordVisit } from "./lib/tabNav";
import { dockTab, type DockNode, type DockSide, pruneLayouts, setRatio, sideAt, tabsIn, withoutTab } from "./lib/dock";
import { DockView } from "./components/DockView";
import { groupAfterMove, keepGroupsTogether, liveGroups, nextGroupColor, nextGroupName, setGroup, type TabGroup } from "./lib/tabGroups";
import { canAutoOpen, extensionOf, normalizeExtension, shouldAutoOpen } from "./lib/downloadTypes";
import { forgetSession, IS_MAIN_WINDOW, listWindows, moveTabsToWindow, openWindow, sessionKey, startedWithPages, WINDOW_LABEL, windowAt, type WindowInfo, type WindowStart, windowsToReopen } from "./lib/windows";
import { buildSuggestions, type Suggestion } from "./lib/suggest";
import { faviconFor, hasSharpFavicon, onFaviconsChanged, rememberFavicon, rememberFavicons, shrinkIcon } from "./lib/favicons";
import { allLinks, type Bookmark, findBookmark, findByUrl, insertBookmark, makeBookmarkId, groupBookmarks, moveBookmark, removeBookmark, ungroupFolder, updateBookmark } from "./lib/bookmarks";
import { BookmarkEditor, BookmarkGrid, type BookmarkState } from "./components/BookmarkGrid";
import { type LoginItem, LoginsMenu } from "./components/LoginsMenu";
import { useVaultStatus } from "./components/Passwords";
import { type VaultEntry, vaultSetRemember, vaultFill, vaultFillGenerated, vaultMatches, vaultOfferRecheck, vaultResolveOffer, vaultSetAutoLock, vaultError } from "./native/vault";
import type { AudioState, BrowserTab, CertErrorEvent, ContextEvent, HttpsFailedEvent, PermissionRequestEvent, PopupBlockedEvent, DownloadCheckEvent, DownloadEvent, DownloadStateEvent, DownloadItem, DownloadProgressEvent, HistoryEntry, SidebarMode, Surface, ViewBounds } from "./types";

// Unique per window: tab ids name page webviews, which every window shares one namespace for.
const initialTab: BrowserTab = { id: IS_MAIN_WINDOW ? "home" : `home${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, title: "Home", url: HOME_URL, createdAt: Date.now() };

const DEFAULT_SIDEBAR_WIDTH = 275;
const RECENT_HISTORY = 200;
const SHORTCUTS: Record<string, string> = {
  k: "palette", l: "address", t: "new-tab", n: "new-window", w: "close-tab", y: "history", j: "downloads", ",": "settings",
  "=": "zoom-in", "+": "zoom-in", "-": "zoom-out", "0": "zoom-reset", d: "bookmark",
  f: "find", g: "find-next", p: "print", r: "reload", tab: "next-tab", pagedown: "next-tab", pageup: "previous-tab",
};
const SHIFTED_SHORTCUTS: Record<string, string> = {
  n: "new-private-tab", w: "reopen-tab", t: "reopen-tab", s: "toggle-sidebar", tab: "previous-tab", g: "find-previous", delete: "clear-data", r: "reload",
};
const NO_MATCHES: FindResult = { count: 0, index: -1 };
/** Toolbar height in CSS pixels (the --toolbar variable). */
const toolbarHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--toolbar")) || 58;
const makeId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const clampSidebarWidth = (width: number) => Math.min(450, Math.max(220, Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH));
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
  // Each window keeps its own tabs (sessionKey); everything else is shared.
  const [tabs, setTabs] = usePersistentState<BrowserTab[]>(sessionKey("sleet.tabs"), [initialTab], (items) => {
    const kept = items.filter((tab) => !tab.private).map(({ certError: _certError, ...tab }) => tab);
    return kept.length > 0 ? kept : [initialTab];
  });
  const [activeId, setActiveId] = usePersistentState(sessionKey("sleet.active-tab"), initialTab.id);
  const [bookmarks, setBookmarks] = usePersistentState<Bookmark[]>("sleet.bookmarks", []);
  const [expandedFolders, setExpandedFolders] = usePersistentState<string[]>("sleet.bookmark-folders", []);
  const [bookmarksCollapsed, setBookmarksCollapsed] = usePersistentState("sleet.bookmarks-collapsed", false);
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
  /** Sidebar hidden (Ctrl+Shift+S); the toolbar then shows a button to bring it back. */
  const [sidebarHidden, setSidebarHidden] = usePersistentState("sleet.sidebar-hidden", false);
  /** Width the sidebar takes on screen right now. */
  const sidebarShown = sidebarHidden ? 0 : sidebarWidth;
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const tooltip = useTooltips();
  const [audio, setAudio] = useState<Record<string, AudioState>>({});
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  /** The open menu as data to draw, plus its items' actions by id. */
  const menuSpec = useMemo(() => (menu ? toMenuSpec(menu) : null), [menu]);
  // The open menu's actions, kept apart from render so a pick arriving from the
  // overlay always finds them.
  const menuActions = useRef(new Map<string, () => void>());
  if (menuSpec) menuActions.current = menuSpec.actions;
  const runMenuItem = (id: string) => {
    const action = menuActions.current.get(id);
    setMenu(null);
    action?.();
  };
  const [surface, setSurface] = useState<Surface>("browser");
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("tabs");
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  /** Ctrl+K: the address bar lists commands as well as sites and searches. */
  const [commandMode, setCommandMode] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  /** Which box the suggestions belong to: the address bar or Home's search. */
  const [suggestAnchor, setSuggestAnchor] = useState<"address" | "home">("address");
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
  /** Each page's own back/forward availability, as the engine reports it. */
  const [pageHistory, setPageHistory] = useState<Record<string, { back: boolean; forward: boolean }>>({});
  const loadingRef = useRef(loadingTabs);
  loadingRef.current = loadingTabs;
  const pageRef = useRef<HTMLDivElement>(null);
  // A window opened by moving tabs out of another starts with those pages already loaded.
  const createdViews = useRef(new Set<string>(startedWithPages()));
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
  /** Whether a page webview is one of this window's tabs (every window hears every page's events). */
  const ownsLabel = (label: string) => tabsRef.current.some((tab) => viewLabel(tab.id) === label);
  /** Downloads started from this window's tabs (`private`: from a private tab, never saved). */
  const ownDownloads = useRef(new Map<string, { private: boolean }>());
  /** The other open Sleet windows, for "Move to window". */
  const [otherWindows, setOtherWindows] = useState<WindowInfo[]>([]);

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

  /**
   * Where a tab's page goes, in window logical pixels (CSS pixels scaled by
   * interface zoom): its pane when docked, else the whole page area.
   */
  const getBounds = useCallback((tabId: string = activeIdRef.current): ViewBounds | null => {
    const pane = document.querySelector<HTMLElement>(`[data-dock-body="${CSS.escape(tabId)}"]`);
    const rect = (pane ?? pageRef.current)?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    const scale = (settingsRef.current.appZoom || 1);
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

  const focusHomeSearch = useCallback(async () => {
    await focusChrome();
    // Home mounts on the next render; wait for it, then fall back to the address bar.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>("[data-home-search]");
      if (input) input.focus();
      else void focusAddress();
    }));
  }, [focusAddress]);

  /** Creates the page webview for a tab if it has none (new, unloaded, or leaving home). */
  const ensureView = useCallback(async (tabId: string, url: string) => {
    if (isHomeUrl(url) || createdViews.current.has(tabId)) return;
    const bounds = getBounds(tabId);
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
      return tab.id;
    }
    setActiveId(tab.id);
    setSurface("browser");
    setSidebarMode("tabs");
    await ensureView(tab.id, url);
    // A new tab on the Home page types into Home's own search box; other pages use the address bar.
    if (options.focusAddress) void (isHomeUrl(url) ? focusHomeSearch() : focusAddress());
    return tab.id;
  }, [ensureView, focusAddress, focusHomeSearch, setActiveId, setTabs]);

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
  const closeTabs = useCallback(async (ids: string[], options: { detach?: boolean } = {}) => {
    const closing = new Set(ids);
    const before = tabsRef.current;
    if (!before.some((tab) => closing.has(tab.id))) return;
    const remaining = before.filter((tab) => !closing.has(tab.id));
    const activeIndex = before.findIndex((tab) => tab.id === activeIdRef.current);
    // Detached tabs moved to another window: their pages live on there.
    if (!options.detach) {
      before.forEach((tab, index) => {
        if (closing.has(tab.id)) closedTabs.current.push({ tab: { ...tab, certError: undefined }, index });
      });
      closedTabs.current = closedTabs.current.slice(-25);
    }
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
    setPageHistory((current) => { const next = { ...current }; ids.forEach((id) => delete next[id]); return next; });
    setTabs(remaining);
    if (!options.detach) await Promise.all(ids.map((id) => closeView(id)));
    if (remaining.length === 0) {
      // Every tab left for another window: this one closes.
      if (options.detach) { void getCurrentWindow().close(); return; }
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

  /**
   * Moves tabs to another window (`target`) or a new one, pages and all: the
   * page webviews change windows without reloading. `position` places a new
   * window (physical screen pixels), e.g. where a dragged tab was dropped.
   */
  const moveTabsToOtherWindow = useCallback(async (ids: string[], target: string | null, position?: [number, number]) => {
    const moving = tabsRef.current.filter((tab) => ids.includes(tab.id));
    if (moving.length === 0) return;
    const live = moving.filter((tab) => createdViews.current.has(tab.id)).map((tab) => tab.id);
    const start: WindowStart = {
      // Groups belong to a window; moved tabs arrive ungrouped.
      tabs: moving.map(({ certError: _certError, groupId: _groupId, ...tab }) => tab),
      activeId: (moving.find((tab) => tab.id === activeIdRef.current) ?? moving[0]).id,
      live,
    };
    const pages = live.map(viewLabel);
    try {
      if (target) await moveTabsToWindow(target, start, pages);
      else await openWindow({ start, movePages: pages, position });
    } catch (error) {
      showMessage(String(error));
      return;
    }
    await closeTabs(ids, { detach: true });
  }, [closeTabs, showMessage]);

  /** Tabs arriving from another window (their pages are already here). */
  const adoptTabs = useCallback((start: WindowStart) => {
    const arriving = (start.tabs as BrowserTab[]).filter((tab) => tab && typeof tab.id === "string" && !tabsRef.current.some((item) => item.id === tab.id));
    if (arriving.length === 0) return;
    (start.live ?? []).forEach((id) => createdViews.current.add(id));
    const next = [...tabsRef.current, ...arriving];
    tabsRef.current = next;
    setTabs(next);
    const active = arriving.find((tab) => tab.id === start.activeId) ?? arriving[0];
    setSurface("browser");
    selectTab(active.id);
    const bounds = getBounds();
    if (bounds) arriving.forEach((tab) => { if (createdViews.current.has(tab.id)) void resizeView(tab.id, bounds); });
  }, [getBounds, selectTab, setTabs]);

  /** Opens another Sleet window on the new tab page. */
  const newWindow = useCallback(() => {
    void openWindow().catch((error) => showMessage(String(error)));
  }, [showMessage]);

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

  /**
   * Moves a tab to `toIndex`. `groupId` says which group it lands in (`null`:
   * none), as the sidebar's drop line showed; left out (menu Move up/down), the
   * neighbours decide.
   */
  const reorderTab = useCallback((id: string, toIndex: number, groupId?: string | null) => {
    setTabs((items) => {
      const from = items.findIndex((tab) => tab.id === id);
      if (from === -1) return items;
      const target = from < toIndex ? toIndex - 1 : toIndex;
      const group = groupId === undefined ? undefined : groupId ?? undefined;
      if (target === from && (groupId === undefined || items[from].groupId === group)) return items;
      const next = items.filter((tab) => tab.id !== id);
      const at = Math.max(0, Math.min(target, next.length));
      next.splice(at, 0, items[from]);
      next[at] = { ...next[at], groupId: groupId === undefined ? groupAfterMove(next, at) : group };
      return keepGroupsTogether(next);
    });
  }, [setTabs]);

  // ---- Tab groups
  /** Groups for this window's tabs (empty ones disappear). */
  const [storedGroups, setTabGroups] = usePersistentState<TabGroup[]>(sessionKey("sleet.tab-groups"), []);
  const tabGroups = useMemo(() => liveGroups(storedGroups, tabs), [storedGroups, tabs]);
  /** Group whose name is being edited in the sidebar. */
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  useEffect(() => {
    if (tabGroups.length !== storedGroups.length) setTabGroups(tabGroups);
  }, [tabGroups, storedGroups.length, setTabGroups]);

  /** Puts tabs in a group: an existing one, or a new one (`groupId` null) whose name is then edited. */
  const groupTabs = useCallback((ids: string[], groupId: string | null) => {
    let id = groupId;
    if (!id) {
      id = makeId();
      const created: TabGroup = { id, name: nextGroupName(storedGroups), color: nextGroupColor(tabGroups) };
      setTabGroups((groups) => [...groups, created]);
      setEditingGroup(id);
    }
    const target = id;
    setTabs((items) => setGroup(items, ids, target));
    setTabGroups((groups) => groups.map((group) => group.id === target ? { ...group, collapsed: false } : group));
  }, [setTabGroups, setTabs, storedGroups, tabGroups]);

  // ---- Docking: tabs side by side in the page area (lib/dock.ts)
  const [storedDocks, setDocks] = usePersistentState<DockNode[]>(sessionKey("sleet.docks"), []);
  const docks = useMemo(() => pruneLayouts(storedDocks, new Set(tabs.map((tab) => tab.id))), [storedDocks, tabs]);
  useEffect(() => { if (docks !== storedDocks && JSON.stringify(docks) !== JSON.stringify(storedDocks)) setDocks(docks); }, [docks, storedDocks, setDocks]);
  /** The layout holding the active tab: shown while on the browser surface. */
  const activeLayout = docks.find((layout) => tabsIn(layout).includes(activeId)) ?? null;
  const dockShowing = surface === "browser" && !!activeLayout;
  const dockedTabs = useMemo(() => tabsIn(activeLayout), [activeLayout]);
  /** A tab being dragged for docking, and where it would land. */
  type DockDrag = { tabId: string; from: "sidebar" | "pane"; target: string | null; side: DockSide | null };
  const [dockDrag, setDockDrag] = useState<DockDrag | null>(null);
  const dockDragRef = useRef<DockDrag | null>(null);
  const dockedIds = useMemo(() => new Set(docks.flatMap(tabsIn)), [docks]);
  /** Draw the docked layout (or, while dragging over a single page, that page as a drop target). */
  const showDockView = surface === "browser" && (dockShowing || (!!dockDrag && !activeIsHome));
  const tabsById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);

  /** Docks a tab beside another and makes it the active one. */
  const dockTabNextTo = useCallback((tabId: string, target: string, side: DockSide) => {
    if (tabId === target) return;
    setDocks((layouts) => dockTab(pruneLayouts(layouts, new Set(tabsRef.current.map((tab) => tab.id))), tabId, target, side));
    // Docked tabs share a group: the target's, or a new "Split view" group for the layout.
    const targetGroup = tabsRef.current.find((tab) => tab.id === target)?.groupId;
    if (targetGroup) {
      setTabs((items) => setGroup(items, [tabId], targetGroup));
    } else {
      const id = makeId();
      setTabGroups((groups) => [...groups, { id, name: "Split view", color: nextGroupColor(groups), docked: true }]);
      setTabs((items) => setGroup(items, [target, tabId], id));
    }
    selectTab(tabId);
  }, [selectTab, setDocks, setTabGroups, setTabs]);

  // A tab that leaves its layout (undocked, or the layout ended) leaves the group made for it.
  useEffect(() => {
    const auto = new Set(tabGroups.filter((group) => group.docked).map((group) => group.id));
    const stray = tabs.filter((tab) => tab.groupId && auto.has(tab.groupId) && !dockedIds.has(tab.id)).map((tab) => tab.id);
    if (stray.length > 0) setTabs((items) => setGroup(items, stray, undefined));
  }, [tabs, tabGroups, dockedIds, setTabs]);

  /** Takes a tab out of its layout (it stays open as a tab of its own); the layout stays on screen. */
  const undockTab = useCallback((tabId: string) => {
    const layout = docks.find((item) => tabsIn(item).includes(tabId));
    setDocks((layouts) => withoutTab(layouts, tabId));
    if (layout && tabId === activeIdRef.current) {
      const next = tabsIn(layout).find((id) => id !== tabId);
      if (next) selectTab(next);
    }
  }, [docks, selectTab, setDocks]);

  /** Drag in progress over the page area (`x`, `y` in chrome CSS pixels): find the pane and side under the pointer. */
  const dockDragMove = useCallback((tabId: string, from: "sidebar" | "pane", x: number, y: number) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab || isHomeUrl(tab.url)) return;
    const paneElement = document.elementsFromPoint(x, y).map((element) => (element as HTMLElement).closest<HTMLElement>("[data-dock-pane]")).find(Boolean);
    const target = paneElement?.dataset.dockPane ?? null;
    const targetTab = target ? tabsRef.current.find((item) => item.id === target) : undefined;
    const side = paneElement && target !== tabId && targetTab && !isHomeUrl(targetTab.url) ? sideAt(paneElement.getBoundingClientRect(), x, y) : null;
    const next = { tabId, from, target: side ? target : null, side };
    dockDragRef.current = next;
    setDockDrag((current) => current && current.target === next.target && current.side === next.side && current.tabId === tabId ? current : next);
  }, []);

  /** The sidebar's drag left the page area again: no docking. */
  const dockDragLeave = useCallback(() => { dockDragRef.current = null; setDockDrag(null); }, []);

  /** Drag ended. Dropped on a pane's edge it docks; a pane dropped over the sidebar undocks. */
  const dockDragEnd = useCallback((x: number, y: number, cancelled = false) => {
    const drag = dockDragRef.current;
    dockDragRef.current = null;
    setDockDrag(null);
    if (!drag || cancelled) return;
    if (drag.target && drag.side) { dockTabNextTo(drag.tabId, drag.target, drag.side); return; }
    if (drag.from === "pane") {
      const page = pageRef.current?.getBoundingClientRect();
      const outside = !page || x < page.left || y < page.top || x > page.right || y > page.bottom;
      if (outside) undockTab(drag.tabId);
    }
  }, [dockTabNextTo, undockTab]);

  /** A docked pane's title bar is being dragged: follow the pointer until it's released. */
  const startPaneDrag = useCallback((tabId: string, start: PointerEvent) => {
    const controller = new AbortController();
    document.body.classList.add("is-dragging-tab");
    dockDragMove(tabId, "pane", start.clientX, start.clientY);
    window.addEventListener("pointermove", (move) => dockDragMove(tabId, "pane", move.clientX, move.clientY), { signal: controller.signal });
    const finish = (end: PointerEvent) => {
      controller.abort();
      document.body.classList.remove("is-dragging-tab");
      dockDragEnd(end.clientX, end.clientY, end.type === "pointercancel");
    };
    window.addEventListener("pointerup", finish, { signal: controller.signal });
    window.addEventListener("pointercancel", finish, { signal: controller.signal });
    window.addEventListener("keydown", (key) => { if (key.key === "Escape") { controller.abort(); document.body.classList.remove("is-dragging-tab"); dockDragEnd(0, 0, true); } }, { signal: controller.signal });
  }, [dockDragEnd, dockDragMove]);

  // Every pane of the shown layout has its page loaded and sized to its pane.
  useEffect(() => {
    if (!dockShowing) return;
    dockedTabs.forEach((id) => {
      const tab = tabsRef.current.find((item) => item.id === id);
      if (tab) void ensureView(id, tab.url);
    });
  }, [dockShowing, dockedTabs, ensureView]);
  const layoutDockedViews = useCallback(() => {
    if (!dockShowing) return;
    requestAnimationFrame(() => dockedTabs.forEach((id) => {
      const bounds = getBounds(id);
      if (bounds && createdViews.current.has(id)) void resizeView(id, bounds);
    }));
  }, [dockShowing, dockedTabs, getBounds]);
  useEffect(() => {
    layoutDockedViews();
    const slot = pageRef.current;
    if (!slot || !dockShowing) return;
    const observer = new ResizeObserver(layoutDockedViews);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [layoutDockedViews, activeLayout, dockShowing]);

  // Switching to a tab in a folded group opens the group.
  useEffect(() => {
    const groupId = tabsRef.current.find((tab) => tab.id === activeId)?.groupId;
    if (groupId) setTabGroups((groups) => groups.some((group) => group.id === groupId && group.collapsed) ? groups.map((group) => group.id === groupId ? { ...group, collapsed: false } : group) : groups);
  }, [activeId, setTabGroups]);

  const ungroupTabs = useCallback((ids: string[]) => setTabs((items) => setGroup(items, ids, undefined)), [setTabs]);
  const updateGroup = useCallback((id: string, change: Partial<TabGroup>) => {
    setTabGroups((groups) => groups.map((group) => group.id === id ? { ...group, ...change } : group));
  }, [setTabGroups]);

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

  /** Saves a download's record. Only the window it started in writes it, and never for private tabs. */
  const saveDownload = (item: DownloadItem) => {
    const own = ownDownloads.current.get(item.id);
    if (!own || own.private) return Promise.resolve(false);
    const { paused: _paused, ...row } = item;
    return store.downloadPut(row).then(() => true, () => false);
  };

  /** Applies a change to one download in the list (and the ref, for handlers running before the next render). */
  const patchDownload = (id: string, change: (item: DownloadItem) => DownloadItem) => {
    downloadsRef.current = downloadsRef.current.map((item) => item.id === id ? change(item) : item);
    setDownloads((items) => items.map((item) => item.id === id ? change(item) : item));
  };

  const handleDownload = useCallback((event: DownloadEvent) => {
    const id = `${event.label}:${event.url}`;
    if (event.phase === "requested") {
      const item: DownloadItem = { id, filename: filenameFrom(event.url, event.path), url: event.url, path: event.path, status: "active", startedAt: Date.now() };
      downloadsRef.current = [item, ...downloadsRef.current.filter((existing) => existing.id !== id)];
      setDownloads((items) => [item, ...items.filter((existing) => existing.id !== id)]);
      // Every window lists it; the one whose tab started it saves it and shows the notice.
      const tab = tabsRef.current.find((entry) => viewLabel(entry.id) === event.label);
      if (!tab) return;
      ownDownloads.current.set(id, { private: !!tab.private });
      void saveDownload(item);
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
      paused: undefined,
      error: status === "failed" ? error ?? "Download failed" : undefined,
      received: status === "complete" && previous.total ? previous.total : previous.received,
    };
    patchDownload(id, () => finished);
    const saved = saveDownload(finished);
    const hideAt = Date.now() + settingsRef.current.toastSeconds * 1000;
    setToasts((items) => items.map((toast) => toast.id === id && toast.expiresAt !== null ? { ...toast, expiresAt: hideAt, leaving: false } : toast));
    // "Always open files of this type" (opening goes through the saved record).
    if (status === "complete" && ownDownloads.current.has(id) && shouldAutoOpen(finished.filename, settingsRef.current.autoOpenTypes)) {
      void saved.then((ok) => { if (ok) void store.openDownload(id).catch(() => undefined); });
    }
  };

  const handleDownloadState = useCallback((event: DownloadStateEvent) => {
    const id = `${event.label}:${event.url}`;
    const reason = event.reason ?? undefined;
    if (event.state === "paused" || event.state === "active") {
      patchDownload(id, (item) => item.status !== "active" ? item : {
        ...item,
        paused: event.state === "paused",
        error: event.state === "paused" ? reason : undefined,
        // Save as: the file goes where the user chose.
        ...(event.path ? { path: event.path, filename: filenameFrom(item.url, event.path) } : {}),
      });
      if (event.path) {
        const item = downloadsRef.current.find((entry) => entry.id === id);
        if (item) void saveDownload(item);
      }
      return;
    }
    if (event.state === "discarded") {
      // The Save as dialog was closed: nothing was downloaded, so leave no trace.
      downloadsRef.current = downloadsRef.current.filter((item) => item.id !== id);
      setDownloads((items) => items.filter((item) => item.id !== id));
      setToasts((items) => items.filter((toast) => toast.id !== id));
      if (ownDownloads.current.delete(id)) void store.downloadDelete(id).catch(() => undefined);
      return;
    }
    finishDownload(id, event.state, event.path ?? undefined, reason);
  }, []);

  const handleDownloadCheck = useCallback((event: DownloadCheckEvent) => {
    // "Don't ask again for this file type": keep it without asking.
    const type = normalizeExtension(event.extension);
    if (type && settingsRef.current.trustedDownloadTypes.includes(type)) {
      void resolveDownloadCheck(event.checkId, true);
      return;
    }
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

  /** Keep or delete a file Windows flagged; `remember` stops asking for that file type. */
  const resolveCheck = useCallback((check: DownloadCheckEvent, keep: boolean, remember = false) => {
    setToasts((items) => items.filter((toast) => toast.id !== `check-${check.checkId}`));
    void resolveDownloadCheck(check.checkId, keep);
    const type = normalizeExtension(check.extension);
    if (keep && remember && type && !settingsRef.current.trustedDownloadTypes.includes(type)) {
      updateSettings({ trustedDownloadTypes: [...settingsRef.current.trustedDownloadTypes, type].sort() });
    }
  }, [updateSettings]);

  const cancelDownload = useCallback((download: DownloadItem) => {
    if (download.status !== "active") return;
    void cancelNativeDownload(download.id);
    // Mark it straight away; the engine's own "cancelled" report changes nothing further.
    finishDownload(download.id, "cancelled");
  }, []);

  /** Pauses a running download, or resumes a paused one. */
  const togglePauseDownload = useCallback((download: DownloadItem) => {
    if (download.status !== "active") return;
    const pause = !download.paused;
    // Show it straight away; the engine confirms with its own state report.
    patchDownload(download.id, (item) => ({ ...item, paused: pause, error: pause ? item.error : undefined }));
    pauseNativeDownload(download.id, pause).catch((error) => {
      patchDownload(download.id, (item) => ({ ...item, paused: !pause }));
      showMessage(String(error));
    });
  }, [showMessage]);

  /** Turns "always open files of this type" on or off for a download's extension. */
  const toggleAutoOpen = useCallback((download: DownloadItem) => {
    const extension = extensionOf(download.filename);
    if (!canAutoOpen(extension)) return;
    const current = settingsRef.current.autoOpenTypes;
    const next = current.includes(extension) ? current.filter((item) => item !== extension) : [...current, extension].sort();
    updateSettings({ autoOpenTypes: next });
  }, [updateSettings]);

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
    setSuggestAnchor("address");
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
    if (command === "new-window") newWindow();
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
  }, [activeTab, closePalette, closeTab, commitTabDigits, focusAddress, goHistory, newTab, newWindow, openPalette, openSettings, commandMode, pushTabDigit, reopenClosedTab, setZoom, surface, toggleSurface]);
  const runShortcutRef = useRef(runShortcut);
  runShortcutRef.current = runShortcut;

  const runPaletteCommand = (command: PaletteCommand) => {
    if (command.kind === "navigate") void navigate(command.value);
    if (command.kind === "new-tab") void newTab(undefined, { focusAddress: true });
    if (command.kind === "new-window") newWindow();
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
    if (command.kind === "toggle-sidebar") setSidebarHidden((hidden) => !hidden);
    if (command.kind === "toggle-theme") {
      const light = settings.theme === "light" || (settings.theme === "system" && systemLight);
      updateSettings({ theme: light ? "dark" : "light" });
    }
  };

  // Launch: move old localStorage lists into SQLite, apply retention, load lists.
  // A window opened later only loads the lists (downloads still running elsewhere stay running).
  useEffect(() => {
    if (!IS_MAIN_WINDOW) {
      void store.downloadsList(500).then((rows) => {
        const known = new Set(downloadsRef.current.map((item) => item.id));
        setDownloads((items) => [...items, ...rows.filter((row) => !known.has(row.id))]);
      }).catch(() => undefined);
      void refreshHistory();
      return;
    }
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

  /** Saved logins can be used: unlocked, or "remember on this device" (Sleet unlocks itself). */
  const vaultUsable = !!vault && (vault.unlocked || vault.remembered);

  useEffect(() => {
    const url = activeTab && !isHomeUrl(activeTab.url) ? activeTab.url : "";
    if (!vaultUsable || !url) { setPageLogins([]); return; }
    void vaultMatches(url).then(setPageLogins).catch(() => setPageLogins([]));
  }, [activeTab?.url, vaultUsable, vault?.unlocked, vault?.count]);

  // Unlocked with the master password on a device that isn't remembered: offer once to stop asking.
  useEffect(() => {
    if (!vault?.unlocked || vault.remembered || settingsRef.current.rememberDevicePromptDismissed) return;
    setToasts((items) => items.some((item) => item.id === "remember-device")
      ? items
      : [...items, { id: "remember-device", prompt: { kind: "remember-device" }, expiresAt: null }]);
  }, [vault?.unlocked, vault?.remembered]);

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
    const zoom = (settingsRef.current.appZoom || 1);
    const items = loginItemsFor(pageLogins, { newPassword: false, locked: !vaultUsable });
    setLoginsMenu({ label: viewLabel(activeTab.id), anchor: { x: (field?.right ?? 750) * zoom - 375 * zoom, y: ((field?.bottom ?? toolbarHeight()) + 8) * zoom, width: 375 * zoom }, items, from: "toolbar" });
  };

  useEffect(() => {
    if (!isTauri()) return;
    let blurTimer: number | undefined;
    const stops = [
      listenEvent<{ label: string; pendingId: string; origin: string; username: string; kind: "new" | "update" | "locked" }>("sleet-password-offer", ({ payload }) => {
        if (!ownsLabel(payload.label)) return;
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
          const usable = !!status && (status.unlocked || status.remembered);
          const entries = usable ? await vaultMatches(payload.origin).catch(() => []) : [];
          const locked = !!status?.exists && !usable;
          const items = loginItemsForRef.current(entries, { newPassword: payload.newPassword && usable, locked });
          if (items.length === 0) { setLoginsMenu(null); return; }
          // Field box (page CSS px) → window logical px: page bounds + zoomed offset.
          const bounds = getBounds();
          const pageZoom = tab.zoom ?? settingsRef.current.zoom;
          if (!bounds) return;
          setLoginsMenu({
            label: payload.label,
            anchor: { x: bounds.x + payload.x * pageZoom, y: bounds.y + (payload.y + payload.height) * pageZoom + 5, width: payload.width * pageZoom },
            items,
            from: "field",
          });
        })();
      }),
      listenEvent<string>("sleet-login-blur", ({ payload }) => {
        if (!ownsLabel(payload)) return;
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
  // Runs once per launch, even when React mounts effects twice (development).
  const launchHandled = useRef(false);
  useEffect(() => {
    if (launchHandled.current) return;
    launchHandled.current = true;
    void takeLaunchUrls().then((urls) => urls.forEach((url) => void newTab(url)));
    void defaultBrowserStatus().then((status) => {
      setDefaultBrowser(status);
      if (status.supported && !status.isDefault && !settingsRef.current.defaultBrowserPromptDismissed) {
        window.setTimeout(() => {
          if (settingsRef.current.defaultBrowserPromptDismissed) return;
          setToasts((items) => items.some((item) => item.id === "default-browser")
            ? items
            : [...items, { id: "default-browser", prompt: { kind: "default-browser" }, expiresAt: null }]);
        }, 6000);
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
    if (prompt.kind === "remember-device") {
      updateSettings({ rememberDevicePromptDismissed: true });
      if (choice === "turn-on") void vaultSetRemember(true).then(() => showMessage("Sleet won't ask for your master password on this device")).catch((error) => showMessage(vaultError(error)));
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

  /** A click inside a docked pane's page makes that tab the active one. */
  const focusDockedPage = (id: string) => {
    if (id === activeIdRef.current || !dockShowing || !dockedTabs.includes(id)) return;
    suppressPageFocus.current = true;
    setActiveId(id);
  };
  const handlersRef = useRef({ adoptTabs, focusDockedPage, handleExternalLink, handleCrash, handleFullscreen, addHistory, handleCertError, handleContext, handleDownload, handleDownloadCheck, handleDownloadProgress, handleDownloadState, handleHttpsFailed, handlePermissionRequest, handlePopupBlocked, newTab, recordUrl, setTabs });
  handlersRef.current = { adoptTabs, focusDockedPage, handleExternalLink, handleCrash, handleFullscreen, addHistory, handleCertError, handleContext, handleDownload, handleDownloadCheck, handleDownloadProgress, handleDownloadState, handleHttpsFailed, handlePermissionRequest, handlePopupBlocked, newTab, recordUrl, setTabs };
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
      onFavicon: ({ label, icon, sharp }) => {
        const id = label.replace(/^page-/, "");
        void (async () => {
          const tab = tabsRef.current.find((item) => item.id === id);
          if (!tab) return;
          // Keep a site's large icon when the engine later reports its 16px one.
          const remembered = !sharp && !tab.private && hasSharpFavicon(tab.url) ? faviconFor(tab.url) : undefined;
          const shown = remembered ?? (icon ? await shrinkIcon(icon) : undefined);
          handlersRef.current.setTabs((items) => items.map((item) => item.id === id ? { ...item, favicon: shown } : item));
          if (shown && !remembered && !tab.private) rememberFavicon(tab.url, shown, !!sharp);
        })();
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
      onHistory: ({ label, back, forward }) => {
        const id = label.replace(/^page-/, "");
        setPageHistory((current) => current[id]?.back === back && current[id]?.forward === forward ? current : { ...current, [id]: { back, forward } });
      },
      onAdoptTabs: (start) => handlersRef.current.adoptTabs(start),
      onPageFocus: (label) => handlersRef.current.focusDockedPage(label.replace(/^page-/, "")),
      owns: ownsLabel,
    }).then((unlisten) => {
      if (disposed) unlisten();
      else dispose = unlisten;
    });
    return () => { disposed = true; dispose(); };
  }, []);

  // Show the active page only on the browser surface. Focus moves to the page
  // when it becomes visible, unless a command just moved focus elsewhere.
  const lastShown = useRef<string | null>(null);
  // Docked: the other panes of the active tab's layout show too. While a tab is
  // dragged for docking every page hides, so the drop targets drawn by Sleet show.
  const dockedKey = dockShowing && !dockDrag ? dockedTabs.join(",") : "";
  useEffect(() => {
    const visibleId = surface === "browser" && !activeIsHome && !activeAsleep && !dockDrag ? activeId : null;
    const changed = lastShown.current !== visibleId;
    lastShown.current = visibleId;
    const focusPage = changed && !!visibleId && !suppressPageFocus.current;
    suppressPageFocus.current = false;
    setDockedVisible(dockedKey ? dockedKey.split(",").filter((id) => createdViews.current.has(id)) : []);
    void (async () => {
      await activateView(visibleId, tabKey ? tabKey.split(",") : [], focusPage);
      if (!visibleId && changed) await focusChrome();
    })();
  }, [activeAsleep, activeId, activeIsHome, surface, tabKey, dockedKey, !!dockDrag]);

  // Password prompts show one at a time as a centered modal; everything else stays a corner toast.
  const modalToast = toasts.find(isModalPrompt) ?? null;
  const cornerToasts = toasts.filter((toast) => !isModalPrompt(toast));

  // ---- Overlays: palette and toasts drawn above the page webview.
  const overlayTheme = settings.theme === "light" || (settings.theme === "system" && systemLight) ? "light" : "dark";
  const overlayVars = appearanceVars(settings);
  const overlayVarsKey = JSON.stringify(overlayVars);
  const overlayStateRef = useRef<Record<OverlayKind, unknown>>({ toasts: null, suggest: null, siteinfo: null, tooltip: null, logins: null, modal: null, menu: null });
  overlayStateRef.current = {
    toasts: { kind: "toasts", theme: overlayTheme, vars: overlayVars, toasts: cornerToasts, downloads: downloads.filter((item) => cornerToasts.some((toast) => toast.downloadId === item.id)) },
    modal: { kind: "modal", theme: overlayTheme, vars: overlayVars, toast: modalToast },
    logins: { kind: "logins", theme: overlayTheme, vars: overlayVars, items: loginsMenu?.items ?? [] },
    tooltip: { kind: "tooltip", theme: overlayTheme, vars: overlayVars, text: tooltip?.text ?? "", seq: tooltip?.seq ?? 0 },
    suggest: { kind: "suggest", theme: overlayTheme, vars: overlayVars, items: suggestions, selected: selectedSuggestion },
    siteinfo: { kind: "siteinfo", theme: overlayTheme, vars: overlayVars, open: siteInfoOpen, session: siteInfoSession, info: siteInfo },
    menu: { kind: "menu", theme: overlayTheme, vars: overlayVars, menu: menuSpec?.spec ?? null },
  };

  /** Overlay rectangle in window logical pixels for its reported content size. */
  const overlayBounds = (kind: OverlayKind): ViewBounds => {
    const zoom = (settingsRef.current.appZoom || 1);
    const size = overlaySizes[kind];
    if (kind === "tooltip") {
      const width = Math.min(size?.width ?? 250, 425);
      const height = size?.height ?? 35;
      const { left, top } = tooltipPosition(tooltip ?? { x: 0, y: 0 }, width, height);
      return { x: Math.round(left * zoom), y: Math.round(top * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) };
    }
    if (kind === "logins") {
      // Anchor is already in window logical pixels.
      const anchor = loginsMenu?.anchor ?? { x: 0, y: 0, width: 280 };
      const width = Math.max(anchor.width, 350 * zoom);
      const height = (size?.height ?? 150) * zoom;
      const x = Math.min(anchor.x, window.innerWidth * zoom - width - 10);
      const y = anchor.y + height > window.innerHeight * zoom - 10 ? Math.max(10, anchor.y - height - 50 * zoom) : anchor.y;
      return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    }
    if (kind === "siteinfo") {
      const field = document.querySelector<HTMLElement>(".address")?.getBoundingClientRect();
      const x = (field?.left ?? sidebarShown + 120) - 2;
      const y = (field?.bottom ?? toolbarHeight()) + 8;
      const height = Math.min(size?.height ?? 525, window.innerHeight - y - 20);
      return { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(425 * zoom), height: Math.round(height * zoom) };
    }
    if (kind === "menu") {
      // The whole window: menus and their submenus can open anywhere; a click off them closes them.
      return { x: 0, y: 0, width: Math.round(window.innerWidth * zoom), height: Math.round(window.innerHeight * zoom) };
    }
    if (kind === "modal") {
      // The whole page area: the backdrop dims it and the dialog sits in its middle.
      return getBounds() ?? { x: Math.round(sidebarShown * zoom), y: Math.round(toolbarHeight() * zoom), width: Math.round((window.innerWidth - sidebarShown) * zoom), height: Math.round((window.innerHeight - toolbarHeight()) * zoom) };
    }
    if (kind === "suggest") {
      const field = document.querySelector<HTMLElement>(suggestAnchor === "home" ? ".home-search" : ".address")?.getBoundingClientRect();
      const x = field?.left ?? sidebarShown + 120;
      const y = (field?.bottom ?? toolbarHeight()) + 5;
      const width = field?.width ?? 750;
      const height = Math.min(size?.height ?? 375, window.innerHeight - y - 20);
      return { x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(height * zoom) };
    }
    const width = Math.round(375 * Math.min(1.6, settings.textSize * (settings.textAreas.toasts ?? 1)));
    const height = size?.height ?? 80;
    const position = settings.toastPosition;
    const x = position.endsWith("right") ? window.innerWidth - width - 15 : sidebarShown + 12;
    const y = position.startsWith("bottom") ? window.innerHeight - height - 15 : toolbarHeight() + 12;
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
    const zoom = (settingsRef.current.appZoom || 1);
    const width = Math.min(rendered.width, 425);
    const { left, top } = tooltipPosition(current, width, rendered.height);
    void overlayShow(overlayLabel("tooltip"), "tooltip", {
      x: Math.round(left * zoom), y: Math.round(top * zoom), width: Math.round(width * zoom), height: Math.round(rendered.height * zoom),
    }, false, zoom);
  };
  const showRenderedTooltipRef = useRef(showRenderedTooltip);
  showRenderedTooltipRef.current = showRenderedTooltip;

  // Context menu: drawn on the full-window "menu" overlay above the pages.
  const menuOpen = !!menuSpec;
  const menuWasOpen = useRef(false);
  // Resizing the window closes a menu (its layer was sized to the old window).
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenu(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [menuOpen]);
  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.menu);
    if (menuOpen) {
      menuWasOpen.current = true;
      void overlayShow(overlayLabel("menu"), "menu", overlayBounds("menu"), true, (settings.appZoom || 1));
      return;
    }
    void overlayHide(overlayLabel("menu"));
    if (menuWasOpen.current) { menuWasOpen.current = false; void focusChrome(); }
  }, [menuSpec]);

  const toastsVisible = cornerToasts.length > 0;
  const modalId = modalToast?.id ?? null;
  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.modal);
    // Focused, so Enter and Esc reach the dialog.
    if (modalId) { void overlayShow(overlayLabel("modal"), "modal", overlayBounds("modal"), true, (settings.appZoom || 1)); return; }
    void overlayHide(overlayLabel("modal")).then(() => {
      // Hand the keyboard back to the page the dialog covered.
      const id = activeIdRef.current;
      if (surfaceRef.current === "browser" && createdViews.current.has(id)) void activateView(id, tabsRef.current.map((tab) => tab.id), true);
    });
  }, [modalId]);
  useEffect(() => {
    if (!isTauri() || !modalId) return;
    const place = () => void overlayPlace(overlayLabel("modal"), overlayBounds("modal"));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [modalId, overlayTheme, overlayVarsKey, settings.appZoom, sidebarShown, find.open]);
  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.toasts);
    if (toastsVisible) void overlayShow(overlayLabel("toasts"), "toasts", overlayBounds("toasts"), false, (settings.appZoom || 1));
    else void overlayHide(overlayLabel("toasts"));
  }, [toastsVisible]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.toasts);
    if (toastsVisible) void overlayPlace(overlayLabel("toasts"), overlayBounds("toasts"));
  }, [cornerToasts, downloads, overlayTheme, overlayVarsKey, settings.toastPosition, overlaySizes.toasts?.height, settings.appZoom, sidebarShown]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.siteinfo);
    if (siteInfoOpen) void overlayShow(overlayLabel("siteinfo"), "siteinfo", overlayBounds("siteinfo"), true, (settings.appZoom || 1));
    else void overlayHide(overlayLabel("siteinfo"));
  }, [siteInfoOpen, siteInfoSession]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.siteinfo);
    if (siteInfoOpen) void overlayPlace(overlayLabel("siteinfo"), overlayBounds("siteinfo"));
  }, [sitePermissions, activeTab?.certError, overlayTheme, overlayVarsKey, overlaySizes.siteinfo?.height, settings.appZoom, sidebarShown]);

  const loginsVisible = !!loginsMenu && loginsMenu.items.length > 0;
  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.logins);
    if (loginsVisible) void overlayShow(overlayLabel("logins"), "logins", overlayBounds("logins"), false, (settings.appZoom || 1));
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
    if (suggestVisible) void overlayShow(overlayLabel("suggest"), "suggest", overlayBounds("suggest"), false, (settings.appZoom || 1));
    else void overlayHide(overlayLabel("suggest"));
  }, [suggestVisible]);

  useEffect(() => {
    if (!isTauri()) return;
    void emitEvent(OVERLAY_EVENTS.state, overlayStateRef.current.suggest);
    if (suggestVisible) void overlayPlace(overlayLabel("suggest"), overlayBounds("suggest"));
  }, [suggestions, selectedSuggestion, suggestAnchor, overlayTheme, overlayVarsKey, overlaySizes.suggest?.height, settings.appZoom, sidebarShown]);

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
    if (action.kind === "toasts" && action.type === "resolve-check") resolveCheck(action.check, action.keep, action.remember);
    if (action.kind === "toasts" && action.type === "prompt") answerPrompt(action.toast, action.choice);
    if (action.kind === "toasts" && action.type === "hover") holdToast(action.id, action.hovering);
    if (action.kind === "toasts" && action.type === "show-downloads") setSurface("downloads");
    if (action.kind === "menu" && action.type === "pick") runMenuItem(action.id);
    if (action.kind === "menu" && action.type === "close") setMenu(null);
    if (action.kind === "toasts" && action.type === "pause-download") {
      const download = downloadsRef.current.find((item) => item.id === action.id);
      if (download) togglePauseDownload(download);
    }
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
    // Warm the frequent overlays off-screen so the first suggestion/toast/tooltip appears instantly.
    const offscreen = { x: -4000, y: -4000, width: 10, height: 10 };
    void (async () => {
      // Only the frequent overlays; the rest are created when first shown (see RARE_OVERLAYS).
      // The menu layer is kept ready too, so a right-click shows its menu at once.
      for (const kind of ["toasts", "suggest", "tooltip", "menu"] as OverlayKind[]) {
        await overlayShow(overlayLabel(kind), kind, offscreen, false, (settingsRef.current.appZoom || 1));
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
        && !tab.keepActive
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

  useEffect(() => { void setChromeZoom((settings.appZoom || 1)); }, [settings.appZoom]);

  useEffect(() => {
    void setPrivacyOptions({ httpsOnly: settings.httpsOnly, blockPopups: settings.blockPopups, trackingPrevention: settings.trackingPrevention });
  }, [settings.blockPopups, settings.httpsOnly, settings.trackingPrevention]);

  useEffect(() => { void setDownloadAsk(settings.downloadAsk).catch(() => undefined); }, [settings.downloadAsk]);

  // Closing a window. With other windows still open, this window's tabs go
  // with it; closing the last one quits Sleet, keeping its tabs for next time
  // and running "Clear when Sleet closes".
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async () => {
      const others = (await listWindows()).filter((item) => item.label !== WINDOW_LABEL);
      if (others.length > 0) {
        forgetSession(WINDOW_LABEL);
        await kvFlush();
        return;
      }
      const { clearHistoryOnExit, clearSiteDataOnExit } = settingsRef.current;
      const work: Promise<unknown>[] = [kvFlush()];
      if (clearHistoryOnExit) work.push(store.historyClear());
      if (clearSiteDataOnExit) work.push(clearSiteData(["cookies", "cache", "storage"]));
      await Promise.race([Promise.allSettled(work), new Promise((resolve) => window.setTimeout(resolve, 4000))]);
    }).then((unlisten) => { stop = unlisten; });
    return () => stop?.();
  }, []);

  // The engine's own menu (Back, Reload, Inspect…) never shows on Sleet's interface;
  // text fields keep it for cut, copy and paste.
  useEffect(() => {
    const block = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']")) event.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  // ---- Windows
  // The main window brings back the windows open when Sleet last closed.
  useEffect(() => {
    if (!IS_MAIN_WINDOW) return;
    windowsToReopen().forEach((label) => void openWindow({ label }).catch(() => undefined));
  }, []);

  // The window title follows the active tab (taskbar, and "Move to window" in other windows).
  const windowTitle = activeTab ? `${activeTab.private ? "Private · " : ""}${activeTab.title || pageTitle(activeTab.url)} — Sleet` : "Sleet";
  useEffect(() => {
    document.title = windowTitle;
    if (isTauri()) void getCurrentWindow().setTitle(windowTitle).catch(() => undefined);
  }, [windowTitle]);

  // Other windows, for "Move to window" (refreshed whenever this window comes forward or one opens/closes).
  useEffect(() => {
    if (!isTauri()) return;
    const refresh = () => void listWindows().then((all) => setOtherWindows(all.filter((item) => item.label !== WINDOW_LABEL)));
    refresh();
    window.addEventListener("focus", refresh);
    const stop = listenEvent("sleet-windows-changed", refresh);
    return () => { window.removeEventListener("focus", refresh); void stop.then((fn) => fn()); };
  }, []);

  /** A tab dragged out of the sidebar: onto another Sleet window, or into a new one where it was dropped. */
  const tearOffTab = useCallback(async (id: string, screenX: number, screenY: number) => {
    const scale = window.devicePixelRatio || 1;
    const [x, y] = [screenX * scale, screenY * scale];
    const target = await windowAt(x, y);
    if (target) { void moveTabsToOtherWindow([id], target); return; }
    if (tabsRef.current.length < 2) return;
    // Put the new window's sidebar under the pointer.
    void moveTabsToOtherWindow([id], null, [Math.max(0, x - 120 * scale), Math.max(0, y - 90 * scale)]);
  }, [moveTabsToOtherWindow]);

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
  /**
   * The bookmark a tab belongs to: the one it was opened from (it stays tied
   * while you browse within the site, e.g. YouTube home → a video), else one
   * for the exact page.
   */
  const tabBookmark = (tab: BrowserTab | undefined, tree = bookmarks): Bookmark | undefined => {
    if (!tab || isHomeUrl(tab.url) || tab.private) return undefined;
    const tied = tab.bookmarkId ? findBookmark(tree, tab.bookmarkId)?.node : undefined;
    return (tied?.kind === "link" ? tied : undefined) ?? findByUrl(tree, tab.url);
  };
  const activeBookmark = tabBookmark(activeTab);

  /** Adds or removes a bookmark for a tab (Ctrl+D / the star). */
  const toggleTabBookmark = (tab: BrowserTab | undefined) => {
    if (!tab || isHomeUrl(tab.url) || tab.private) return;
    const existing = tabBookmark(tab);
    if (existing) {
      setBookmarks((tree) => removeBookmark(tree, existing.id));
      setTabs((items) => items.map((item) => item.bookmarkId === existing.id ? { ...item, bookmarkId: undefined } : item));
      showMessage(`Removed “${existing.title}” from bookmarks`);
      return;
    }
    const created: Bookmark = { id: makeBookmarkId(), kind: "link", title: tab.title || pageTitle(tab.url), url: tab.url };
    // Never add the same page twice, even if the star is clicked again before the list updates.
    setBookmarks((tree) => findByUrl(tree, tab.url) ? tree : insertBookmark(tree, created));
    setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, bookmarkId: created.id } : item));
  };

  // Tabs tied to a bookmark that's gone (removed elsewhere) drop the tie.
  useEffect(() => {
    setTabs((items) => items.some((tab) => tab.bookmarkId && !findBookmark(bookmarks, tab.bookmarkId))
      ? items.map((tab) => tab.bookmarkId && !findBookmark(bookmarks, tab.bookmarkId) ? { ...tab, bookmarkId: undefined } : tab)
      : items);
  }, [bookmarks, setTabs]);
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
  const showMenu = (x: number, y: number, items: MenuEntry[]) => setMenu({ x, y, items });

  const tabMenu = (tab: BrowserTab, index: number): MenuEntry[] => {
    const sound = audio[tab.id];
    const isHome = isHomeUrl(tab.url);
    const canDockBeside = tab.id !== activeId && !isHome && !!activeTab && !isHomeUrl(activeTab.url) && surface === "browser";
    const windowName = (other: WindowInfo) => other.title && other.title !== "Sleet" ? `“${other.title.replace(/ — Sleet$/, "")}”` : "Other window";
    return [
      { label: "Reload", key: "r", onSelect: () => reloadTab(tab.id), disabled: isHome },
      { label: "Duplicate", key: "d", onSelect: () => void newTab(tab.url, { nextToActive: tab.id === activeId }), disabled: isHome },
      { label: sound?.muted ? "Unmute tab" : "Mute tab", key: "m", onSelect: () => toggleMute(tab.id), disabled: !createdViews.current.has(tab.id) },
      { label: "Copy link", key: "c", onSelect: () => copyText(tab.url), disabled: isHome },
      { label: tabBookmark(tab) ? "Remove bookmark" : "Bookmark tab", key: "s", onSelect: () => toggleTabBookmark(tab), disabled: isHome || tab.private },
      "separator",
      { label: "Reopen closed tab", key: "z", onSelect: () => void reopenClosedTab(), disabled: closedTabs.current.length === 0 },
      { label: "Group", key: "g", submenu: [
        { label: "New group", key: "n", onSelect: () => groupTabs([tab.id], null) },
        ...tabGroups.filter((group) => group.id !== tab.groupId).map((group) => ({ label: group.name, onSelect: () => groupTabs([tab.id], group.id) })),
        ...(tab.groupId ? ["separator" as const, { label: "Remove from group", key: "x", onSelect: () => ungroupTabs([tab.id]) }] : []),
      ] },
      { label: "Dock", key: "k", disabled: !canDockBeside && !dockedIds.has(tab.id), submenu: [
        { label: "Beside current tab, right", key: "r", disabled: !canDockBeside, onSelect: () => activeTab && dockTabNextTo(tab.id, activeTab.id, "right") },
        { label: "Beside current tab, left", key: "l", disabled: !canDockBeside, onSelect: () => activeTab && dockTabNextTo(tab.id, activeTab.id, "left") },
        { label: "Above current tab", key: "t", disabled: !canDockBeside, onSelect: () => activeTab && dockTabNextTo(tab.id, activeTab.id, "top") },
        { label: "Below current tab", key: "b", disabled: !canDockBeside, onSelect: () => activeTab && dockTabNextTo(tab.id, activeTab.id, "bottom") },
        ...(dockedIds.has(tab.id) ? ["separator" as const, { label: "Undock", key: "u", onSelect: () => undockTab(tab.id) }] : []),
      ] },
      { label: "Move", key: "v", submenu: [
        { label: "Up", key: "k", onSelect: () => reorderTab(tab.id, index - 1), disabled: index === 0 },
        { label: "Down", key: "j", onSelect: () => reorderTab(tab.id, index + 2), disabled: index === tabs.length - 1 },
        "separator",
        { label: "New window", key: "e", onSelect: () => void moveTabsToOtherWindow([tab.id], null), disabled: tabs.length < 2 },
        ...otherWindows.map((other) => ({ label: windowName(other), onSelect: () => void moveTabsToOtherWindow([tab.id], other.label) })),
      ] },
      "separator",
      { label: tab.keepActive ? "Allow tab to sleep" : "Keep tab active", key: "h", onSelect: () => setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, keepActive: item.keepActive ? undefined : true } : item)) },
      { label: "Unload tab", key: "u", onSelect: () => unloadTab(tab.id), disabled: tab.id === activeId || !createdViews.current.has(tab.id) },
      { label: "Close", key: "w", onSelect: () => void closeTab(tab.id) },
      { label: "Close more", key: "o", disabled: tabs.length < 2, submenu: [
        { label: "Other tabs", key: "o", onSelect: () => void closeTabs(tabs.filter((item) => item.id !== tab.id).map((item) => item.id)), disabled: tabs.length < 2 },
        { label: "Tabs above", key: "a", onSelect: () => void closeTabs(tabs.slice(0, index).map((item) => item.id)), disabled: index === 0 },
        { label: "Tabs below", key: "b", onSelect: () => void closeTabs(tabs.slice(index + 1).map((item) => item.id)), disabled: index === tabs.length - 1 },
      ] },
    ];
  };

  /** Right-click on the sidebar's empty space. */
  const sidebarMenu = (): MenuEntry[] => {
    const anyOpen = tabGroups.some((group) => !group.collapsed);
    return [
      { label: "New tab", key: "t", onSelect: () => void newTab(undefined, { focusAddress: true }) },
      { label: "New private tab", key: "p", onSelect: () => void newTab(undefined, { private: true, focusAddress: true }) },
      { label: "New window", key: "n", onSelect: newWindow },
      { label: "Reopen closed tab", key: "z", onSelect: () => void reopenClosedTab(), disabled: closedTabs.current.length === 0 },
      ...(tabGroups.length > 0 ? [
        "separator" as const,
        { label: anyOpen ? "Collapse all groups" : "Expand all groups", key: "c", onSelect: () => setTabGroups((groups) => groups.map((group) => ({ ...group, collapsed: anyOpen }))) },
      ] : []),
      "separator",
      { label: bookmarksCollapsed ? "Show bookmarks" : "Fold bookmarks", key: "b", onSelect: () => setBookmarksCollapsed((collapsed) => !collapsed) },
      { label: "Hide sidebar", key: "h", onSelect: () => setSidebarHidden(true) },
    ];
  };

  const groupMenu = (group: TabGroup): MenuEntry[] => {
    const members = tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.id);
    return [
      { label: "New tab in group", key: "n", onSelect: () => {
        void newTab(undefined, { focusAddress: true }).then((id) => groupTabs([id], group.id));
      } },
      { label: "Edit…", key: "e", onSelect: () => setEditingGroup(group.id) },
      { label: group.collapsed ? "Expand" : "Collapse", key: "c", onSelect: () => updateGroup(group.id, { collapsed: !group.collapsed }) },
      "separator",
      { label: "Ungroup", key: "u", onSelect: () => ungroupTabs(members) },
      { label: "Close group", key: "w", danger: true, onSelect: () => void closeTabs(members) },
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

  const downloadMenu = (download: DownloadItem): MenuEntry[] => {
    const extension = extensionOf(download.filename);
    const autoOpen = canAutoOpen(extension)
      ? [{ label: settings.autoOpenTypes.includes(extension) ? `Stop always opening .${extension} files` : `Always open .${extension} files`, key: "l", onSelect: () => toggleAutoOpen(download) }]
      : [];
    return [
    { label: "Open file", key: "o", onSelect: () => openDownload(download), disabled: download.status !== "complete" },
    ...(download.status === "active" ? [{ label: download.paused ? "Resume" : "Pause", key: "p", onSelect: () => togglePauseDownload(download) }] : []),
    { label: "Cancel download", key: "x", onSelect: () => cancelDownload(download), disabled: download.status !== "active" },
    { label: "Show in folder", key: "f", onSelect: () => revealDownload(download), disabled: download.status !== "complete" },
    ...autoOpen,
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
  };
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
    if (command === "toggle-sidebar") { setSidebarHidden((hidden) => !hidden); return true; }
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
  // Back/Forward work if the page's own history can move, or Sleet's saved history for the tab can
  // (the same two sources goHistory uses, in the same order).
  const enginePageHistory = activeTab && createdViews.current.has(activeTab.id) && !savedHistoryTabs.current.has(activeTab.id) && !isHomeUrl(activeTab.url)
    ? pageHistory[activeTab.id] : undefined;
  const canGoBack = !!enginePageHistory?.back || !!neighbour(activeTab?.nav, true);
  const canGoForward = !!enginePageHistory?.forward || !!neighbour(activeTab?.nav, false);
  const activeLoading = !!activeTab && loadingTabs.has(activeTab.id) && !activeIsHome;

  const searchName = SEARCH_ENGINES[settings.searchEngine]?.name ?? "the web";
  const zoomShown = activeTab && !activeIsHome && activeTab.zoom !== undefined ? activeTab.zoom : undefined;

  return (
    <div className={`app-shell ${immersive ? "is-immersive" : ""} ${sidebarHidden ? "is-sidebar-hidden" : ""}`} style={{ "--sidebar": `${sidebarWidth}px` } as CSSProperties}>
      <TabSidebar
        bookmarksCollapsed={bookmarksCollapsed}
        onToggleBookmarks={() => setBookmarksCollapsed((collapsed) => !collapsed)}
        bookmarkCount={allLinks(bookmarks).length}
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
            onContextMenu={(x, y, bookmark) => showMenu(x, y, bookmarkMenu(bookmark))}
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
        onTearOffTab={(id, x, y) => void tearOffTab(id, x, y)}
        groups={tabGroups}
        editingGroup={editingGroup}
        onToggleGroup={(id) => { const group = tabGroups.find((item) => item.id === id); if (group) updateGroup(id, { collapsed: !group.collapsed }); }}
        onRenameGroup={(id, name) => { if (name?.trim()) updateGroup(id, { name: name.trim() }); setEditingGroup(null); }}
        onGroupColor={(id, color) => updateGroup(id, { color })}
        onGroupWith={(tabId, targetId) => {
          // Into the other tab's group, or a new group for the two of them.
          const target = tabsRef.current.find((tab) => tab.id === targetId);
          if (target?.groupId) groupTabs([tabId], target.groupId);
          else groupTabs([targetId, tabId], null);
        }}
        onEditGroup={setEditingGroup}
        dockedIds={dockedIds}
        onDockDrag={(id, x, y) => { if (id) dockDragMove(id, "sidebar", x, y); else dockDragLeave(); }}
        onDockDrop={(x, y) => dockDragEnd(x, y)}
        groupMenu={groupMenu}
        sidebarMenu={sidebarMenu}
        onBookmarkTab={(id) => {
          const tab = tabsRef.current.find((item) => item.id === id);
          if (tab && !tab.private && !isHomeUrl(tab.url) && !tabBookmark(tab)) toggleTabBookmark(tab);
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
        onContextMenu={(x, y, items) => showMenu(x, y, items)}
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
        onHideSidebar={() => setSidebarHidden(true)}
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
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          sidebarHidden={sidebarHidden}
          onShowSidebar={() => setSidebarHidden(false)}
          downloads={downloads}
          onOpenDownloads={() => setSurface("downloads")}
          onAction={(action) => {
            if (action === "back" || action === "forward") void goHistory(action === "back");
            else if (action === "stop") { if (activeTab) stopTab(activeTab.id); }
            else if (activeTab) reloadTab(activeTab.id);
          }}
          onMore={() => void openPalette()}
          suggestions={suggestions}
          selectedSuggestion={selectedSuggestion}
          onAddressInput={(text) => { if (text !== null) setSuggestAnchor("address"); onAddressInput(text); }}
          onSelectSuggestion={setSelectedSuggestion}
          onPickSuggestion={pickSuggestion}
          commandMode={commandMode}
          onOpenSiteInfo={() => (siteInfoOpen ? closeSiteInfo(true) : openSiteInfo())}
          logins={activeTab && !isHomeUrl(activeTab.url) && vault?.exists && (pageLogins.length > 0 || !vaultUsable) ? { count: pageLogins.length, locked: !vaultUsable } : undefined}
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
            {showDockView && activeTab && (
              <DockView
                layout={activeLayout ?? { kind: "pane", tabId: activeTab.id }}
                tabs={tabsById}
                activeId={activeId}
                loading={loadingTabs}
                sleeping={sleeping}
                crashed={crashed}
                dragging={!!dockDrag}
                drop={dockDrag?.target && dockDrag.side ? { target: dockDrag.target, side: dockDrag.side } : null}
                onFocusPane={selectTab}
                onUndock={undockTab}
                onClose={(id) => void closeTab(id)}
                onResize={(path, ratio) => activeLayout && setDocks((layouts) => layouts.map((layout) => layout === activeLayout ? setRatio(layout, path, ratio) : layout))}
                onPaneDrag={startPaneDrag}
              />
            )}
            {!showDockView && surface === "browser" && activeIsHome && (
              <HomeSurface
                searchName={searchName}
                private={!!activeTab?.private}
                onNavigate={(value) => void navigate(value)}
                suggestions={suggestAnchor === "home" ? suggestions : []}
                selectedSuggestion={selectedSuggestion}
                onInput={(text) => {
                  if (text !== null) { setSuggestAnchor("home"); onAddressInput(text); }
                  else if (suggestAnchor === "home") onAddressInput(null);
                }}
                onSelectSuggestion={setSelectedSuggestion}
                onPickSuggestion={pickSuggestion}
              />
            )}
            {!showDockView && surface === "browser" && !activeIsHome && !isTauri() && <BrowserPreview />}
            {!showDockView && surface === "browser" && !activeIsHome && activeAsleep && !activeCrash && <div className="page-waking">Reloading…</div>}
            {!showDockView && surface === "browser" && !activeIsHome && activeCrash && activeTab && (
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
                onPauseDownload={togglePauseDownload}
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
      {!isTauri() && <ContextMenu menu={menuSpec?.spec ?? null} onPick={runMenuItem} onClose={() => setMenu(null)} />}
      {!isTauri() && modalToast && <PromptModal toast={modalToast} onChoice={answerPrompt} onDismiss={dismissToast} />}
      {!isTauri() && <Toasts toasts={cornerToasts} downloads={downloads} onDismiss={(id) => setToasts((items) => items.filter((toast) => toast.id !== id))} onOpenDownload={openDownload} onCancelDownload={cancelDownload} onPauseDownload={togglePauseDownload} onShowDownloads={() => setSurface("downloads")} onResolveCheck={resolveCheck} onPromptChoice={answerPrompt} position={settings.toastPosition} onHover={holdToast} />}
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
  const { left, top } = tooltipPosition(tip, Math.min(425, tip.text.length * 9 + 25), 32);
  return (
    <div className="tooltip is-inline" role="tooltip" style={{ left, top }}>
      {tip.text}
    </div>
  );
}
