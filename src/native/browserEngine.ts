import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AudioEvent,
  CertErrorEvent,
  FaviconEvent,
  HttpsFailedEvent,
  PermissionRequestEvent,
  PopupBlockedEvent,
  ContextEvent,
  DownloadCheckEvent,
  DownloadEvent,
  DownloadProgressEvent,
  DownloadStateEvent,
  NavigationEvent,
  UrlEvent,
  TitleEvent,
  ViewBounds,
} from "../types";

export const isTauri = () => "__TAURI_INTERNALS__" in window;
export const viewLabel = (tabId: string) => `page-${tabId}`;

export interface ViewOptions {
  zoom?: number;
  userAgent?: string;
  /** InPrivate profile: nothing is kept after the last private tab closes. */
  private?: boolean;
}

export async function createView(tabId: string, url: string, bounds: ViewBounds, options: ViewOptions = {}) {
  if (!isTauri()) return;
  await invoke("create_browser_view", {
    label: viewLabel(tabId),
    url,
    bounds,
    zoom: options.zoom ?? null,
    userAgent: options.userAgent || null,
    private: options.private ?? false,
  });
}

export async function closeView(tabId: string) {
  if (!isTauri()) return;
  await invoke("close_browser_view", { label: viewLabel(tabId) });
}

export async function navigateView(tabId: string, url: string) {
  if (!isTauri()) return;
  await invoke("navigate_browser_view", { label: viewLabel(tabId), url });
}

export async function activateView(tabId: string | null, tabIds: string[], focus = false) {
  if (!isTauri()) return;
  await invoke("activate_browser_view", {
    activeLabel: tabId ? viewLabel(tabId) : null,
    labels: tabIds.map(viewLabel),
    focus,
  });
}

export async function resizeView(tabId: string, bounds: ViewBounds) {
  if (!isTauri()) return;
  await invoke("resize_browser_view", { label: viewLabel(tabId), bounds });
}

export async function browserAction(
  tabId: string,
  action: "back" | "forward" | "reload" | "devtools",
) {
  if (!isTauri()) return;
  await invoke("browser_action", { label: viewLabel(tabId), action });
}

/** Pulls keyboard focus out of the page webview into the Sleet chrome. */
export async function focusChrome() {
  if (!isTauri()) return;
  await invoke("focus_chrome").catch(() => undefined);
}

export async function setViewsZoom(tabIds: string[], zoom: number) {
  if (!isTauri()) return;
  await invoke("set_views_zoom", { labels: tabIds.map(viewLabel), zoom });
}

/** Snapshot of a page as an object URL (caller revokes it). */
export async function captureView(tabId: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const bytes = await invoke<ArrayBuffer>("capture_view", { label: viewLabel(tabId) });
    return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
  } catch {
    return null;
  }
}

/**
 * Back/forward through the page's own history. Resolves `false` when the page
 * had nowhere to go, so the caller can use the tab's saved history instead.
 */
export async function stepHistory(tabId: string, back: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  try { return await invoke<boolean>("step_history", { label: viewLabel(tabId), back }); } catch { return false; }
}

/** Shows (creating on first use) an overlay webview drawn above page webviews. */
export async function overlayShow(label: string, kind: string, bounds: ViewBounds, focus: boolean, zoom: number) {
  if (!isTauri()) return;
  await invoke("overlay_show", { label, kind, bounds, focus, zoom }).catch(() => undefined);
}

/** Repositions a shown overlay without raising or focusing it. */
export async function overlayPlace(label: string, bounds: ViewBounds) {
  if (!isTauri()) return;
  await invoke("overlay_place", { label, bounds }).catch(() => undefined);
}

export async function overlayHide(label: string) {
  if (!isTauri()) return;
  await invoke("overlay_hide", { label }).catch(() => undefined);
}

export { emit as emitEvent, listen as listenEvent };

/** Cancels a running download (id is `label:start-url`). */
export async function cancelDownload(id: string) {
  if (!isTauri()) return;
  await invoke("cancel_download", { id });
}

/** Answers Windows' "this file type can harm your device" check for one file. */
export async function resolveDownloadCheck(checkId: number, keep: boolean) {
  if (!isTauri()) return;
  await invoke("resolve_download_check", { checkId, keep });
}

