import { Check, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** A menu item as the code that opens a menu writes it. */
export type MenuEntry =
  | {
      label: string;
      /** Runs the item (items with a `submenu` open it instead). */
      onSelect?: () => void;
      /** Opens to the side on hover, click or →. */
      submenu?: MenuEntry[];
      danger?: boolean;
      disabled?: boolean;
      /** An on/off option: shows a check mark when on. */
      checked?: boolean;
      /** Single key that picks this item while its menu is open. */
      key?: string;
    }
  | "separator";

export interface MenuRequest {
  x: number;
  y: number;
  items: MenuEntry[];
}

/**
 * The same menu as plain data, so it can be drawn in an overlay webview above
 * the pages (lib/overlay.ts). `id` names the item when it's picked.
 */
export type MenuSpecItem =
  | { id: string; label: string; key?: string; danger?: boolean; disabled?: boolean; checked?: boolean; submenu?: MenuSpecItem[] }
  | "separator";
export interface MenuSpec { x: number; y: number; items: MenuSpecItem[] }

/** Splits a menu into data to draw and the actions to run, by item id. */
export function toMenuSpec(menu: MenuRequest): { spec: MenuSpec; actions: Map<string, () => void> } {
  const actions = new Map<string, () => void>();
  const convert = (items: MenuEntry[], prefix: string): MenuSpecItem[] => items.map((item, index) => {
    if (item === "separator") return "separator";
    const id = `${prefix}${index}`;
    if (item.onSelect) actions.set(id, item.onSelect);
    return { id, label: item.label, key: item.key, danger: item.danger, disabled: item.disabled, checked: item.checked, submenu: item.submenu ? convert(item.submenu, `${id}.`) : undefined };
  });
  return { spec: { x: menu.x, y: menu.y, items: convert(menu.items, "") }, actions };
}

const MARGIN = 6;
type Placement = { left: number; top: number };

/**
 * Context menu with fly-out submenus. Drawn in a full-window overlay webview
 * in the desktop app, so it is never cut off by a page or the sidebar's edge.
 */
/** `onPick` runs the item and closes the menu; `onClose` closes without picking. */
export function ContextMenu({ menu, onPick, onClose }: { menu: MenuSpec | null; onPick: (id: string) => void; onClose: () => void }) {
  /** Index of the open submenu at each level (`open[0]`: submenu of the root's item). */
  const [open, setOpen] = useState<number[]>([]);
  useEffect(() => { setOpen([]); }, [menu]);

  const pick = (item: Exclude<MenuSpecItem, "separator">, level: number, index: number) => {
    if (item.disabled) return;
    if (item.submenu) { setOpen((current) => [...current.slice(0, level), index]); return; }
    // Picking closes the menu too. One message only: from the overlay, a separate
    // "close" would arrive first and drop the menu before its pick could run.
    onPick(item.id);
  };

  // Keyboard: item keys at the innermost open menu, ← closes a submenu, Esc closes.
  const stateRef = useRef({ menu, open, pick });
  stateRef.current = { menu, open, pick };
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const { menu: current, open: path } = stateRef.current;
      if (!current) return;
      let items = current.items;
      for (const index of path) {
        const item = items[index];
        if (item && item !== "separator" && item.submenu) items = item.submenu;
      }
      if (event.key === "Escape") { event.preventDefault(); if (path.length) setOpen(path.slice(0, -1)); else onClose(); return; }
      if (event.key === "ArrowLeft" && path.length) { event.preventDefault(); setOpen(path.slice(0, -1)); return; }
      const index = items.findIndex((item) => item !== "separator" && !item.disabled && item.key?.toLowerCase() === event.key.toLowerCase());
      if (index >= 0) {
        event.preventDefault();
        stateRef.current.pick(items[index] as Exclude<MenuSpecItem, "separator">, path.length, index);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu, onClose]);

  if (!menu) return null;

  // Each open level is a panel; a submenu sits beside the item that opened it.
  const panels: { items: MenuSpecItem[]; anchor: { x: number; y: number } | { itemOf: number } }[] = [{ items: menu.items, anchor: { x: menu.x, y: menu.y } }];
  let items = menu.items;
  for (const [level, index] of open.entries()) {
    const item = items[index];
    if (!item || item === "separator" || !item.submenu) break;
    panels.push({ items: item.submenu, anchor: { itemOf: level } });
    items = item.submenu;
  }

  return (
    <div className="context-layer" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onContextMenu={(event) => { event.preventDefault(); if (event.target === event.currentTarget) onClose(); }}>
      {panels.map((panel, level) => (
        <MenuPanel
          key={`${level}-${open.slice(0, level).join(".")}`}
          level={level}
          items={panel.items}
          anchor={panel.anchor}
          openIndex={open[level]}
          onHover={(index, hasSubmenu) => setOpen((current) => hasSubmenu ? [...current.slice(0, level), index] : current.slice(0, level))}
          onPick={(item, index) => pick(item, level, index)}
        />
      ))}
    </div>
  );
}

