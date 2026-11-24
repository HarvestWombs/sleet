import { KeyRound, Lock, Settings2, Sparkles } from "lucide-react";
import { SiteIcon } from "./SiteIcon";

/** One row in the fill dropdown. Passwords are never part of it. */
export interface LoginItem {
  key: string;
  kind: "login" | "generate" | "unlock" | "manage";
  /** Vault entry id (logins). */
  id?: string;
  title: string;
  subtitle?: string;
  origin?: string;
}

/** Dropdown under a login field (or the address-bar key) to pick what to fill. */
export function LoginsMenu({ items, onPick, variant = "inline" }: { items: LoginItem[]; onPick: (item: LoginItem) => void; variant?: "inline" | "overlay" }) {
  if (items.length === 0) return null;
  return (
    <div className={`logins-menu ${variant === "overlay" ? "is-overlay" : ""}`} role="listbox" aria-label="Saved logins">
      {items.map((item) => (
        <button
          key={item.key}
          role="option"
          aria-selected={false}
          className={`logins-item is-${item.kind}`}
          // mousedown: the page field loses focus as the pointer goes down.
          onMouseDown={(event) => { event.preventDefault(); onPick(item); }}
        >
          <span className="logins-icon">
            {item.kind === "login" ? <SiteIcon url={item.origin} title={item.title} className="bm-icon" />
              : item.kind === "generate" ? <Sparkles size={14} />
              : item.kind === "unlock" ? <Lock size={14} />
              : item.kind === "manage" ? <Settings2 size={14} /> : <KeyRound size={14} />}
          </span>
          <span className="logins-copy"><strong>{item.title}</strong>{item.subtitle && <small>{item.subtitle}</small>}</span>
        </button>
      ))}
    </div>
  );
}
