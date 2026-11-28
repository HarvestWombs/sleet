import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, Bookmark as BookmarkIcon, Info, LockKeyhole, LockKeyholeOpen, Minus, RotateCw, KeyRound, Search, ShieldAlert, Square, Star, VenetianMask, X, PanelLeftOpen } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { isHomeUrl, simplifyUrl, siteSecurity } from "../lib/browser";
import type { Suggestion } from "../lib/suggest";
import { enterIndexOf, handleAddressKey } from "../lib/addressKeys";
import { isTauri } from "../native/browserEngine";
import { SuggestionList } from "./SuggestionList";
import type { BrowserTab, DownloadItem } from "../types";
import { DownloadIcon } from "./DownloadIcon";
import { shortcutLabel, withShortcut } from "../lib/shortcuts";
import { IconButton } from "./IconButton";

interface ToolbarProps {
  tab?: BrowserTab;
  fullUrls: boolean;
  /** Tab zoom when it differs from the default; shows a reset pill. */
  zoom?: number;
  onResetZoom: () => void;
  /** Whether the current page is pinned to the sidebar (undefined hides the star, e.g. on Home). */
  bookmarked?: boolean;
  onToggleBookmark: () => void;
  /** Whether the page is in the Home page's bookmarks (undefined hides the button). */
  inBookmarks?: boolean;
  onToggleInBookmarks: () => void;
  /** Saved logins for this page: count, or locked. Undefined hides the key. */
  logins?: { count: number; locked: boolean };
  onOpenLogins: () => void;
  onNavigate: (value: string) => void;
  onAction: (action: "back" | "forward" | "reload" | "stop") => void;
  /** The page is loading: Reload becomes Stop and a bar runs under the toolbar. */
  loading?: boolean;
  /** There is somewhere to go back / forward to (otherwise the button is greyed out). */
  canGoBack?: boolean;
  canGoForward?: boolean;
  suggestions: Suggestion[];
  /** Highlighted suggestion; -1 for none. */
  selectedSuggestion: number;
  /** Typed text while editing, or `null` when editing stops. */
  onAddressInput: (text: string | null) => void;
  onSelectSuggestion: (index: number) => void;
  onPickSuggestion: (index: number) => void;
  /** Opens the site information panel (the lock icon). */
  onOpenSiteInfo: () => void;
  /** Ctrl+K: the dropdown lists commands. */
  commandMode?: boolean;
  /** The sidebar is hidden: show buttons to bring it back (and downloads, while running). */
  sidebarHidden?: boolean;
  onShowSidebar?: () => void;
  downloads?: DownloadItem[];
  onOpenDownloads?: () => void;
}

