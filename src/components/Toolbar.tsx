import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowLeft, ArrowRight, Info, LockKeyhole, LockKeyholeOpen, Minus, MoreHorizontal, RotateCw, KeyRound, Search, ShieldAlert, Square, Star, VenetianMask, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { isHomeUrl, simplifyUrl, siteSecurity } from "../lib/browser";
import type { Suggestion } from "../lib/suggest";
import { isTauri } from "../native/browserEngine";
import { SuggestionList } from "./SuggestionList";
import type { BrowserTab } from "../types";
import { IconButton } from "./IconButton";

interface ToolbarProps {
  tab?: BrowserTab;
  fullUrls: boolean;
  /** Tab zoom when it differs from the default; shows a reset pill. */
  zoom?: number;
  onResetZoom: () => void;
  /** Whether the current page is bookmarked (undefined hides the star, e.g. on Home). */
  bookmarked?: boolean;
  onToggleBookmark: () => void;
  /** Saved logins for this page: count, or locked. Undefined hides the key. */
  logins?: { count: number; locked: boolean };
  onOpenLogins: () => void;
  onNavigate: (value: string) => void;
  onAction: (action: "back" | "forward" | "reload" | "stop") => void;
  /** The page is loading: Reload becomes Stop and a bar runs under the toolbar. */
  loading?: boolean;
  onMore: () => void;
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
}

export function Toolbar({ tab, fullUrls, zoom, onResetZoom, bookmarked, onToggleBookmark, logins, onOpenLogins, onNavigate, onAction, onMore, suggestions, selectedSuggestion, onAddressInput, onSelectSuggestion, onPickSuggestion, onOpenSiteInfo, commandMode = false, loading = false }: ToolbarProps) {
  const tabUrl = tab && !isHomeUrl(tab.url) ? tab.url : "";
  const [address, setAddress] = useState(tabUrl);
  const [focused, setFocused] = useState(false);

  useEffect(() => setAddress(tabUrl), [tab?.id, tabUrl]);

  // The row Enter opens: the highlighted one, else a site the typed word starts.
  const enterIndex = selectedSuggestion >= 0 ? selectedSuggestion : suggestions.findIndex((item) => item.autocomplete);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (enterIndex >= 0) onPickSuggestion(enterIndex);
    else onNavigate(address);
    onAddressInput(null);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Classic shortcuts: wrap a bare name as www.<name>.com / .net / .org.
    if (event.key === "Enter" && (event.ctrlKey || event.shiftKey) && !event.altKey) {
      const tld = event.ctrlKey && event.shiftKey ? "org" : event.ctrlKey ? "com" : "net";
      const name = address.trim();
      if (/^[a-z0-9-]+$/i.test(name)) {
        event.preventDefault();
        onAddressInput(null);
        onNavigate(`https://www.${name}.${tld}/`);
        event.currentTarget.blur();
        return;
      }
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const from = selectedSuggestion >= 0 ? selectedSuggestion : step > 0 ? -1 : suggestions.length;
      onSelectSuggestion((from + step + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Escape") {
      if (suggestions.length > 0) { onAddressInput(null); return; }
      setAddress(tabUrl);
      event.currentTarget.blur();
    }
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
        <IconButton label="Back" onClick={() => onAction("back")}><ArrowLeft size={18} /></IconButton>
        <IconButton label="Forward" onClick={() => onAction("forward")}><ArrowRight size={18} /></IconButton>
        {loading
          ? <IconButton label="Stop loading (Esc)" onClick={() => onAction("stop")}><X size={18} /></IconButton>
          : <IconButton label="Reload (Ctrl+R)" onClick={() => onAction("reload")}><RotateCw size={17} /></IconButton>}
      </div>
      <form className="address" onSubmit={submit} data-tauri-drag-region>
        {tab?.private && <span className="address-private" title="Private tab"><VenetianMask size={13} /></span>}
        {(() => {
          const security = siteSecurity(tab);
          const open = () => onOpenSiteInfo();
          if (security === "none") return <span className="address-security"><Search size={14} /></span>;
          const props = { type: "button" as const, onClick: open, onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault() };
          if (security === "secure") return <button {...props} className="address-security is-secure" title="Connection is secure. Site information"><LockKeyhole size={14} /></button>;
          if (security === "cert") return <button {...props} className="address-security is-insecure" title="Certificate problem. Site information"><ShieldAlert size={14} /><em>Not secure</em></button>;
          if (security === "insecure") return <button {...props} className="address-security is-insecure" title="Not secure: this page doesn't use HTTPS. Site information"><LockKeyholeOpen size={14} /><em>Not secure</em></button>;
          return <button {...props} className="address-security" title="Local page. Site information"><Info size={14} /></button>;
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
            <KeyRound size={14} />{!logins.locked && logins.count > 1 && <em>{logins.count}</em>}
          </button>
        )}
        {bookmarked !== undefined && (
          <button type="button" className={`address-star ${bookmarked ? "is-on" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={onToggleBookmark} title={bookmarked ? "Remove bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)"} aria-pressed={bookmarked}>
            <Star size={14} fill={bookmarked ? "currentColor" : "none"} />
          </button>
        )}
        {zoom !== undefined && <button type="button" className="zoom-pill" onClick={onResetZoom} title="Reset zoom (Ctrl+0)">{Math.round(zoom * 100)}%</button>}
        <span className="address-shortcut">Ctrl L</span>
        {!isTauri() && (focused || commandMode) && (
          <div className="suggestions-anchor">
            <SuggestionList items={suggestions} selected={selectedSuggestion} onPick={onPickSuggestion} onHover={onSelectSuggestion} />
          </div>
        )}
      </form>
      <div className="toolbar-actions" data-tauri-drag-region>
        <IconButton label="Command palette (Ctrl+K)" onClick={onMore}><MoreHorizontal size={19} /></IconButton>
        <div className="window-controls">
          <button aria-label="Minimize" onClick={() => windowAction("minimize")}><Minus size={14} /></button>
          <button aria-label="Maximize" onClick={() => windowAction("maximize")}><Square size={11} /></button>
          <button className="window-close" aria-label="Close" onClick={() => windowAction("close")}><X size={14} /></button>
        </div>
      </div>
      {loading && <div className="load-bar" aria-hidden="true" />}
    </header>
  );
}
