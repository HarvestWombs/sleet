import { kvGetJson, kvSetJson, kvSubscribe } from "./kv";

/**
 * Favicons by host, remembered from tabs (never from private tabs) so history,
 * suggestions and the downloads list can show them too.
 */
const KEY = "sleet.favicons";
/** Hosts whose remembered icon is the site's large one (never replaced by a 16px icon). */
const SHARP_KEY = "sleet.favicons-sharp";
const MAX = 300;
/** Stored icon size: crisp at the largest place icons are drawn, on 2× screens too. */
export const ICON_EDGE = 64;
let icons: Record<string, string> | null = null;
let sharpHosts: Record<string, true> | null = null;
const listeners = new Set<() => void>();
// Another window saved icons: read them again rather than overwrite them with this window's copy.
kvSubscribe(KEY, () => { icons = null; listeners.forEach((listener) => listener()); });
kvSubscribe(SHARP_KEY, () => { sharpHosts = null; });

const load = () => (icons ??= kvGetJson<Record<string, string>>(KEY, {}));
const loadSharp = () => (sharpHosts ??= kvGetJson<Record<string, true>>(SHARP_KEY, {}));
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

export function faviconFor(url: string): string | undefined {
  const host = hostOf(url);
  return host ? load()[host] : undefined;
}

/** Whether the remembered icon for this site is its large one. */
export function hasSharpFavicon(url: string): boolean {
  const host = hostOf(url);
  return !!host && !!loadSharp()[host] && !!load()[host];
}

export function rememberFavicon(url: string, icon: string, sharp = false) {
  const host = hostOf(url);
  if (!host) return;
  // A small engine icon never replaces a site's large one.
  if (!sharp && loadSharp()[host] && load()[host]) return;
  const sharpChanged = sharp !== !!loadSharp()[host];
  if (load()[host] === icon && !sharpChanged) return;
  const next = { ...load(), [host]: icon };
  const hosts = Object.keys(next);
  const dropped = hosts.length > MAX ? hosts.slice(0, hosts.length - MAX) : [];
  dropped.forEach((old) => delete next[old]);
  icons = next;
  kvSetJson(KEY, next);
  if (sharpChanged || dropped.length > 0) {
    const nextSharp = { ...loadSharp() };
    if (sharp) nextSharp[host] = true; else delete nextSharp[host];
    dropped.forEach((old) => delete nextSharp[old]);
    sharpHosts = nextSharp;
    kvSetJson(SHARP_KEY, nextSharp);
  }
  listeners.forEach((listener) => listener());
}

/** Adds many icons at once (bookmark import), keyed by host. Existing icons are kept. */
export function rememberFavicons(byHost: Record<string, string>) {
  const current = load();
  const fresh = Object.entries(byHost).filter(([host]) => !current[host]);
  if (fresh.length === 0) return;
  const next = { ...current, ...Object.fromEntries(fresh) };
  const hosts = Object.keys(next);
  if (hosts.length > MAX * 2) hosts.slice(0, hosts.length - MAX * 2).forEach((old) => delete next[old]);
  icons = next;
  kvSetJson(KEY, next);
  listeners.forEach((listener) => listener());
}

export function onFaviconsChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Shrinks a large icon (an apple-touch-icon is often 180px, manifest icons
 * 512px) to ICON_EDGE so saved tabs and the icon store stay small. SVG and
 * icons already small enough are kept as they are.
 */
export function shrinkIcon(dataUrl: string, edge = ICON_EDGE): Promise<string> {
  if (dataUrl.startsWith("data:image/svg")) return Promise.resolve(dataUrl);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const size = Math.max(image.naturalWidth, image.naturalHeight);
      if (!size || size <= edge) { resolve(dataUrl); return; }
      const scale = edge / size;
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = edge;
      canvas.height = edge;
      const context = canvas.getContext("2d");
      if (!context) { resolve(dataUrl); return; }
      context.imageSmoothingQuality = "high";
      context.drawImage(image, (edge - width) / 2, (edge - height) / 2, width, height);
      try { resolve(canvas.toDataURL("image/png")); } catch { resolve(dataUrl); }
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}