export function Toolbar({ tab, fullUrls, zoom, onResetZoom, bookmarked, onToggleBookmark, inBookmarks, onToggleInBookmarks, logins, onOpenLogins, onNavigate, onAction, suggestions, selectedSuggestion, onAddressInput, onSelectSuggestion, onPickSuggestion, onOpenSiteInfo, commandMode = false, loading = false, canGoBack = true, canGoForward = true, sidebarHidden = false, onShowSidebar, downloads = [], onOpenDownloads }: ToolbarProps) {
  const tabUrl = tab && !isHomeUrl(tab.url) ? tab.url : "";
  const [address, setAddress] = useState(tabUrl);
  const [focused, setFocused] = useState(false);

  useEffect(() => setAddress(tabUrl), [tab?.id, tabUrl]);

  const enterIndex = enterIndexOf(suggestions, selectedSuggestion);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (enterIndex >= 0) onPickSuggestion(enterIndex);
    else onNavigate(address);
    onAddressInput(null);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    handleAddressKey(event, {
      value: address,
      suggestions,
      selected: selectedSuggestion,
      onSelect: onSelectSuggestion,
      onInput: onAddressInput,
      onNavigate,
      onEscape: () => { setAddress(tabUrl); input.blur(); },
    });
  };

  const windowAction = (action: "minimize" | "maximize" | "close") => {
    if (!isTauri()) return;
    const window = getCurrentWindow();
    if (action === "minimize") void window.minimize();
    if (action === "maximize") void window.toggleMaximize();
    if (action === "close") void window.close();
  };

  const shown = focused || fullUrls || address !== (tabUrl) ? address : simplifyUrl(address);

  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar-nav" data-tauri-drag-region>
        {sidebarHidden && <IconButton label={withShortcut("Show sidebar", "toggle-sidebar")} onClick={onShowSidebar}><PanelLeftOpen size={21} /></IconButton>}
        {sidebarHidden && downloads.some((item) => item.status === "active") && <IconButton label="Downloads" onClick={onOpenDownloads}><DownloadIcon downloads={downloads} size={21} /></IconButton>}
        <IconButton label={withShortcut("Back", "back")} disabled={!canGoBack} onClick={() => onAction("back")}><ArrowLeft size={23} /></IconButton>
        <IconButton label={withShortcut("Forward", "forward")} disabled={!canGoForward} onClick={() => onAction("forward")}><ArrowRight size={23} /></IconButton>
        {loading
          ? <IconButton label="Stop loading (Esc)" onClick={() => onAction("stop")}><X size={23} /></IconButton>
          : <IconButton label={withShortcut("Reload", "reload")} onClick={() => onAction("reload")}><RotateCw size={21} /></IconButton>}
      </div>
      <form className="address" onSubmit={submit} data-tauri-drag-region>
        {tab?.private && <span className="address-private" title="Private tab"><VenetianMask size={16} /></span>}
        {(() => {
          const security = siteSecurity(tab);
          const open = () => onOpenSiteInfo();
          if (security === "none") return <span className="address-security"><Search size={18} /></span>;
          const props = { type: "button" as const, onClick: open, onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() };
          if (security === "secure") return <button {...props} className="address-security is-secure" title="Connection is secure. Site information"><LockKeyhole size={18} /></button>;
          if (security === "cert") return <button {...props} className="address-security is-insecure" title="Certificate problem. Site information"><ShieldAlert size={18} /><em>Not secure</em></button>;
          if (security === "insecure") return <button {...props} className="address-security is-insecure" title="Not secure: this page doesn't use HTTPS. Site information"><LockKeyholeOpen size={18} /><em>Not secure</em></button>;
          return <button {...props} className="address-security" title="Local page. Site information"><Info size={18} /></button>;
        })()}
        <input
          value={shown}
          aria-label="Address and search"
          placeholder={commandMode ? "Type a command, search or address" : "Search or enter an address"}
          onChange={(event) => { setAddress(event.target.value); onAddressInput(event.target.value); }}
          onFocus={(event) => { setFocused(true); const input = event.currentTarget; requestAnimationFrame(() => input.select()); }}
          onBlur={() => { setFocused(false); setAddress(tabUrl); onAddressInput(null); }}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          autoComplete="off"
          data-address-input
          spellCheck={false}
        />
        {logins && (
          <button type="button" className={`address-key ${logins.locked ? "is-locked" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={onOpenLogins} title={logins.locked ? "Passwords are locked" : `${logins.count} saved login${logins.count === 1 ? "" : "s"} for this site`}>
            <KeyRound size={18} />{!logins.locked && logins.count > 1 && <em>{logins.count}</em>}
          </button>
        )}
        {inBookmarks !== undefined && (
          <button type="button" className={`address-star address-bookmark ${inBookmarks ? "is-on" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={onToggleInBookmarks} title={withShortcut(inBookmarks ? "Remove from bookmarks" : "Add to bookmarks", "bookmark")} aria-pressed={inBookmarks}>
            <BookmarkIcon size={18} fill={inBookmarks ? "currentColor" : "none"} />
          </button>
        )}
        {bookmarked !== undefined && (
          <button type="button" className={`address-star ${bookmarked ? "is-on" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={onToggleBookmark} title={withShortcut(bookmarked ? "Unpin from the sidebar" : "Pin to the sidebar", "pin")} aria-pressed={bookmarked}>
            <Star size={18} fill={bookmarked ? "currentColor" : "none"} />
          </button>
        )}
        {zoom !== undefined && <button type="button" className="zoom-pill" onClick={onResetZoom} title="Reset zoom (Ctrl+0)">{Math.round(zoom * 100)}%</button>}
        <span className="address-shortcut">{shortcutLabel("address")}</span>
        {!isTauri() && (focused || commandMode) && (
          <div className="suggestions-anchor">
            <SuggestionList items={suggestions} selected={selectedSuggestion} onPick={onPickSuggestion} onHover={onSelectSuggestion} />
          </div>
        )}
      </form>
      <div className="toolbar-actions" data-tauri-drag-region>
        <div className="window-controls">
          <button aria-label="Minimize" onClick={() => windowAction("minimize")}><Minus size={18} /></button>
          <button aria-label="Maximize" onClick={() => windowAction("maximize")}><Square size={14} /></button>
          <button className="window-close" aria-label="Close" onClick={() => windowAction("close")}><X size={18} /></button>
        </div>
      </div>
      {loading && <div className="load-bar" aria-hidden="true" />}
    </header>
  );
}
