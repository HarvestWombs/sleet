import { invoke } from "@tauri-apps/api/core";
import type { DownloadItem, HistoryEntry } from "../types";
import { isTauri } from "./browserEngine";

/**
 * History and downloads live in SQLite (src-tauri/src/store.rs). Outside Tauri
 * (plain `vite` preview) a small localStorage stand-in keeps the UI usable.
 */

const memoryKey = { history: "sleet.preview.history", downloads: "sleet.preview.downloads" };
const readLocal = <T,>(key: string): T[] => {
  try { return JSON.parse(localStorage.getItem(key) ?? "[]") as T[]; } catch { return []; }
};
const writeLocal = (key: string, value: unknown) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
};

export async function historyAdd(url: string, title: string, visitedAt = Date.now()): Promise<HistoryEntry> {
  if (isTauri()) return invoke<HistoryEntry>("history_add", { url, title, visitedAt });
  const entry: HistoryEntry = { id: url, url, title, visitedAt };
  writeLocal(memoryKey.history, [entry, ...readLocal<HistoryEntry>(memoryKey.history).filter((item) => item.url !== url)].slice(0, 1000));
  return entry;
}

export async function historyList(limit: number, query?: string): Promise<HistoryEntry[]> {
  if (isTauri()) return invoke<HistoryEntry[]>("history_list", { limit, query: query?.trim() || null });
  const text = query?.trim().toLowerCase();
  return readLocal<HistoryEntry>(memoryKey.history)
    .filter((item) => !text || `${item.title} ${item.url}`.toLowerCase().includes(text))
    .slice(0, limit);
}

/** Deletes entries visited before `before`, or since `since` (epoch ms), or everything. */
export async function historyClear(before?: number, since?: number): Promise<void> {
  if (isTauri()) { await invoke("history_clear", { before: before ?? null, since: since ?? null }); return; }
  writeLocal(memoryKey.history, readLocal<HistoryEntry>(memoryKey.history).filter((item) =>
    before ? item.visitedAt >= before : since ? item.visitedAt < since : false));
}

export async function historyDelete(id: string): Promise<void> {
  if (isTauri()) { await invoke("history_delete", { id }); return; }
  writeLocal(memoryKey.history, readLocal<HistoryEntry>(memoryKey.history).filter((item) => item.id !== id));
}

export async function downloadDelete(id: string): Promise<void> {
  if (isTauri()) { await invoke("download_delete", { id }); return; }
  writeLocal(memoryKey.downloads, readLocal<DownloadItem>(memoryKey.downloads).filter((item) => item.id !== id));
}

export async function downloadPut(record: DownloadItem): Promise<void> {
  const row = { ...record, path: record.path ?? null, received: record.received ?? null, total: record.total ?? null };
  if (isTauri()) { await invoke("download_put", { record: row }); return; }
  writeLocal(memoryKey.downloads, [record, ...readLocal<DownloadItem>(memoryKey.downloads).filter((item) => item.id !== record.id)]);
}

export async function downloadsList(limit: number): Promise<DownloadItem[]> {
  if (isTauri()) {
    const rows = await invoke<(Omit<DownloadItem, "path" | "received" | "total"> & { path: string | null; received: number | null; total: number | null })[]>("downloads_list", { limit });
    return rows.map((row) => ({ ...row, path: row.path ?? undefined, received: row.received ?? undefined, total: row.total ?? undefined }));
  }
  return readLocal<DownloadItem>(memoryKey.downloads).slice(0, limit);
}

export async function downloadsClear(completedOnly: boolean, since?: number): Promise<void> {
  if (isTauri()) { await invoke("downloads_clear", { completedOnly, since: since ?? null }); return; }
  writeLocal(memoryKey.downloads, completedOnly ? readLocal<DownloadItem>(memoryKey.downloads).filter((item) => item.status !== "complete") : []);
}

/** Moves lists from the old localStorage keys into SQLite, once. */
export async function importLegacyLists(): Promise<void> {
  if (!isTauri()) return;
  // Saved before the rename to Sleet, so under the old key names.
  const history = readLocal<HistoryEntry>("horizon.history");
  const downloads = readLocal<DownloadItem>("horizon.downloads");
  try {
    await invoke("import_legacy", {
      history: history.map((item) => ({ ...item, id: "" })),
      downloads: downloads.map((item) => ({ ...item, path: item.path ?? null, received: null, total: null })),
    });
    localStorage.removeItem("horizon.history");
    localStorage.removeItem("horizon.downloads");
  } catch {
    // Keep the old keys so the import can be retried next launch.
  }
}

export async function openDownload(id: string) {
  if (!isTauri()) throw new Error("Opening files needs the desktop app");
  await invoke("open_download", { id });
}

export async function revealDownload(id: string) {
  if (!isTauri()) throw new Error("Showing files needs the desktop app");
  await invoke("reveal_download", { id });
}

export async function openDownloadsFolder() {
  if (!isTauri()) throw new Error("Opening folders needs the desktop app");
  await invoke("open_downloads_folder");
}

export interface SitePermission {
  origin: string;
  kind: string;
  state: "allow" | "block";
  updatedAt: number;
}

export async function permissionsList(origin?: string): Promise<SitePermission[]> {
  if (!isTauri()) return [];
  return invoke<SitePermission[]>("permissions_list", { origin: origin ?? null });
}

export async function permissionSet(origin: string, kind: string, state: "allow" | "block") {
  if (!isTauri()) return;
  await invoke("permission_set", { origin, kind, state });
}

/** Forgets a saved answer (or all for the site) so the site is asked again. */
export async function permissionDelete(origin: string, kind?: string) {
  if (!isTauri()) return;
  await invoke("permission_delete", { origin, kind: kind ?? null });
}
