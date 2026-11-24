import { CornerDownLeft, Globe, History, Link2, Search } from "lucide-react";
import { commandById } from "../lib/commands";
import type { Suggestion } from "../lib/suggest";

interface SuggestionListProps {
  items: Suggestion[];
  /** Highlighted row; -1 for none. */
  selected: number;
  onPick: (index: number) => void;
  onHover?: (index: number) => void;
  variant?: "inline" | "overlay";
}

const ICONS = { domain: Globe, history: History, search: Search, url: Link2, command: Search };

/** Address bar dropdown. In the desktop app it renders inside an overlay above the page. */
export function SuggestionList({ items, selected, onPick, onHover, variant = "inline" }: SuggestionListProps) {
  if (items.length === 0) return null;
  // The row Enter would open: the highlighted one, else an autocomplete match.
  const enterIndex = selected >= 0 ? selected : items.findIndex((item) => item.autocomplete);
  return (
    <div className={`suggestions ${variant === "overlay" ? "is-overlay" : ""}`} role="listbox" aria-label="Suggestions">
      {items.map((item, index) => {
        const Icon = item.kind === "command" ? commandById(item.commandId)?.icon ?? Search : ICONS[item.kind];
        return (
          <button
            key={`${item.kind}:${item.url}`}
            role="option"
            aria-selected={index === enterIndex}
            className={`suggestion ${index === enterIndex ? "is-selected" : ""}`}
            // mousedown, not click: the address field loses focus as soon as the
            // pointer goes down, which hides the list before a click would land.
            onMouseDown={(event) => { event.preventDefault(); onPick(index); }}
            onMouseEnter={() => onHover?.(index)}
            tabIndex={-1}
          >
            <span className="suggestion-icon">{(item.kind === "domain" || item.kind === "history") && item.icon ? <img src={item.icon} alt="" aria-hidden="true" /> : <Icon size={14} />}</span>
            <span className="suggestion-copy">
              <strong>{item.title}</strong>
              {item.subtitle && <small>{item.subtitle}</small>}
            </span>
            {item.shortcut && index !== enterIndex && <kbd>{item.shortcut}</kbd>}
            {index === enterIndex && <CornerDownLeft size={13} className="suggestion-enter" />}
          </button>
        );
      })}
    </div>
  );
}