export async function setViewMuted(tabId: string, muted: boolean) {
  if (!isTauri()) return;
  await invoke("set_view_muted", { label: viewLabel(tabId), muted });
}

export async function setChromeZoom(zoom: number) {
  if (!isTauri()) return;
  await invoke("set_chrome_zoom", { zoom });
}

export async function setDownloadDir(path: string) {
  if (!isTauri()) return;
  await invoke("set_download_dir", { path: path.trim() || null });
}

export type SiteDataKind = "cookies" | "cache" | "storage" | "autofill";

/**
 * Clears site data of the given kinds, optionally only data stored since
 * `since` (epoch ms). Sleet's own state lives in SQLite, so this can't touch it.
 */
export async function clearSiteData(kinds: SiteDataKind[], since?: number) {
  if (!isTauri() || kinds.length === 0) return;
  await invoke("clear_site_data", { kinds, since: since === undefined ? null : since / 1000 });
}

/** Clears cookies and storage for one site, in that tab's own profile. */
export async function clearOriginData(tabId: string, origin: string) {
  if (!isTauri()) return;
  await invoke("clear_origin_data", { label: viewLabel(tabId), origin });
}

export interface PrivacyOptions {
  httpsOnly: boolean;
  blockPopups: boolean;
  trackingPrevention: "none" | "basic" | "balanced" | "strict";
}

export async function setPrivacyOptions(options: PrivacyOptions) {
  if (!isTauri()) return;
  await invoke("set_privacy_options", { options }).catch(() => undefined);
}

export interface DefaultBrowserStatus { supported: boolean; isDefault: boolean }

export async function defaultBrowserStatus(): Promise<DefaultBrowserStatus> {
  if (!isTauri()) return { supported: false, isDefault: false };
  return invoke<DefaultBrowserStatus>("default_browser_status").catch(() => ({ supported: false, isDefault: false }));
}

/** Registers Sleet as a browser and opens Windows' default apps page to confirm. */
export async function makeDefaultBrowser() {
  if (!isTauri()) return;
  await invoke("make_default_browser");
}

/** Links Sleet was started with (e.g. clicked in another app). */
export async function takeLaunchUrls(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("take_launch_urls").catch(() => []);
}

export async function allowHttp(host: string) {
  if (!isTauri()) return;
  await invoke("allow_http", { host });
}

export async function allowCertificate(host: string) {
  if (!isTauri()) return;
  await invoke("allow_certificate", { host });
}

export async function resolvePermission(requestId: number, allow: boolean, remember: boolean) {
  if (!isTauri()) return;
  await invoke("resolve_permission", { requestId, allow, remember });
}

export interface LoadingEvent { label: string; loading: boolean }
export interface OpenLinkEvent { label: string; url: string; background: boolean }
export interface FullscreenEvent { label: string; fullscreen: boolean }
export interface ExternalLinkEvent { label: string; url: string }
export interface CrashEvent { label: string; kind: "crashed" | "unresponsive" | "engine" }
export interface FindResult { count: number; index: number }
export interface UpdateInfo { configured: boolean; current: string; available: string | null; notes: string | null }

export async function stopLoading(tabId: string) {
  if (!isTauri()) return;
  await invoke("stop_loading", { label: viewLabel(tabId) }).catch(() => undefined);
}

export async function findInPage(tabId: string, query: string, backwards: boolean, restart: boolean): Promise<FindResult> {
  if (!isTauri()) return { count: 0, index: -1 };
  try {
    return await invoke<FindResult>("find_in_page", { label: viewLabel(tabId), query, backwards, restart });
  } catch {
    return { count: 0, index: -1 };
  }
}

export async function findClear(tabId: string) {
  if (!isTauri()) return;
  await invoke("find_clear", { label: viewLabel(tabId) }).catch(() => undefined);
}

export async function printPage(tabId: string) {
  if (!isTauri()) return;
  await invoke("print_page", { label: viewLabel(tabId) });
}

/** Saves the page as a PDF in Downloads and returns its path. */
export async function savePagePdf(tabId: string, title: string): Promise<string> {
  return invoke<string>("save_page_pdf", { label: viewLabel(tabId), title });
}

