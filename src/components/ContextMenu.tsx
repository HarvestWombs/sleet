import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | {
      label: string;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** Single key that picks this item while the menu is open. */
      key?: string;
    }
  | "separator";

export interface MenuRequest {
  x: number;
  y: number;
  items: MenuEntry[];
  /** Keep the menu inside this horizontal range (e.g. the sidebar, which no page covers). */
  maxX?: number;
}

interface ContextMenuProps {
  menu: MenuRequest | null;
  onClose: () => void;
}

const MARGIN = 6;

/** HTML context menu for Sleet's own lists (tabs, history, downloads). */
export function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width?: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) { setPosition(null); return; }
    const right = menu.maxX ?? window.innerWidth;
    const width = Math.min(ref.current.offsetWidth, right - MARGIN * 2);
    const height = ref.current.offsetHeight;
    setPosition({
      left: Math.max(MARGIN, Math.min(menu.x, right - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(menu.y, window.innerHeight - height - MARGIN)),
      width: menu.maxX ? width : undefined,
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const hit = menu.items.find((item) => item !== "separator" && !item.disabled && item.key?.toLowerCase() === event.key.toLowerCase());
        if (hit && hit !== "separator") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          hit.onSelect();
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
      }
      if (event.type === "pointerdown" && ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: position?.left ?? menu.x, top: position?.top ?? menu.y, width: position?.width, visibility: position ? "visible" : "hidden" }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item, index) => item === "separator" ? (
        <div className="context-separator" key={`separator-${index}`} role="separator" />
      ) : (
        <button
          key={item.label}
          role="menuitem"
          aria-keyshortcuts={item.key?.toUpperCase()}
          className={item.danger ? "is-danger" : ""}
          disabled={item.disabled}
          onClick={() => { onClose(); item.onSelect(); }}
        >
          <span>{item.label}</span>
          {item.key && <span className="context-key" aria-hidden="true">{item.key.toUpperCase()}</span>}
        </button>
      ))}
    </div>
  );
}
