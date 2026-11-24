import { Download, FileDown, Maximize, Printer, TextSearch, Globe, History, Moon, Plus, RotateCcw, Settings2, Shield, Star, VenetianMask, type LucideIcon } from "lucide-react";

/** Something the address bar can run instead of opening a page. */
export type PaletteCommand =
  | { kind: "navigate"; value: string }
  | { kind: "new-tab" }
  | { kind: "new-private-tab" }
  | { kind: "reopen-tab" }
  | { kind: "bookmark" }
  | { kind: "history" }
  | { kind: "downloads" }
  | { kind: "settings"; section?: string }
  | { kind: "toggle-theme" }
  | { kind: "find" }
  | { kind: "print" }
  | { kind: "save-pdf" }
  | { kind: "fullscreen" };

export interface CommandEntry {
  id: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  shortcut?: string;
  keywords: string;
  command: PaletteCommand;
}

/** Commands offered in the address bar dropdown (Ctrl+K lists them all). */
export const COMMANDS: CommandEntry[] = [
  { id: "new-tab", icon: Plus, title: "Open a new tab", detail: "Start a fresh page", shortcut: "Ctrl T", keywords: "new tab open", command: { kind: "new-tab" } },
  { id: "private-tab", icon: VenetianMask, title: "Open a private tab", detail: "No history; cookies are thrown away when closed", shortcut: "Ctrl Shift N", keywords: "private incognito inprivate tab", command: { kind: "new-private-tab" } },
  { id: "reopen-tab", icon: RotateCcw, title: "Reopen closed tab", detail: "Bring back the tab you closed last", shortcut: "Ctrl Shift W", keywords: "reopen undo closed tab restore", command: { kind: "reopen-tab" } },
  { id: "bookmark", icon: Star, title: "Bookmark this page", detail: "Pin it to the grid at the top of the sidebar", shortcut: "Ctrl D", keywords: "bookmark favorite pin star save", command: { kind: "bookmark" } },
  { id: "find", icon: TextSearch, title: "Find in page", detail: "Search the text of this page", shortcut: "Ctrl F", keywords: "find search text page word", command: { kind: "find" } },
  { id: "print", icon: Printer, title: "Print…", detail: "Print this page or save it with the print dialog", shortcut: "Ctrl P", keywords: "print printer paper", command: { kind: "print" } },
  { id: "save-pdf", icon: FileDown, title: "Save page as PDF", detail: "Saves to your Downloads folder", keywords: "pdf save export print document", command: { kind: "save-pdf" } },
  { id: "fullscreen", icon: Maximize, title: "Full screen", detail: "Hide Sleet's interface; F11 again to leave", shortcut: "F11", keywords: "full screen fullscreen kiosk immersive", command: { kind: "fullscreen" } },
  { id: "import-bookmarks", icon: Star, title: "Import bookmarks", detail: "From another browser or a bookmarks file", keywords: "import bookmarks favorites chrome edge firefox arc html", command: { kind: "settings", section: "bookmarks" } },
  { id: "history", icon: History, title: "Show history", detail: "Recently visited pages", shortcut: "Ctrl Y", keywords: "history visited recent", command: { kind: "history" } },
  { id: "downloads", icon: Download, title: "Show downloads", detail: "Files saved by Sleet", shortcut: "Ctrl J", keywords: "downloads files", command: { kind: "downloads" } },
  { id: "settings", icon: Settings2, title: "Open settings", detail: "Appearance, browsing, privacy, security", shortcut: "Ctrl ,", keywords: "settings preferences options", command: { kind: "settings" } },
  { id: "search-engine", icon: Globe, title: "Change search engine", detail: "Settings › Browsing", keywords: "search engine google duckduckgo bing brave", command: { kind: "settings", section: "browsing" } },
  { id: "privacy", icon: Shield, title: "Open privacy settings", detail: "Clear data, history, tracking prevention", keywords: "privacy clear data cookies history retention tracking", command: { kind: "settings", section: "privacy" } },
  { id: "security", icon: Shield, title: "Open security settings", detail: "HTTPS-only, popups, site permissions", keywords: "security https popups permissions camera microphone", command: { kind: "settings", section: "security" } },
  { id: "theme", icon: Moon, title: "Toggle light / dark theme", detail: "Settings › Appearance", keywords: "theme dark light appearance", command: { kind: "toggle-theme" } },
];

export const commandById = (id: string | undefined) => COMMANDS.find((entry) => entry.id === id);

/** Commands matching typed text; all of them for an empty query. */
export function matchCommands(text: string, limit = COMMANDS.length): CommandEntry[] {
  const query = text.trim().toLowerCase();
  if (!query) return COMMANDS.slice(0, limit);
  return COMMANDS.filter((entry) => `${entry.title} ${entry.keywords}`.toLowerCase().includes(query)).slice(0, limit);
}
