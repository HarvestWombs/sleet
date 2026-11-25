import type { PromptChoice, Toast } from "../components/Toasts";
import type { Suggestion } from "./suggest";
import type { LoginItem } from "../components/LoginsMenu";
import type { MenuSpec } from "../components/ContextMenu";
import type { PermissionChoice, SiteInfo } from "../components/SiteInfoPanel";
import type { DownloadCheckEvent, DownloadItem } from "../types";
import { IS_MAIN_WINDOW, WINDOW_LABEL } from "./windows";

/**
 * Overlays are small Sleet webviews stacked above page webviews, so UI can
 * draw on top of page content. Each loads this bundle with `?overlay=<kind>`
 * and talks to the main chrome through these events. Every window has its
 * own overlays, and the event names carry the window so they don't mix.
 */
export type OverlayKind = "toasts" | "suggest" | "siteinfo" | "tooltip" | "logins" | "modal" | "menu";
export const overlayLabel = (kind: OverlayKind) => (IS_MAIN_WINDOW ? `overlay-${kind}` : `overlay-${kind}-${WINDOW_LABEL}`);

export const OVERLAY_EVENTS = {
  /** Main → overlay: what to render. */
  state: `sleet-overlay-state:${WINDOW_LABEL}`,
  /** Overlay → main: mounted and listening, send state. */
  ready: `sleet-overlay-ready:${WINDOW_LABEL}`,
  /** Overlay → main: rendered content size in CSS pixels. */
  size: `sleet-overlay-size:${WINDOW_LABEL}`,
  /** Overlay → main: the user did something. */
  action: `sleet-overlay-action:${WINDOW_LABEL}`,
  /** Overlay → main: finished drawing state `seq` at this size (tooltips wait for it). */
  rendered: `sleet-overlay-rendered:${WINDOW_LABEL}`,
} as const;

/** Every overlay gets the theme and text-size variables so it matches the chrome. */
interface OverlayLook { theme: string; vars?: Record<string, string> }
export interface ToastOverlayState extends OverlayLook { kind: "toasts"; theme: string; toasts: Toast[]; downloads: DownloadItem[] }
export interface SuggestOverlayState extends OverlayLook { kind: "suggest"; theme: string; items: Suggestion[]; selected: number }
export interface SiteInfoOverlayState extends OverlayLook { kind: "siteinfo"; theme: string; open: boolean; session: number; info: SiteInfo | null }
export interface TooltipOverlayState extends OverlayLook { kind: "tooltip"; text: string; seq: number }
export interface OverlayRendered { kind: OverlayKind; seq: number; width: number; height: number }
export interface LoginsOverlayState extends OverlayLook { kind: "logins"; items: LoginItem[] }
/** A centered dialog (password prompts) covering the page area with a dimmed backdrop. */
export interface ModalOverlayState extends OverlayLook { kind: "modal"; toast: Toast | null }
/** A context menu, on a transparent layer covering the whole window (clicking off it closes it). */
export interface MenuOverlayState extends OverlayLook { kind: "menu"; menu: MenuSpec | null }
export type OverlayState = ToastOverlayState | SuggestOverlayState | SiteInfoOverlayState | TooltipOverlayState | LoginsOverlayState | ModalOverlayState | MenuOverlayState;

export interface OverlaySize { kind: OverlayKind; width: number; height: number }

export type OverlayAction =
  | { kind: "toasts"; type: "dismiss"; id: string }
  | { kind: "toasts"; type: "open-download"; id: string }
  | { kind: "toasts"; type: "cancel-download"; id: string }
  | { kind: "toasts"; type: "pause-download"; id: string }
  | { kind: "toasts"; type: "show-downloads" }  | { kind: "toasts"; type: "resolve-check"; check: DownloadCheckEvent; keep: boolean; remember?: boolean }
  | { kind: "toasts"; type: "prompt"; toast: Toast; choice: PromptChoice }
  | { kind: "toasts"; type: "hover"; id: string; hovering: boolean }
  /** Carries the row itself: the address field blurs (clearing the list) before this arrives. */
  | { kind: "suggest"; type: "pick"; item: Suggestion }
  | { kind: "suggest"; type: "hover"; index: number }
  | { kind: "siteinfo"; type: "close"; refocusPage: boolean }
  | { kind: "siteinfo"; type: "set-permission"; permission: string; choice: PermissionChoice }
  | { kind: "siteinfo"; type: "clear-site" }
  | { kind: "siteinfo"; type: "allow-certificate" }
  | { kind: "siteinfo"; type: "open-settings" }
  | { kind: "logins"; type: "pick"; item: LoginItem }
  | { kind: "menu"; type: "pick"; id: string }
  | { kind: "menu"; type: "close" };

export const overlayKindFromLocation = (): OverlayKind | null => {
  const kind = new URLSearchParams(window.location.search).get("overlay");
  return kind === "toasts" || kind === "suggest" || kind === "siteinfo" || kind === "tooltip" || kind === "logins" || kind === "modal" || kind === "menu" ? kind : null;
};