function MenuPanel({ level, items, anchor, openIndex, onHover, onPick }: {
  level: number;
  items: MenuSpecItem[];
  anchor: { x: number; y: number } | { itemOf: number };
  openIndex?: number;
  onHover: (index: number, hasSubmenu: boolean) => void;
  onPick: (item: Exclude<MenuSpecItem, "separator">, index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const { offsetWidth: width, offsetHeight: height } = panel;
    const maxLeft = window.innerWidth - width - MARGIN;
    const maxTop = window.innerHeight - height - MARGIN;
    if ("x" in anchor) {
      setPlace({ left: Math.max(MARGIN, Math.min(anchor.x, maxLeft)), top: Math.max(MARGIN, Math.min(anchor.y, maxTop)) });
      return;
    }
    // Beside the parent item: to its right, or its left when there's no room.
    const parent = document.querySelector<HTMLElement>(`[data-menu-level="${anchor.itemOf}"] [data-open="true"]`)?.getBoundingClientRect();
    const parentPanel = document.querySelector<HTMLElement>(`[data-menu-level="${anchor.itemOf}"]`)?.getBoundingClientRect();
    if (!parent || !parentPanel) return;
    const right = parentPanel.right - 4;
    const left = right + width <= window.innerWidth - MARGIN ? right : Math.max(MARGIN, parentPanel.left - width + 4);
    setPlace({ left, top: Math.max(MARGIN, Math.min(parent.top - 5, maxTop)) });
  }, [anchor, items]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      data-menu-level={level}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? "visible" : "hidden" }}
    >
      {items.map((item, index) => item === "separator" ? (
        <div className="context-separator" key={`separator-${index}`} role="separator" />
      ) : (
        <button
          key={item.id}
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          aria-checked={item.checked}
          aria-haspopup={item.submenu ? "menu" : undefined}
          aria-expanded={item.submenu ? openIndex === index : undefined}
          data-open={item.submenu && openIndex === index ? "true" : undefined}
          aria-keyshortcuts={item.key?.toUpperCase()}
          className={`${item.danger ? "is-danger" : ""} ${item.submenu && openIndex === index ? "is-open" : ""}`}
          disabled={item.disabled}
          // A short pause before switching submenus, so moving the pointer across to one doesn't close it.
          onPointerEnter={() => { window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(() => onHover(index, !!item.submenu && !item.disabled), item.submenu ? 90 : 160); }}
          onPointerLeave={() => window.clearTimeout(hoverTimer.current)}
          onKeyDown={(event) => { if (event.key === "ArrowRight" && item.submenu) { event.preventDefault(); onPick(item, index); } }}
          onClick={() => onPick(item, index)}
        >
          <span>{item.label}</span>
          {item.checked !== undefined && <Check size={15} className={`context-check ${item.checked ? "is-on" : ""}`} aria-hidden="true" />}
          {item.submenu
            ? <ChevronRight size={15} className="context-more" aria-hidden="true" />
            : item.key && <span className="context-key" aria-hidden="true">{item.key.toUpperCase()}</span>}
        </button>
      ))}
    </div>
  );
}
