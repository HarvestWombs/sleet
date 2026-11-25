import { AlertCircle, CheckCircle2, Clock3, Download, ExternalLink, FolderOpen, History, Pause, Play, Search, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { canPauseDownloads } from "../lib/downloadTypes";
import { historyList } from "../native/store";
import type { DownloadItem, HistoryEntry, Surface } from "../types";
import type { MenuEntry } from "./ContextMenu";
import { downloadStatusText } from "./Toasts";
import { DownloadBar } from "./DownloadIcon";
import { SiteIcon } from "./SiteIcon";

interface LibrarySurfaceProps {
  surface: Exclude<Surface, "browser" | "settings">;
  /** Bumps when history changes so the page reloads its query. */
  historyVersion: number;
  downloads: DownloadItem[];
  onOpen: (url: string) => void;
  onClearHistory: () => void;
  onOpenDownload: (download: DownloadItem) => void;
  onRevealDownload: (download: DownloadItem) => void;
  onCancelDownload: (download: DownloadItem) => void;
  onPauseDownload: (download: DownloadItem) => void;
  onOpenFolder: () => void;
  onClearDownloads: () => void;
  onContextMenu: (x: number, y: number, items: MenuEntry[]) => void;
  historyMenu: (entry: HistoryEntry) => MenuEntry[];
  downloadMenu: (download: DownloadItem) => MenuEntry[];
}

const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function HistoryPage({ historyVersion, onOpen, onClearHistory, onContextMenu, historyMenu }: Pick<LibrarySurfaceProps, "historyVersion" | "onOpen" | "onClearHistory" | "onContextMenu" | "historyMenu">) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void historyList(1000, query).then((rows) => { if (!cancelled) setItems(rows); });
    }, query ? 150 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [historyVersion, query]);

  return (
    <>
      <header className="library-header">
        <div>
          <span className="eyebrow">Library</span>
          <h2>History</h2>
          <p>Kept locally on this device.</p>
        </div>
        {items.length > 0 && <button className="quiet-button" onClick={onClearHistory}><Trash2 size={19} /> Clear all</button>}
      </header>
      <label className="settings-search">
        <Search size={19} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search history" aria-label="Search history" />
      </label>
      <div className="library-list">
        {items.map((item) => (
          <button className="library-row" key={item.id} onClick={() => onOpen(item.url)} onContextMenu={(event) => { event.preventDefault(); onContextMenu(event.clientX, event.clientY, historyMenu(item)); }}>
            <span className="library-icon"><SiteIcon url={item.url} title={item.title} className="library-site-icon" /></span>
            <span className="library-copy"><strong>{item.title}</strong><small>{item.url}</small></span>
            <time>{formatter.format(item.visitedAt)}</time>
            <ExternalLink size={19} />
          </button>
        ))}
        {items.length === 0 && (
          <div className="empty-state">
            <History size={34} />
            <strong>{query ? "No matches" : "Nothing here yet"}</strong>
            <p>{query ? "Try a different search." : "Pages you visit will appear here."}</p>
          </div>
        )}
      </div>
    </>
  );
}

function DownloadsPage({ downloads, onOpenDownload, onRevealDownload, onCancelDownload, onPauseDownload, onOpenFolder, onClearDownloads, onContextMenu, downloadMenu }: Pick<LibrarySurfaceProps, "downloads" | "onOpenDownload" | "onRevealDownload" | "onCancelDownload" | "onPauseDownload" |"onOpenFolder" | "onClearDownloads" | "onContextMenu" | "downloadMenu">) {
  return (
    <>
      <header className="library-header">
        <div>
          <span className="eyebrow">Library</span>
          <h2>Downloads</h2>
          <p>Click a finished download to open it.</p>
        </div>
        <div className="library-actions">
          {downloads.length > 0 && <button className="quiet-button" onClick={onClearDownloads}><Trash2 size={19} /> Clear list</button>}
          <button className="quiet-button" onClick={onOpenFolder}><FolderOpen size={19} /> Open folder</button>
        </div>
      </header>
      <div className="library-list">
        {downloads.map((item) => {
          return (
            <div className="library-row download-row" key={item.id} onContextMenu={(event) => { event.preventDefault(); onContextMenu(event.clientX, event.clientY, downloadMenu(item)); }}>
              <button className="download-open" onClick={() => onOpenDownload(item)} disabled={item.status !== "complete"} title={item.status === "complete" ? "Open file" : undefined}>
                <span className="library-icon"><Download size={23} /></span>
                <span className="library-copy">
                  <strong>{item.filename}</strong>
                  <DownloadBar download={item} />
                  <small>{item.status === "complete" ? item.path ?? item.url : downloadStatusText(item)}</small>
                </span>
              </button>
              <time>{formatter.format(item.startedAt)}</time>
              <span className="download-buttons">
                {item.status === "active" && canPauseDownloads && (
                  <button className="toast-button" aria-label={item.paused ? `Resume ${item.filename}` : `Pause ${item.filename}`} title={item.paused ? "Resume download" : "Pause download"} onClick={() => onPauseDownload(item)}>
                    {item.paused ? <Play size={17} /> : <Pause size={17} />}
                  </button>
                )}
                {item.status === "active"
                  ? <button className="toast-button" aria-label={`Cancel ${item.filename}`} title="Cancel download" onClick={() => onCancelDownload(item)}><X size={17} /></button>
                  : <button className="toast-button" aria-label={`Show ${item.filename} in folder`} title="Show in folder" onClick={() => onRevealDownload(item)} disabled={item.status !== "complete"}><FolderOpen size={17} /></button>}
              </span>
              {item.status === "complete" ? <CheckCircle2 className="success" size={21} /> : item.status === "failed" ? <AlertCircle className="failure" size={21} /> : item.paused ? <Pause size={21} /> : <Clock3 size={21} />}
            </div>
          );
        })}
        {downloads.length === 0 && (
          <div className="empty-state">
            <Download size={34} />
            <strong>Nothing here yet</strong>
            <p>Your downloaded files will appear here.</p>
          </div>
        )}
      </div>
    </>
  );
}

export function LibrarySurface(props: LibrarySurfaceProps) {
  return (
    <main className="library-surface">
      <div className="library-inner">
        {props.surface === "history" ? <HistoryPage {...props} /> : <DownloadsPage {...props} />}
      </div>
    </main>
  );
}
