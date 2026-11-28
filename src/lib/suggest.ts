import type { HistoryEntry } from "../types";

export interface Suggestion {
  /** `bookmark`: from the Alt+D bookmark list. */
  kind: "domain" | "history" | "search" | "url" | "command" | "bookmark";
  title: string;
  subtitle?: string;
  /** Address to open, or the raw query for `search`. */
  url: string;
  /**
   * Enter goes here without arrowing down: the typed word is the start of a
   * known site (typing "youtube" opens youtube.com).
   */
  autocomplete?: boolean;
  /** Site icon (data URL) when Sleet has one. */
  icon?: string;
  /** For `command` rows: which command (see lib/commands.ts). */
  commandId?: string;
  shortcut?: string;
}

/** Well-known sites so a bare name goes to the site before any history exists. */
export const POPULAR_SITES = [
  "youtube.com", "google.com", "github.com", "reddit.com", "wikipedia.org", "x.com", "twitter.com",
  "facebook.com", "instagram.com", "amazon.com", "netflix.com", "twitch.tv", "linkedin.com",
  "stackoverflow.com", "mail.google.com", "outlook.live.com", "discord.com", "open.spotify.com",
  "apple.com", "microsoft.com", "bing.com", "duckduckgo.com", "yahoo.com", "ebay.com", "imdb.com",
  "nytimes.com", "bbc.com", "cnn.com", "espn.com", "pinterest.com", "tiktok.com", "web.whatsapp.com",
  "zoom.us", "dropbox.com", "notion.so", "figma.com", "chatgpt.com", "claude.ai", "openai.com",
  "anthropic.com", "medium.com", "quora.com", "paypal.com", "store.steampowered.com",
  "steamcommunity.com", "epicgames.com", "roblox.com", "archive.org", "news.ycombinator.com",
  "npmjs.com", "crates.io", "docs.rs", "developer.mozilla.org", "rust-lang.org", "python.org",
  "nodejs.org", "vercel.com", "cloudflare.com", "weather.com", "maps.google.com",
  "translate.google.com", "drive.google.com", "docs.google.com", "calendar.google.com",
  "gitlab.com", "bitbucket.org", "duolingo.com", "craigslist.org", "etsy.com", "walmart.com",
  "target.com", "bestbuy.com", "hulu.com", "disneyplus.com", "max.com", "primevideo.com",
  "soundcloud.com", "bandcamp.com", "nexusmods.com", "moddb.com", "itch.io",
];

const MAX_ROWS = 7;
const stripWww = (host: string) => host.replace(/^www\./, "");

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? stripWww(parsed.hostname) : null;
  } catch {
    return null;
  }
}

/**
 * How well a host matches what was typed: 3 = the host starts with it,
 * 2 = a later label starts with it (store.steampowered → "steam"), 0 = no match.
 */
function hostScore(host: string, query: string): number {
  if (host.startsWith(query)) return 3;
  if (host.split(".").some((label) => label.startsWith(query))) return 2;
  return 0;
}

/** True when the input already reads as an address rather than words to search. */
export const looksLikeAddress = (value: string) =>
  /^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^[^\s]+\.[a-z]{2,}([/:?#].*)?$/i.test(value) || /^localhost(:\d+)?/i.test(value);

/**
 * Address bar suggestions: matching sites first (visited ones ranked by how
 * often, then well-known ones), then pages from history, then a web search.
 */
export function buildSuggestions(input: string, history: HistoryEntry[], searchName: string): Suggestion[] {
  const text = input.trim();
  if (!text) return [];
  const query = text.toLowerCase();
  const singleWord = !/\s/.test(query);
  const rows: Suggestion[] = [];

  if (looksLikeAddress(text)) {
    rows.push({ kind: "url", title: text, subtitle: "Open address", url: text });
  }

  // Sites: visited hosts (by visit count) then popular ones.
  if (singleWord && !query.includes("/")) {
    const visits = new Map<string, number>();
    history.forEach((entry) => {
      const host = hostOf(entry.url);
      if (host) visits.set(host, (visits.get(host) ?? 0) + 1);
    });
    const candidates = new Map<string, { score: number; visits: number }>();
    for (const [host, count] of visits) {
      const score = hostScore(host, query);
      if (score) candidates.set(host, { score, visits: count });
    }
    for (const host of POPULAR_SITES) {
      const score = hostScore(host, query);
      if (score && !candidates.has(host)) candidates.set(host, { score, visits: 0 });
    }
    const sites = [...candidates.entries()]
      .sort((a, b) => b[1].score - a[1].score || b[1].visits - a[1].visits || a[0].length - b[0].length)
      .slice(0, 3);
    sites.forEach(([host, info], index) => {
      rows.push({
        kind: "domain",
        title: host,
        subtitle: info.visits ? `Visited ${info.visits} time${info.visits === 1 ? "" : "s"}` : "Site",
        url: `https://${host}/`,
        autocomplete: index === 0 && info.score === 3 && !looksLikeAddress(text),
      });
    });
  }

  // Pages from history whose title or address contains the text.
  const seen = new Set(rows.map((row) => row.url));
  const pages = history.filter((entry) => {
    if (seen.has(entry.url)) return false;
    return entry.title.toLowerCase().includes(query) || entry.url.toLowerCase().includes(query);
  });
  for (const entry of pages) {
    if (rows.length >= MAX_ROWS - 1) break;
    seen.add(entry.url);
    rows.push({ kind: "history", title: entry.title || entry.url, subtitle: entry.url, url: entry.url });
  }

  rows.push({ kind: "search", title: text, subtitle: `Search ${searchName}`, url: text });
  return rows.slice(0, MAX_ROWS);
}
