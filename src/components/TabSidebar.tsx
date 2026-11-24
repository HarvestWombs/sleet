import { Download, FolderOpen, History, List, Moon, Plus, Settings2, VenetianMask, Volume2, VolumeX, X, Frown } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useRef, useState } from "react";
import { displayHost, isHomeUrl } from "../lib/browser";
import { SiteIcon } from "./SiteIcon";
import type { AudioState, BrowserTab, DownloadItem, HistoryEntry, SidebarMode, Surface } from "../types";
import type { MenuEntry } from "./ContextMenu";
import { downloadStatusText } from "./Toasts";

const RECENT_HISTORY = 40;
const RECENT_DOWNLOADS = 25;
const DRAG_THRESHOLD = 4;
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

interface TabSidebarProps {
  tabs: BrowserTab[];
  history: HistoryEntry[];
  downloads: DownloadItem[];
  activeId: string;
  /** Tabs whose page has been unloaded to save memory. */
  sleeping: Set<string>;
  /** Tabs whose page is loading (spinner in place of the icon). */
  loading?: Set<string>;
  /** Tabs whose page crashed. */
  crashed?: Record<string, string>;
  audio: Record<string, AudioState>;
  detailed: boolean;
  surface: Surface;
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onNewPrivate: () => void;
  onReorder: (id: string, toIndex: number) => void;
  onToggleMute: (id: string) => void;
  onOpenUrl: (url: string) => void;
  onOpenDownload: (download: DownloadItem) => void;
  onRevealDownload: (download: DownloadItem) => void;
  onContextMenu: (x: number, y: number, items: MenuEntry[]) => void;
  tabMenu: (tab: BrowserTab, index: number) => MenuEntry[];
  historyMenu: (entry: HistoryEntry) => MenuEntry[];
  downloadMenu: (download: DownloadItem) => MenuEntry[];
  onSurfaceChange: (surface: Surface) => void;
  sidebarWidth: number;
  onSidebarResize: (width: number) => void;
  /** Bookmark grid shown above the tab list. */
  bookmarks?: ReactNode;
  /** Inline bookmark editor, when open. */
  bookmarkEditor?: ReactNode;
  /** A tab was dragged into the bookmark grid. */
  onBookmarkTab: (id: string) => void;
}

