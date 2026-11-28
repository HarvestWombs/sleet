/**
 * Keyboard shortcuts: every action Sleet has a key for, its default keys, and
 * the user's own (Settings → Keyboard shortcuts). Alt+letter keys are the
 * easy-to-remember defaults for things used a lot; the usual browser keys
 * (Ctrl+T, Ctrl+W…) work too. Pages get the same table (see lib.rs), so a
 * shortcut works whether Sleet or a page has the keyboard.
 *
 * Bindings are written "Ctrl+Shift+N", "Alt+S", "F5": modifiers in the order
 * Ctrl, Alt, Shift, then the key. Cmd on a Mac counts as Ctrl.
 */
export interface ShortcutAction {
  /** The command it runs (App's runShortcut, and what pages send). */
  id: string;
  label: string;
  group: "Tabs" | "Page" | "Bookmarks" | "Sleet";
  defaults: string[];
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: "new-tab", label: "New tab", group: "Tabs", defaults: ["Ctrl+T"] },
  { id: "new-private-tab", label: "New private tab", group: "Tabs", defaults: ["Alt+N", "Ctrl+Shift+N"] },
  { id: "new-window", label: "New window", group: "Tabs", defaults: ["Ctrl+N"] },
  { id: "close-tab", label: "Close tab", group: "Tabs", defaults: ["Ctrl+W"] },
  { id: "reopen-tab", label: "Reopen closed tab", group: "Tabs", defaults: ["Alt+Z", "Ctrl+Shift+T"] },
  { id: "next-tab", label: "Next tab", group: "Tabs", defaults: ["Ctrl+Tab", "Ctrl+PageDown"] },
  { id: "previous-tab", label: "Previous tab", group: "Tabs", defaults: ["Ctrl+Shift+Tab", "Ctrl+PageUp"] },
  { id: "group-tab", label: "Put tab in a new group", group: "Tabs", defaults: ["Alt+G"] },
  { id: "keep-active", label: "Keep tab active (or let it sleep)", group: "Tabs", defaults: ["Alt+K"] },

  { id: "reload", label: "Reload", group: "Page", defaults: ["Ctrl+R", "F5", "Ctrl+Shift+R"] },
  { id: "back", label: "Back", group: "Page", defaults: ["Alt+Left"] },
  { id: "forward", label: "Forward", group: "Page", defaults: ["Alt+Right"] },
  { id: "find", label: "Find in page", group: "Page", defaults: ["Ctrl+F"] },
  { id: "find-next", label: "Find next", group: "Page", defaults: ["F3", "Ctrl+G"] },
  { id: "find-previous", label: "Find previous", group: "Page", defaults: ["Shift+F3", "Ctrl+Shift+G"] },
  { id: "print", label: "Print", group: "Page", defaults: ["Ctrl+P"] },
  { id: "zoom-in", label: "Zoom in", group: "Page", defaults: ["Ctrl+=", "Ctrl+Shift+=", "Ctrl+Plus"] },
  { id: "zoom-out", label: "Zoom out", group: "Page", defaults: ["Ctrl+-"] },
  { id: "zoom-reset", label: "Reset zoom", group: "Page", defaults: ["Ctrl+0"] },
  { id: "fullscreen", label: "Full screen", group: "Page", defaults: ["F11"] },

  { id: "bookmark", label: "Bookmark this page", group: "Bookmarks", defaults: ["Alt+B", "Ctrl+D"] },
  { id: "pin", label: "Pin site to the sidebar", group: "Bookmarks", defaults: ["Alt+P", "Ctrl+Shift+D"] },
  { id: "bookmark-list", label: "Open a bookmark (list in the address bar)", group: "Bookmarks", defaults: ["Alt+D"] },

  { id: "address", label: "Address bar", group: "Sleet", defaults: ["Ctrl+L"] },
  { id: "palette", label: "Commands", group: "Sleet", defaults: ["Ctrl+K"] },
  { id: "toggle-sidebar", label: "Show or hide the sidebar", group: "Sleet", defaults: ["Alt+S", "Ctrl+Shift+S"] },
  { id: "history", label: "History", group: "Sleet", defaults: ["Alt+H", "Ctrl+Y"] },
  { id: "downloads", label: "Downloads", group: "Sleet", defaults: ["Alt+J", "Ctrl+J"] },
  { id: "settings", label: "Settings", group: "Sleet", defaults: ["Ctrl+,"] },
  { id: "clear-data", label: "Clear browsing data", group: "Sleet", defaults: ["Ctrl+Shift+Delete"] },
];

/** Keys every text field needs; they can't be shortcuts. */
export const RESERVED = new Set(["Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+Left", "Ctrl+Right", "Ctrl+Backspace", "Ctrl+Delete"]);

