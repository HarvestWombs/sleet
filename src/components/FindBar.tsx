import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { FindResult } from "../native/browserEngine";
import { IconButton } from "./IconButton";

interface FindBarProps {
  query: string;
  result: FindResult;
  /** Bumped to focus and select the field again (Ctrl+F while open). */
  focusSignal: number;
  onQuery: (query: string) => void;
  onStep: (backwards: boolean) => void;
  onClose: () => void;
}

/** Ctrl+F: a strip above the page. Enter / Shift+Enter step through matches, Esc closes. */
export function FindBar({ query, result, focusSignal, onQuery, onStep, onClose }: FindBarProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  }, [focusSignal]);

  const count = !query ? "" : result.count === 0 ? "No matches" : `${result.index + 1} of ${result.count}${result.count >= 5000 ? "+" : ""}`;
  return (
    <div className="find-bar" role="search">
      <Search size={18} className="find-icon" />
      <input
        ref={input}
        value={query}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        autoComplete="off"
        className={query && result.count === 0 ? "is-missing" : ""}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); onStep(event.shiftKey); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        }}
      />
      <span className="find-count" aria-live="polite">{count}</span>
      <IconButton label="Previous match (Shift+Enter)" onClick={() => onStep(true)} disabled={!result.count}><ChevronUp size={20} /></IconButton>
      <IconButton label="Next match (Enter)" onClick={() => onStep(false)} disabled={!result.count}><ChevronDown size={20} /></IconButton>
      <IconButton label="Close (Esc)" onClick={onClose}><X size={19} /></IconButton>
    </div>
  );
}
