import { Plus, Search, SlidersHorizontal, VenetianMask } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { GROUP_TINTS, type Settings } from "../lib/settings";
import { enterIndexOf, handleAddressKey } from "../lib/addressKeys";
import type { Suggestion } from "../lib/suggest";
import { isTauri } from "../native/browserEngine";
import { SuggestionList } from "./SuggestionList";
import { SleetLogo } from "./SleetLogo";
import { shortcutLabel } from "../lib/shortcuts";

interface HomeSurfaceProps {
  searchName: string;
  /** Private tab: explain what is and isn't kept. */
  private?: boolean;
  onNavigate: (value: string) => void;
  /** The same suggestions as the address bar (sites, history, searches, commands). */
  suggestions: Suggestion[];
  selectedSuggestion: number;
  /** Typed text, or `null` when editing stops. */
  onInput: (text: string | null) => void;
  onSelectSuggestion: (index: number) => void;
  onPickSuggestion: (index: number) => void;
  /** Bookmarks, shown below the search box. */
  bookmarks?: ReactNode;
  /** The Home page's appearance settings, changed from its Customize panel. */
  appearance?: HomeAppearance;
  onAppearance?: (patch: Partial<HomeAppearance>) => void;
  /** Makes an empty bookmark group (the New group button, next to Customize). */
  onAddGroup?: () => void;
  /** Development builds only: fills the board with example bookmarks to try it out. */
  onAddExamples?: () => void;
}

type HomeAppearance = Pick<Settings, "homeTileSize" | "homeGroupTint" | "homeShowLabels" | "homeShowBookmarks" | "homeShowGreeting" | "homeShowHints">;

/** The Home page's Customize button and panel: what shows and how big. */
function HomeCustomize({ appearance, onChange, onAddExamples }: { appearance: HomeAppearance; onChange: (patch: Partial<HomeAppearance>) => void; onAddExamples?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", close); };
  }, [open]);
  const toggle = (key: keyof HomeAppearance, label: string) => (
    <label className="home-customize-row">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={!!appearance[key]} aria-label={label} className={`toggle ${appearance[key] ? "is-on" : ""}`} onClick={() => onChange({ [key]: !appearance[key] })}><i /></button>
    </label>
  );
  return (
    <div className="home-customize" ref={ref}>
      <button type="button" className={`home-customize-button ${open ? "is-open" : ""}`} onClick={() => setOpen((value) => !value)} aria-expanded={open} title="Customize the Home page">
        <SlidersHorizontal size={17} /><span>Customize</span>
      </button>
      {open && (
        <div className="home-customize-panel" role="dialog" aria-label="Customize the Home page">
          <strong>Home page</strong>
          {toggle("homeShowGreeting", "Greeting and clock")}
          {toggle("homeShowHints", "Keyboard hints")}
          {toggle("homeShowBookmarks", "Bookmarks")}
          {toggle("homeShowLabels", "Names under bookmarks")}
          <label className="home-customize-row">
            <span>Bookmark size</span>
            <select className="settings-select" value={appearance.homeTileSize} onChange={(event) => onChange({ homeTileSize: Number(event.target.value) })}>
              {[[48, "Small"], [64, "Medium"], [80, "Large"], [96, "Extra large"]].map(([size, label]) => <option key={size} value={size}>{label}</option>)}
            </select>
          </label>
          <label className="home-customize-row">
            <span>Group background</span>
            <select className="settings-select" value={appearance.homeGroupTint} onChange={(event) => onChange({ homeGroupTint: event.target.value as HomeAppearance["homeGroupTint"] })}>
              {GROUP_TINTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          {import.meta.env.DEV && onAddExamples && <button type="button" className="home-customize-dev" onClick={onAddExamples}>Add example bookmarks (development build)</button>}
        </div>
      )}
    </div>
  );
}

