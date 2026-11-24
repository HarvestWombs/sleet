import type { Settings } from "./settings";

/** Parts of Sleet whose text size can be set on their own. */
export const TEXT_AREAS = [
  { id: "sidebar", label: "Sidebar", detail: "Tabs, history and downloads lists" },
  { id: "toolbar", label: "Toolbar and address bar" },
  { id: "dropdown", label: "Address suggestions and commands" },
  { id: "toasts", label: "Notifications" },
  { id: "pages", label: "Sleet pages", detail: "Home, settings, history and downloads pages" },
  { id: "popups", label: "Menus, panels and tooltips" },
] as const;

export type TextArea = (typeof TEXT_AREAS)[number]["id"];
export const TEXT_SIZES = [0.85, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
export const TOAST_POSITIONS = [
  ["top-left", "Top left"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
] as const;
export type ToastPosition = (typeof TOAST_POSITIONS)[number][0];

/**
 * CSS variables for text sizing: `--app-text` scales everything, and each
 * `--text-<area>` multiplies it for one part of the UI (see styles.css).
 * Also sent to overlay webviews so they match.
 */
export function appearanceVars(settings: Pick<Settings, "textSize" | "textAreas">): Record<string, string> {
  const vars: Record<string, string> = { "--app-text": String(settings.textSize || 1) };
  for (const area of TEXT_AREAS) vars[`--text-${area.id}`] = String(settings.textAreas?.[area.id] ?? 1);
  return vars;
}

export function applyVars(vars: Record<string, string>) {
  const root = document.documentElement;
  Object.entries(vars).forEach(([name, value]) => root.style.setProperty(name, value));
}
