export type Surface = "browser" | "history" | "downloads" | "settings";
export type SidebarMode = "tabs" | "history" | "downloads";

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  /** Page zoom chosen for this tab; falls back to the default zoom setting. */
  zoom?: number;
  /**
   * Addresses visited in this tab, kept by Sleet so back/forward still work
   * after the tab's page is unloaded (or Sleet restarts).
   */
  nav?: TabNav;
  /** The site's icon as a PNG data URL. */
  favicon?: string;
  /** Bookmark this tab was opened from (its tile shows when the tab is open). */
  bookmarkId?: string;
  /** Private tab: InPrivate profile, no history, never saved to disk. */
  private?: boolean;
  /** Certificate problem on the current site (cleared when the site changes). */
  certError?: { host: string; problem: string };
}

export interface TabNav {
  stack: string[];
  index: number;
}

export interface UrlEvent {
  label: string;
  url: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  visitedAt: number;
}

export interface DownloadItem {
  id: string;
  filename: string;
  url: string;
  path?: string;
  status: "active" | "complete" | "failed" | "cancelled";
  startedAt: number;
  received?: number;
  total?: number;
  /** Why a failed download failed, in plain words. */
  error?: string;
}

/** How a download ended, keyed by the address it started from. */
export interface DownloadStateEvent {
  label: string;
  url: string;
  state: "complete" | "cancelled" | "failed";
  path?: string | null;
  reason?: string | null;
}

/** Windows flagged a file type; Sleet asks to keep or delete it. */
export interface DownloadCheckEvent {
  checkId: number;
  label: string;
  path: string;
  extension: string;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NavigationEvent {
  label: string;
  url: string;
}

export interface TitleEvent {
  label: string;
  title: string;
}

export interface DownloadEvent {
  label: string;
  url: string;
  path?: string;
  success?: boolean;
  phase: "requested" | "finished";
}

export interface DownloadProgressEvent {
  label: string;
  url: string;
  received: number;
  total?: number;
}

export interface AudioEvent {
  label: string;
  playing: boolean;
  muted: boolean;
}

export interface AudioState {
  playing: boolean;
  muted: boolean;
}

/** A Sleet item chosen from a page's context menu. */
export interface ContextEvent {
  label: string;
  action: "open-tab" | "open-background-tab" | "open-image-tab" | "search-image";
  url: string;
}

export interface PopupBlockedEvent {
  label: string;
  url: string;
  origin: string;
}

export interface PermissionRequestEvent {
  requestId: number;
  label: string;
  origin: string;
  kind: string;
  private: boolean;
}

export interface CertErrorEvent {
  label: string;
  url: string;
  host: string;
  problem: string;
}

export interface HttpsFailedEvent {
  label: string;
  httpUrl: string;
  host: string;
}

export interface FaviconEvent {
  label: string;
  icon?: string | null;
}