const greetingFor = (hour: number) => (hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

/**
 * Sleet's built-in home screen (sleet://home). Rendered by the chrome, so it
 * needs no page webview. Its search box works like the address bar.
 */
export function HomeSurface({ searchName, private: isPrivate = false, onNavigate, suggestions, selectedSuggestion, onInput, onSelectSuggestion, onPickSuggestion, bookmarks, appearance, onAppearance, onAddGroup, onAddExamples }: HomeSurfaceProps) {
  const showGreeting = appearance?.homeShowGreeting ?? true;
  const showHints = appearance?.homeShowHints ?? true;
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const index = enterIndexOf(suggestions, selectedSuggestion);
    if (index >= 0) onPickSuggestion(index);
    else if (query.trim()) onNavigate(query);
    onInput(null);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <main className={`home-surface ${isPrivate ? "is-private" : ""}`}>
      {/* Pinned to the top left of the visible page: scrolling, window size and board size never move it. */}
      {appearance && onAppearance && (
        <div className="home-customize-dock">
          <div className="home-customize-row-top">
          <HomeCustomize appearance={appearance} onChange={onAppearance} onAddExamples={onAddExamples} />
          {onAddGroup && bookmarks && (
            <button type="button" className="home-customize-button home-new-group" onClick={onAddGroup} title="Add an empty bookmark group (or right-click empty grid: New group here)">
              <Plus size={17} /><span>New group</span>
            </button>
          )}
          </div>
        </div>
      )}
      <div className={`home-inner ${bookmarks ? "has-bookmarks" : ""} ${showGreeting || isPrivate ? "" : "is-compact"}`}>
        {(isPrivate || showGreeting) && (
          <>
            {isPrivate
              ? <div className="home-mark" aria-hidden="true"><VenetianMask size={28} /></div>
              : <SleetLogo size={60} className="home-logo" />}
            <p className="home-time">{clock.format(now)} · {day.format(now)}</p>
            <h1>{isPrivate ? "Private tab" : greetingFor(now.getHours())}</h1>
          </>
        )}
        {isPrivate && (
          <p className="home-private-note">
            Pages you visit here aren’t saved to history, and cookies and site data are deleted when you close your last private tab.
            Downloads are kept. Your network, employer or internet provider can still see where you go.
          </p>
        )}
        <form className="home-search" onSubmit={submit} role="search">
          <Search size={21} />
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); onInput(event.target.value); }}
            onFocus={() => { setFocused(true); if (query) onInput(query); }}
            onBlur={() => { setFocused(false); onInput(null); }}
            onKeyDown={(event) => {
              const input = event.currentTarget;
              handleAddressKey(event, {
                value: query,
                suggestions,
                selected: selectedSuggestion,
                onSelect: onSelectSuggestion,
                onInput,
                onNavigate,
                onEscape: () => { setQuery(""); input.blur(); },
              });
            }}
            placeholder={`Search ${searchName} or enter an address`}
            aria-label="Search or enter an address"
            aria-autocomplete="list"
            aria-expanded={focused && suggestions.length > 0}
            autoComplete="off"
            spellCheck={false}
            data-home-search
          />
          <kbd>↵</kbd>
          {!isTauri() && focused && (
            <div className="suggestions-anchor is-home">
              <SuggestionList items={suggestions} selected={selectedSuggestion} onPick={onPickSuggestion} onHover={onSelectSuggestion} />
            </div>
          )}
        </form>
        {showHints && (
          <p className="home-hint">
            {([["palette", "commands"], ["address", "address bar"], ["bookmark-list", "bookmarks"]] as const)
              .filter(([action]) => shortcutLabel(action))
              .map(([action, label], index) => <span key={action}>{index > 0 && "· "}<kbd>{shortcutLabel(action)}</kbd> {label}</span>)}
          </p>
        )}
      </div>
      {/* Outside .home-inner: the board uses the window's whole width. */}
      {bookmarks}
    </main>
  );
}
