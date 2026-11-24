import { invoke } from "@tauri-apps/api/core";
import type { ImportRoot } from "../lib/bookmarkImport";
import { isTauri } from "./browserEngine";

export interface BookmarkSource {
  id: string;
  browser: string;
  profile: string;
  count: number;
}

export interface ImportedBookmarks {
  roots: ImportRoot[];
  /** Site icons by host (PNG data URLs). */
  icons: Record<string, string>;
}

/** Browsers installed for this user that have bookmarks (src-tauri/src/bookmark_import.rs). */
export async function detectBookmarkSources(): Promise<BookmarkSource[]> {
  if (!isTauri()) return [];
  return invoke<BookmarkSource[]>("detect_bookmark_sources").catch(() => []);
}

export async function readBookmarkSource(id: string): Promise<ImportedBookmarks> {
  return invoke<ImportedBookmarks>("read_bookmark_source", { id });
}
