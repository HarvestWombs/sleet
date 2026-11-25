import { Search, VenetianMask } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { enterIndexOf, handleAddressKey } from "../lib/addressKeys";
import type { Suggestion } from "../lib/suggest";
import { isTauri } from "../native/browserEngine";
import { SuggestionList } from "./SuggestionList";

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
}

const greetingFor = (hour: number) => (hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

/**
 * Sleet's built-in home screen (sleet://home). Rendered by the chrome, so it
 * needs no page webview. Its search box works like the address bar.
 */
export function HomeSurface({ searchName, private: isPrivate = false, onNavigate, suggestions, selectedSuggestion, onInput, onSelectSuggestion, onPickSuggestion }: HomeSurfaceProps) {
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
      <div className="home-inner">
        <div className="home-mark" aria-hidden="true">{isPrivate ? <VenetianMask size={28} /> : "S"}</div>
        <p className="home-time">{clock.format(now)} · {day.format(now)}</p>
        <h1>{isPrivate ? "Private tab" : greetingFor(now.getHours())}</h1>
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
        <p className="home-hint"><kbd>Ctrl K</kbd> commands · <kbd>Ctrl L</kbd> address bar · <kbd>Ctrl T</kbd> new tab</p>
      </div>
    </main>
  );
}