export function TabSidebar(props: TabSidebarProps) {
  const { tabs, history, downloads, activeId, sleeping, loading, crashed, audio, detailed, surface, mode, onModeChange, onActivate, onClose, onNew, onNewPrivate, onReorder, onToggleMute, onOpenUrl, onOpenDownload, onRevealDownload, onContextMenu, tabMenu, historyMenu, downloadMenu, onSurfaceChange, sidebarWidth, onSidebarResize, onBookmarkTab } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);

  const toggleMode = (next: SidebarMode) => onModeChange(mode === next ? "tabs" : next);
  const openMenu = (event: ReactMouseEvent, items: MenuEntry[]) => {
    event.preventDefault();
    onContextMenu(event.clientX, event.clientY, items);
  };

  /** Pointer-based drag so it works with Tauri's native drag-drop handler enabled. */
  const startTabDrag = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0) return;
    const startY = event.clientY;
    let active = false;
    let over = -1;
    let overBookmarks = false;
    const controller = new AbortController();
    const indexAt = (y: number) => {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(".tab-item") ?? []);
      const index = rows.findIndex((row) => { const rect = row.getBoundingClientRect(); return y < rect.top + rect.height / 2; });
      return index === -1 ? rows.length : index;
    };
    window.addEventListener("pointermove", (move) => {
      if (!active && Math.abs(move.clientY - startY) < DRAG_THRESHOLD) return;
      if (!active) { active = true; document.body.classList.add("is-dragging-tab"); }
      overBookmarks = !!(document.elementFromPoint(move.clientX, move.clientY) as HTMLElement | null)?.closest("[data-bookmark-grid]");
      document.body.classList.toggle("is-dropping-on-bookmarks", overBookmarks);
      over = overBookmarks ? -1 : indexAt(move.clientY);
      setDrag({ id, over });
    }, { signal: controller.signal });
    const finish = () => {
      controller.abort();
      document.body.classList.remove("is-dragging-tab", "is-dropping-on-bookmarks");
      setDrag(null);
      if (!active) return;
      suppressClick.current = true;
      requestAnimationFrame(() => { suppressClick.current = false; });
      if (overBookmarks) onBookmarkTab(id);
      else if (over >= 0) onReorder(id, over);
    };
    window.addEventListener("pointerup", finish, { signal: controller.signal });
    window.addEventListener("pointercancel", finish, { signal: controller.signal });
  };

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const controller = new AbortController();
    const finish = () => {
      controller.abort();
      document.body.classList.remove("is-resizing-sidebar");
    };
    document.body.classList.add("is-resizing-sidebar");
    window.addEventListener("pointermove", (moveEvent) => onSidebarResize(startWidth + moveEvent.clientX - startX), { signal: controller.signal });
    window.addEventListener("pointerup", finish, { signal: controller.signal });
    window.addEventListener("pointercancel", finish, { signal: controller.signal });
  };

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onSidebarResize(sidebarWidth + (event.key === "ArrowRight" ? 12 : -12));
  };

  const footerLabel = mode === "tabs" ? `${tabs.length} open` : mode === "history" ? `${history.length} recent` : `${downloads.length} downloads`;

  return (
    <aside className="tabs-sidebar" data-tauri-drag-region>
      <header className="sidebar-header" data-tauri-drag-region>
        <button className={`brand ${mode === "tabs" ? "is-current" : ""}`} aria-label="Show tabs" title="Tabs" onClick={() => onModeChange("tabs")}><span>S</span></button>
        <span className="sidebar-title" data-tauri-drag-region>{mode === "tabs" ? "Sleet" : mode === "history" ? "History" : "Downloads"}</span>
        <div className="sidebar-header-actions">
          <button className={`sidebar-action ${mode === "history" ? "is-active" : ""}`} aria-label="History" aria-pressed={mode === "history"} title="History" onClick={() => toggleMode("history")}><History size={15} /></button>
          <button className={`sidebar-action ${mode === "downloads" ? "is-active" : ""}`} aria-label="Downloads" aria-pressed={mode === "downloads"} title="Downloads" onClick={() => toggleMode("downloads")}><Download size={15} /></button>
        </div>
      </header>

      {mode === "tabs" ? (
        <>
        {props.bookmarks}
        {props.bookmarkEditor}
        <div className="new-tab-group">
          <button className="new-tab-row" onClick={onNew}><Plus size={15} /><span>New tab</span><kbd>Ctrl T</kbd></button>
          <button className="new-private" aria-label="New private tab" title="New private tab (Ctrl+Shift+N)" onClick={onNewPrivate}><VenetianMask size={14} /></button>
        </div>
        </>
      ) : (
        <button className={`new-tab-row ${surface === mode ? "is-current" : ""}`} onClick={() => onSurfaceChange(mode)}>
          <List size={15} /><span>{mode === "history" ? "Show all history" : "Show all downloads"}</span><kbd>{mode === "history" ? "Ctrl Y" : "Ctrl J"}</kbd>
        </button>
      )}

      {mode === "tabs" && (
        <div className="tab-list" role="tablist" aria-label="Open tabs" ref={listRef}>
          {tabs.map((tab, index) => {
            const asleep = sleeping.has(tab.id);
            const sound = audio[tab.id];
            const showSpeaker = !!sound && (sound.playing || sound.muted);
            const dropBefore = drag && drag.over === index && drag.id !== tab.id;
            const dropAfter = drag && index === tabs.length - 1 && drag.over === tabs.length && drag.id !== tab.id;
            return (
              <div
                className={`tab-item ${tab.id === activeId && surface === "browser" ? "is-active" : ""} ${asleep ? "is-asleep" : ""} ${tab.private ? "is-private" : ""} ${drag?.id === tab.id ? "is-dragging" : ""} ${dropBefore ? "is-drop-before" : ""} ${dropAfter ? "is-drop-after" : ""}`}
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeId}
                onContextMenu={(event) => openMenu(event, tabMenu(tab, index))}
                onPointerDown={(event) => { if (!(event.target as HTMLElement).closest(".tab-close, .tab-audio")) startTabDrag(event, tab.id); }}
              >
                <span className="tab-lead" onClick={() => { if (!suppressClick.current) onActivate(tab.id); }}>
                  <span className="tab-number" aria-hidden="true">{index + 1}</span>
                  {crashed?.[tab.id]
                    ? <span className="tab-favicon is-crashed" aria-label="Page crashed"><Frown size={11} /></span>
                    : loading?.has(tab.id)
                    ? <span className="tab-favicon tab-spinner" aria-label="Loading" />
                    : tab.private && !tab.favicon
                    ? <span className="tab-favicon" aria-hidden="true"><VenetianMask size={10} /></span>
                    : asleep && !tab.favicon
                      ? <span className="tab-favicon" aria-hidden="true"><Moon size={9} /></span>
                      : <SiteIcon icon={tab.favicon} title={tab.title} url={tab.private ? undefined : tab.url} />}
                  {showSpeaker && (
                    <button className={`tab-audio ${sound.muted ? "is-muted" : ""}`} aria-label={sound.muted ? `Unmute ${tab.title}` : `Mute ${tab.title}`} title={sound.muted ? "Unmute tab" : "Mute tab"} onClick={(event) => { event.stopPropagation(); onToggleMute(tab.id); }}>
                      {sound.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                    </button>
                  )}
                </span>
                <button className="tab-main" onClick={() => { if (!suppressClick.current) onActivate(tab.id); }} title={asleep ? `${tab.title} (inactive, reloads when opened)` : tab.title}>
                  <span className="tab-copy">
                    <strong>{tab.title || "Untitled"}</strong>
                    {detailed && <small>{isHomeUrl(tab.url) ? "Sleet" : displayHost(tab.url)}</small>}
                  </span>
                </button>
                <button className="tab-close" aria-label={`Close ${tab.title}`} onClick={() => onClose(tab.id)}>
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {mode === "history" && (
        <div className="tab-list" aria-label="Recent history">
          {history.slice(0, RECENT_HISTORY).map((item) => (
            <button className="side-row" key={item.id} onClick={() => onOpenUrl(item.url)} onContextMenu={(event) => openMenu(event, historyMenu(item))} title={item.url}>
              <SiteIcon url={item.url} title={item.title} />
              <span className="side-copy"><strong>{item.title}</strong><small>{timeFormatter.format(item.visitedAt)}</small></span>
            </button>
          ))}
          {history.length === 0 && <div className="side-empty">No history yet</div>}
        </div>
      )}

      {mode === "downloads" && (
        <div className="tab-list" aria-label="Recent downloads">
          {downloads.slice(0, RECENT_DOWNLOADS).map((download) => {
            const status = downloadStatusText(download).replace(" · click to open", "");
            return (
              <div className="side-row side-download" key={download.id} title={download.path ?? download.url} onContextMenu={(event) => openMenu(event, downloadMenu(download))}>
                <button className="side-download-open" onClick={() => onOpenDownload(download)} disabled={download.status !== "complete"}>
                  <i className={`download-status is-${download.status}`} />
                  <span className="side-copy"><strong>{download.filename}</strong><small>{status}</small></span>
                </button>
                {download.status === "complete" && <button className="side-row-action" aria-label={`Show ${download.filename} in folder`} title="Show in folder" onClick={() => onRevealDownload(download)}><FolderOpen size={13} /></button>}
              </div>
            );
          })}
          {downloads.length === 0 && <div className="side-empty">No downloads yet</div>}
        </div>
      )}

      <footer className="sidebar-footer" data-tauri-drag-region>
        <span data-tauri-drag-region>{footerLabel}</span>
        <button className={surface === "settings" ? "is-active" : ""} aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => onSurfaceChange(surface === "settings" ? "browser" : "settings")}><Settings2 size={15} /></button>
      </footer>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={176}
        aria-valuemax={360}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={startSidebarResize}
        onKeyDown={resizeSidebarWithKeyboard}
      />
    </aside>
  );
}