export async function openExternal(url: string) {
  if (!isTauri()) return;
  await invoke("open_external", { url });
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isTauri()) return { configured: false, current: "dev", available: null, notes: null };
  return invoke<UpdateInfo>("check_for_update");
}

export async function installUpdate() {
  await invoke("install_update");
}

export async function subscribeToBrowserEvents(handlers: {
  onNavigation: (event: NavigationEvent) => void;
  onTitle: (event: TitleEvent) => void;
  onDownload: (event: DownloadEvent) => void;
  onDownloadProgress: (event: DownloadProgressEvent) => void;
  onDownloadState: (event: DownloadStateEvent) => void;
  onDownloadCheck: (event: DownloadCheckEvent) => void;
  onNewTab: (url: string) => void;
  onAudio: (event: AudioEvent) => void;
  onOpenUrls: (urls: string[]) => void;
  onFavicon: (event: FaviconEvent) => void;
  onPopupBlocked: (event: PopupBlockedEvent) => void;
  onPermissionRequest: (event: PermissionRequestEvent) => void;
  onCertError: (event: CertErrorEvent) => void;
  onHttpsFailed: (event: HttpsFailedEvent) => void;
  onUrl: (event: UrlEvent) => void;
  onContext: (event: ContextEvent) => void;
  onCommand: (command: string) => void;
  onLoading: (event: LoadingEvent) => void;
  onOpenLink: (event: OpenLinkEvent) => void;
  onFullscreen: (event: FullscreenEvent) => void;
  onExternalLink: (event: ExternalLinkEvent) => void;
  onCrashed: (event: CrashEvent) => void;
}) {
  if (!isTauri()) return () => undefined;

  const unlisteners: UnlistenFn[] = await Promise.all([
    listen<NavigationEvent>("sleet-navigation", ({ payload }) =>
      handlers.onNavigation(payload),
    ),
    listen<TitleEvent>("sleet-title", ({ payload }) => handlers.onTitle(payload)),
    listen<DownloadEvent>("sleet-download", ({ payload }) =>
      handlers.onDownload(payload),
    ),
    listen<DownloadProgressEvent>("sleet-download-progress", ({ payload }) =>
      handlers.onDownloadProgress(payload),
    ),
    listen<DownloadStateEvent>("sleet-download-state", ({ payload }) => handlers.onDownloadState(payload)),
    listen<DownloadCheckEvent>("sleet-download-check", ({ payload }) => handlers.onDownloadCheck(payload)),
    listen<string>("sleet-new-tab", ({ payload }) => handlers.onNewTab(payload)),
    listen<UrlEvent>("sleet-url", ({ payload }) => handlers.onUrl(payload)),
    listen<PopupBlockedEvent>("sleet-popup-blocked", ({ payload }) => handlers.onPopupBlocked(payload)),
    listen<PermissionRequestEvent>("sleet-permission-request", ({ payload }) => handlers.onPermissionRequest(payload)),
    listen<CertErrorEvent>("sleet-cert-error", ({ payload }) => handlers.onCertError(payload)),
    listen<HttpsFailedEvent>("sleet-https-failed", ({ payload }) => handlers.onHttpsFailed(payload)),
    listen<FaviconEvent>("sleet-favicon", ({ payload }) => handlers.onFavicon(payload)),
    listen<string[]>("sleet-open-urls", ({ payload }) => handlers.onOpenUrls(payload)),
    listen<AudioEvent>("sleet-audio", ({ payload }) => handlers.onAudio(payload)),
    listen<ContextEvent>("sleet-context", ({ payload }) => handlers.onContext(payload)),
    listen<string>("sleet-command", ({ payload }) => handlers.onCommand(payload)),
    listen<LoadingEvent>("sleet-loading", ({ payload }) => handlers.onLoading(payload)),
    listen<OpenLinkEvent>("sleet-open-link", ({ payload }) => handlers.onOpenLink(payload)),
    listen<FullscreenEvent>("sleet-fullscreen", ({ payload }) => handlers.onFullscreen(payload)),
    listen<ExternalLinkEvent>("sleet-external-link", ({ payload }) => handlers.onExternalLink(payload)),
    listen<CrashEvent>("sleet-page-crashed", ({ payload }) => handlers.onCrashed(payload)),
  ]);

  return () => unlisteners.forEach((unlisten) => unlisten());
}
