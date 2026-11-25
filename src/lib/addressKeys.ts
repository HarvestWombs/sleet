import type { KeyboardEvent } from "react";
import type { Suggestion } from "./suggest";

/** Shared by every "search or enter an address" box: the address bar and Home's search. */
export interface AddressKeyOptions {
  value: string;
  suggestions: Suggestion[];
  /** Highlighted suggestion; -1 for none. */
  selected: number;
  onSelect: (index: number) => void;
  /** Typed text, or `null` to close the suggestions. */
  onInput: (text: string | null) => void;
  onNavigate: (value: string) => void;
  /** Escape with no suggestions open. */
  onEscape: () => void;
}

/** The row Enter opens: the highlighted one, else a site the typed word autocompletes to. */
export const enterIndexOf = (suggestions: Suggestion[], selected: number) =>
  selected >= 0 ? selected : suggestions.findIndex((item) => item.autocomplete);

/** Arrow keys, Escape, and Ctrl/Shift+Enter (www.<name>.com / .net / .org). */
export function handleAddressKey(event: KeyboardEvent<HTMLInputElement>, options: AddressKeyOptions) {
  const { suggestions, selected } = options;
  if (event.key === "Enter" && (event.ctrlKey || event.shiftKey) && !event.altKey) {
    const tld = event.ctrlKey && event.shiftKey ? "org" : event.ctrlKey ? "com" : "net";
    const name = options.value.trim();
    if (/^[a-z0-9-]+$/i.test(name)) {
      event.preventDefault();
      options.onInput(null);
      options.onNavigate(`https://www.${name}.${tld}/`);
      event.currentTarget.blur();
      return;
    }
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (suggestions.length === 0) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const from = selected >= 0 ? selected : step > 0 ? -1 : suggestions.length;
    options.onSelect((from + step + suggestions.length) % suggestions.length);
    return;
  }
  if (event.key === "Escape") {
    if (suggestions.length > 0) { options.onInput(null); return; }
    options.onEscape();
  }
}
