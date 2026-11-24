import { kvGetJson, kvSetJson } from "./kv";

/**
 * Favicons by host, remembered from tabs (never from private tabs) so history,
 * suggestions and the downloads list can show them too.
 */
const KEY = "sleet.favicons";
const MAX = 300;
let icons: Record<string, string> | null = null;
const listeners = new Set<() => void>();

const load = () => (icons ??= kvGetJson<Record<string, string>>(KEY, {}));
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

export function faviconFor(url: string): string | undefined {
  const host = hostOf(url);
  return host ? load()[host] : undefined;
}

export function rememberFavicon(url: string, icon: string) {
  const host = hostOf(url);
  if (!host || load()[host] === icon) return;
  const next = { ...load(), [host]: icon };
  const hosts = Object.keys(next);
  if (hosts.length > MAX) hosts.slice(0, hosts.length - MAX).forEach((old) => delete next[old]);
  icons = next;
  kvSetJson(KEY, next);
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
