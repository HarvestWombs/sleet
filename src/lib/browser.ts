export const START_URL = "https://en.m.wikipedia.org/wiki/Main_Page";
/** Built-in home screen, rendered by the Sleet chrome instead of a page webview. */
export const HOME_URL = "sleet://home";
/** Home address before the rename to Sleet; tabs saved with it still open Home. */
const OLD_HOME_URL = "horizon://home";
export const isHomeUrl = (value: string | undefined) => {
  if (!value) return true;
  const trimmed = value.replace(/\/+$/, "");
  return trimmed === HOME_URL || trimmed === OLD_HOME_URL;
};

export interface AddressOptions {
  searchUrl?: string;
  preferHttps?: boolean;
}

const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i;

export function normalizeAddress(input: string, options: AddressOptions = {}): string {
  const { searchUrl = "https://duckduckgo.com/?q=", preferHttps = false } = options;
  const value = input.trim();
  if (!value || isHomeUrl(value)) return HOME_URL;

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    const rest = value.replace(/^http:\/\//i, "");
    if (preferHttps && /^http:\/\//i.test(value) && !LOCAL_HOST.test(rest)) return `https://${rest}`;
    return value;
  }
  if (LOCAL_HOST.test(value)) return `http://${value}`;
  if (/^[^\s]+\.[a-z]{2,}([/:?#].*)?$/i.test(value)) return `https://${value}`;

  return `${searchUrl}${encodeURIComponent(value)}`;
}

export function displayHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

/** Address shown while the bar is not focused when full URLs are off. */
export function simplifyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return value;
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return value;
  }
}

export function pageTitle(value: string): string {
  if (isHomeUrl(value)) return "Home";
  const host = displayHost(value);
  if (host === "en.m.wikipedia.org") return "Wikipedia";
  return host || "New tab";
}

export type Security = "secure" | "insecure" | "local" | "none";

/** Connection security as shown by the address bar icon. */
export function securityOf(value: string | undefined): Security {
  if (!value || isHomeUrl(value)) return "none";
  try {
    const url = new URL(value);
    const host = url.hostname;
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
    if (url.protocol === "https:") return "secure";
    if (url.protocol === "http:") return local ? "local" : "insecure";
    return "local";
  } catch {
    return "none";
  }
}

/** Security shown for a tab: a certificate problem on the current host wins. */
export function siteSecurity(tab: { url: string; certError?: { host: string } } | undefined): Security | "cert" {
  if (!tab) return "none";
  if (tab.certError) {
    try { if (new URL(tab.url).hostname === tab.certError.host) return "cert"; } catch { /* fall through */ }
  }
  return securityOf(tab.url);
}
