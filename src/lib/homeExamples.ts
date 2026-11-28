import { findHomeBookmark, type HomeGroup, makeHomeId } from "./homeBookmarks";

/** Example bookmarks for trying out the Home board in development builds (Customize › Add example bookmarks). */
const EXAMPLES: [string, string | undefined, [string, string][]][] = [
  ["News", undefined, [["Hacker News", "https://news.ycombinator.com/"], ["BBC News", "https://www.bbc.com/news"], ["Reuters", "https://www.reuters.com/"], ["The Verge", "https://www.theverge.com/"], ["Ars Technica", "https://arstechnica.com/"], ["AP News", "https://apnews.com/"], ["Lobsters", "https://lobste.rs/"]]],
  ["Dev", "#5fb3ff", [["GitHub", "https://github.com/"], ["MDN", "https://developer.mozilla.org/"], ["Rust docs", "https://doc.rust-lang.org/std/"], ["Tauri", "https://tauri.app/"], ["React", "https://react.dev/"], ["TypeScript", "https://www.typescriptlang.org/"], ["Stack Overflow", "https://stackoverflow.com/"], ["crates.io", "https://crates.io/"], ["npm", "https://www.npmjs.com/"], ["Can I use", "https://caniuse.com/"]]],
  ["Watch & listen", "#f07c6c", [["YouTube", "https://www.youtube.com/"], ["Twitch", "https://www.twitch.tv/"], ["Spotify", "https://open.spotify.com/"], ["SoundCloud", "https://soundcloud.com/"], ["Bandcamp", "https://bandcamp.com/"]]],
  ["Reference", "#4fc79a", [["Wikipedia", "https://en.wikipedia.org/"], ["Wiktionary", "https://en.wiktionary.org/"], ["OpenStreetMap", "https://www.openstreetmap.org/"], ["Internet Archive", "https://archive.org/"], ["Wolfram Alpha", "https://www.wolframalpha.com/"], ["arXiv", "https://arxiv.org/"]]],
  ["Social", "#c08bff", [["Reddit", "https://www.reddit.com/"], ["Mastodon", "https://mastodon.social/"], ["Bluesky", "https://bsky.app/"], ["Discord", "https://discord.com/app"]]],
  ["Tools", "#f2b84b", [["Figma", "https://www.figma.com/"], ["Excalidraw", "https://excalidraw.com/"], ["regex101", "https://regex101.com/"], ["Squoosh", "https://squoosh.app/"], ["DeepL", "https://www.deepl.com/translator"], ["Proton Mail", "https://mail.proton.me/"], ["Google Calendar", "https://calendar.google.com/"], ["Notion", "https://www.notion.so/"], ["Trello", "https://trello.com/"]]],
];

/** Adds the example groups (skipping addresses already bookmarked). New groups take free spots on the board. */
export function addExampleBookmarks(groups: HomeGroup[]): HomeGroup[] {
  const added: HomeGroup[] = EXAMPLES.map(([name, color, sites]) => ({
    id: makeHomeId(),
    name,
    color,
    items: sites.filter(([, url]) => !findHomeBookmark(groups, url)).map(([title, url]) => ({ id: makeHomeId(), title, url })),
  }));
  return [...groups, ...added.filter((group) => group.items.length > 0)];
}