const NAMED_CODES: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Backquote: "`", Minus: "-", Equal: "=", NumpadAdd: "Plus", NumpadSubtract: "-",
  NumpadMultiply: "*", NumpadDivide: "/", NumpadDecimal: ".", ArrowLeft: "Left", ArrowRight: "Right",
  ArrowUp: "Up", ArrowDown: "Down", Escape: "Esc", Space: "Space", Tab: "Tab", Enter: "Enter",
  NumpadEnter: "Enter", Delete: "Delete", Backspace: "Backspace", Insert: "Insert", Home: "Home",
  End: "End", PageUp: "PageUp", PageDown: "PageDown",
};

/** The key's name, by its position on the keyboard (so Shift and layouts don't change it). */
export function keyName(code: string, key: string): string | null {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code) || ["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(key)) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (NAMED_CODES[code]) return NAMED_CODES[code];
  return key.length === 1 ? key.toUpperCase() : key || null;
}

/** "Ctrl+Shift+N" for a key press; `null` for a modifier on its own. */
export function bindingFromEvent(event: { code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const name = keyName(event.code, event.key);
  if (!name) return null;
  return [event.ctrlKey || event.metaKey ? "Ctrl" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", name].filter(Boolean).join("+");
}

/**
 * Whether a key can be a shortcut: it needs Ctrl or Alt (plain keys are for
 * typing), except function keys; text-editing keys are kept for text fields.
 */
export function usableBinding(binding: string): boolean {
  if (RESERVED.has(binding)) return false;
  const parts = binding.split("+");
  const key = parts[parts.length - 1];
  return parts.includes("Ctrl") || parts.includes("Alt") || /^F\d{1,2}$/.test(key);
}

/** Each action's keys: the user's where they changed them, the defaults elsewhere. */
export function resolveShortcuts(overrides: Record<string, string[]> = {}): Record<string, string[]> {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action.id, overrides[action.id] ?? action.defaults]));
}

/** Key → action, for looking up a key press (the first action listing a key wins). */
export function bindingTable(resolved: Record<string, string[]>): Record<string, string> {
  const table: Record<string, string> = {};
  for (const action of SHORTCUT_ACTIONS) {
    for (const binding of resolved[action.id] ?? []) {
      if (!(binding in table)) table[binding] = action.id;
    }
  }
  return table;
}

/**
 * Gives `binding` to `actionId`, taking it away from any other action that had
 * it. Returns the new overrides (only actions that differ from their defaults).
 */
export function assignBinding(overrides: Record<string, string[]>, actionId: string, binding: string): Record<string, string[]> {
  const resolved = resolveShortcuts(overrides);
  const next: Record<string, string[]> = {};
  for (const action of SHORTCUT_ACTIONS) {
    let keys = resolved[action.id].filter((key) => key !== binding);
    if (action.id === actionId && !keys.includes(binding)) keys = [...keys, binding];
    next[action.id] = keys;
  }
  return onlyChanged(next);
}

export function removeBinding(overrides: Record<string, string[]>, actionId: string, binding: string): Record<string, string[]> {
  const resolved = resolveShortcuts(overrides);
  return onlyChanged({ ...resolved, [actionId]: resolved[actionId].filter((key) => key !== binding) });
}

export function resetAction(overrides: Record<string, string[]>, actionId: string): Record<string, string[]> {
  const next = { ...overrides };
  delete next[actionId];
  // Its default keys come back: other actions holding one of them let it go.
  const action = SHORTCUT_ACTIONS.find((entry) => entry.id === actionId);
  let result: Record<string, string[]> = next;
  for (const binding of action?.defaults ?? []) result = assignBinding(result, actionId, binding);
  return result;
}

/** The action already using a key, if any (other than `except`). */
export function conflictFor(overrides: Record<string, string[]>, binding: string, except?: string): ShortcutAction | undefined {
  const resolved = resolveShortcuts(overrides);
  return SHORTCUT_ACTIONS.find((action) => action.id !== except && resolved[action.id].includes(binding));
}

function onlyChanged(resolved: Record<string, string[]>): Record<string, string[]> {
  const changed: Record<string, string[]> = {};
  for (const action of SHORTCUT_ACTIONS) {
    const keys = resolved[action.id] ?? action.defaults;
    if (keys.length !== action.defaults.length || keys.some((key, index) => key !== action.defaults[index])) changed[action.id] = keys;
  }
  return changed;
}

/** "Ctrl Shift N", as shown on keycaps. */
export const displayBinding = (binding: string) => binding.split("+").join(" ");

// The keys in use right now (set by App), for tooltips and menus.
let active: Record<string, string[]> = resolveShortcuts();
export function setActiveShortcuts(resolved: Record<string, string[]>) { active = resolved; }
/** The first key for an action, ready to show ("Alt S"), or undefined if it has none. */
export function shortcutLabel(actionId: string): string | undefined {
  const binding = active[actionId]?.[0];
  return binding ? displayBinding(binding) : undefined;
}
/** "Back (Alt+Left)" for tooltips. */
export const withShortcut = (label: string, actionId: string) => {
  const binding = active[actionId]?.[0];
  return binding ? `${label} (${binding})` : label;
};
