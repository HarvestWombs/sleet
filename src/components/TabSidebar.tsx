import { ChevronRight, Columns2, Download, FolderOpen, History, List, Moon, Plus, Settings2, VenetianMask, Volume2, VolumeX, X, Frown, PanelLeftClose } from "lucide-react";
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useRef, useState } from "react";
import { BookmarkEditor } from "./BookmarkGrid";
import { displayHost, isHomeUrl } from "../lib/browser";
import { SiteIcon } from "./SiteIcon";
import { DownloadBar, DownloadIcon } from "./DownloadIcon";
import type { AudioState, BrowserTab, DownloadItem, HistoryEntry, SidebarMode, Surface } from "../types";
import type { MenuEntry } from "./ContextMenu";
import { groupColor, type TabGroup } from "../lib/tabGroups";
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
  /** Moves a tab to `toIndex`, into `groupId` (or out of any group with `null`). */
  onReorder: (id: string, toIndex: number, groupId?: string | null) => void;
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
  /** The bookmarks section is folded away (its header stays). */
  bookmarksCollapsed?: boolean;
  onToggleBookmarks?: () => void;
  bookmarkCount?: number;
  /** A tab was dragged into the bookmark grid. */
  onBookmarkTab: (id: string) => void;
  /** A tab was dragged out of the window and dropped at this screen point (CSS pixels). */
  onTearOffTab?: (id: string, screenX: number, screenY: number) => void;
  /** Tab groups (headers that fold their tabs away). */
  groups?: TabGroup[];
  /** Group whose name is being typed. */
  editingGroup?: string | null;
  onToggleGroup?: (id: string) => void;
  /** Saves a group's name from its editor (`null`: closed without saving). */
  onRenameGroup?: (id: string, name: string | null) => void;
  /** Color picked in a group's editor (applies right away, like folders). */
  onGroupColor?: (id: string, color: string) => void;
  /** A tab was Ctrl-dropped on another: group them (joining the other's group if it has one). */
  onGroupWith?: (tabId: string, targetId: string) => void;
  /** Start typing a group's name. */
  onEditGroup?: (id: string) => void;
  groupMenu?: (group: TabGroup) => MenuEntry[];
  /** Menu for the sidebar's empty space. */
  sidebarMenu?: () => MenuEntry[];
  /** Tabs shown in a docked layout. */
  dockedIds?: Set<string>;
  /** A dragged tab is over the page area (chrome CSS pixels), or left it (`null`). */
  onDockDrag?: (id: string | null, x: number, y: number) => void;
  /** The dragged tab was dropped on the page area. */
  onDockDrop?: (x: number, y: number) => void;
  /** Hides the sidebar (the toolbar shows a button to bring it back). */
  onHideSidebar: () => void;
}

/**
 * Where a dragged tab would land: its place in the full tab list, the group it
 * would be in, and the row the drop line is drawn against.
 */
interface DropSlot {
  index: number;
  group?: string;
  row: string;
  /**
   * Line above or below `row`; `join`: onto a folded group's header; `merge`:
   * onto another tab with Ctrl held, grouping the two (`row` is that tab).
   */
  pos: "before" | "after" | "join" | "merge";
}

/** With Ctrl held, the tab under the pointer (other than the dragged one): dropping groups them. */
function mergeTargetAt(list: HTMLElement, x: number, y: number, dragged: string): DropSlot | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-row^='tab:']");
  if (!row || !list.contains(row) || row.dataset.row === `tab:${dragged}`) return null;
  return { index: Number(row.dataset.index), group: row.dataset.group || undefined, row: row.dataset.row!, pos: "merge" };
}

const sameSlot = (a: DropSlot | null, b: DropSlot | null) =>
  a === b || (!!a && !!b && a.index === b.index && a.group === b.group && a.row === b.row && a.pos === b.pos);

/**
 * The drop slot for a pointer at `y`. Rows are the tabs and group headers on
 * screen. A tab dropped on the lower half of a row goes after it and into that
 * row's group: below a group's last tab it stays in the group, just under an
 * open header it goes first in the group, on a folded header it joins at the
 * end. On the upper half of the next row it goes before that row, in that
 * row's group (none above a header). So the edge of a group has two slots, one
 * inside and one outside, half a row apart.
 */
function slotAt(list: HTMLElement, y: number, count: number): DropSlot {
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-row]")).map((element) => ({ element, rect: element.getBoundingClientRect() }));
  let below = rows.findIndex(({ rect }) => y < rect.top + rect.height / 2);
  if (below === -1) below = rows.length;
  const above = rows[below - 1];
  const next = rows[below];
  const info = (row: { element: HTMLElement }) => row.element.dataset;
  if (above && y < above.rect.bottom) {
    const data = info(above);
    if (data.header) {
      return data.collapsed
        ? { index: Number(data.last) + 1, group: data.group, row: data.row!, pos: "join" }
        : { index: Number(data.first), group: data.group, row: data.row!, pos: "after" };
    }
    return { index: Number(data.index) + 1, group: data.group || undefined, row: data.row!, pos: "after" };
  }
  if (next) {
    const data = info(next);
    if (data.header) return { index: Number(data.first), row: data.row!, pos: "before" };
    return { index: Number(data.index), group: data.group || undefined, row: data.row!, pos: "before" };
  }
  return { index: count, row: above ? info(above).row! : "", pos: "after" };
}

export function TabSidebar(props: TabSidebarProps) {
  const { tabs, history, downloads, activeId, sleeping, loading, crashed, audio, detailed, surface, mode, onModeChange, onActivate, onClose, onNew, onNewPrivate, onReorder, onToggleMute, onOpenUrl, onOpenDownload, onRevealDownload, onContextMenu, tabMenu, historyMenu, downloadMenu, onSurfaceChange, sidebarWidth, onSidebarResize, onBookmarkTab, onTearOffTab, onHideSidebar, groups = [], editingGroup, onToggleGroup, onRenameGroup, onGroupColor, onEditGroup, onGroupWith, groupMenu, sidebarMenu, dockedIds, onDockDrag, onDockDrop } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  /** The tab being dragged and where it would land (see `slotAt`). */
  const [drag, setDrag] = useState<{ id: string; slot: DropSlot | null } | null>(null);
  const groupById = new Map(groups.map((group) => [group.id, group]));

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
    let slot: DropSlot | null = null;
    let overBookmarks = false;
    let outside: { x: number; y: number } | null = null;
    let last: { x: number; y: number } | null = null;
    /** Where a drop at the last pointer position lands; with Ctrl, onto the tab under it. */
    const place = (ctrl: boolean) => {
      if (!last || !listRef.current) return;
      slot = overBookmarks ? null : (ctrl && mergeTargetAt(listRef.current, last.x, last.y, id)) || slotAt(listRef.current, last.y, tabs.length);
      setDrag((current) => current && current.id === id && sameSlot(current.slot, slot) ? current : { id, slot });
    };
    /** Over the page area: docking takes over (App draws the drop targets). */
    let overPage = false;
    const sidebarRight = () => listRef.current?.closest("aside")?.getBoundingClientRect().right ?? 0;
    const controller = new AbortController();
    const row = event.currentTarget as Element;
    const isOutside = (move: PointerEvent) => move.clientX < 0 || move.clientY < 0 || move.clientX > window.innerWidth || move.clientY > window.innerHeight;
    window.addEventListener("pointermove", (move) => {
      if (!active && Math.abs(move.clientY - startY) < DRAG_THRESHOLD) return;
      if (!active) {
        active = true;
        document.body.classList.add("is-dragging-tab");
        // Keep getting pointer events once the pointer leaves the window, so the tab can be torn off.
        // (Only once dragging: capturing on press would swallow clicks on the row's buttons.)
        try { row.setPointerCapture(move.pointerId); } catch { /* not capturable */ }
      }
      outside = onTearOffTab && isOutside(move) ? { x: move.screenX, y: move.screenY } : null;
      document.body.classList.toggle("is-tearing-tab", !!outside);
      const nowOverPage = !outside && !!onDockDrag && move.clientX > sidebarRight();
      if (nowOverPage) onDockDrag?.(id, move.clientX, move.clientY);
      else if (overPage) onDockDrag?.(null, 0, 0);
      overPage = nowOverPage;
      if (outside || overPage) { overBookmarks = false; slot = null; setDrag({ id, slot }); return; }
      const under = document.elementFromPoint(move.clientX, move.clientY) as HTMLElement | null;
      overBookmarks = !!under?.closest("[data-bookmark-grid]");
      document.body.classList.toggle("is-dropping-on-bookmarks", overBookmarks);
      last = { x: move.clientX, y: move.clientY };
      place(move.ctrlKey);
    }, { signal: controller.signal });
    // Pressing or releasing Ctrl without moving switches between grouping and moving.
    const onCtrl = (key: KeyboardEvent) => {
      if (key.key !== "Control" || !active || outside || overPage || overBookmarks || !last) return;
      place(key.type === "keydown");
    };
    window.addEventListener("keydown", onCtrl, { signal: controller.signal });
    window.addEventListener("keyup", onCtrl, { signal: controller.signal });
    const finish = (end: PointerEvent) => {
      controller.abort();
      try { row.releasePointerCapture(end.pointerId); } catch { /* already released */ }
      document.body.classList.remove("is-dragging-tab", "is-dropping-on-bookmarks", "is-tearing-tab");
      setDrag(null);
      if (!active) return;
      suppressClick.current = true;
      requestAnimationFrame(() => { suppressClick.current = false; });
      if (overPage) { if (end.type === "pointerup") onDockDrop?.(end.clientX, end.clientY); else onDockDrag?.(null, 0, 0); }
      else if (outside && end.type === "pointerup") onTearOffTab?.(id, outside.x, outside.y);
      else if (overBookmarks) onBookmarkTab(id);
      else if (slot?.pos === "merge") onGroupWith?.(id, slot.row.slice("tab:".length));
      else if (slot) onReorder(id, slot.index, slot.group ?? null);
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
    <aside
      className="tabs-sidebar"
      data-tauri-drag-region
      // Empty space (and anything without its own menu) gets the sidebar's menu.
      onContextMenu={(event) => {
        if (event.defaultPrevented || !sidebarMenu) return;
        if ((event.target as HTMLElement).closest("input, textarea, [contenteditable='true']")) return;
        openMenu(event, sidebarMenu());
      }}
    >
      <header className="sidebar-header" data-tauri-drag-region>
        <div className="sidebar-header-actions">
          <button className={`sidebar-action is-brand ${mode === "tabs" ? "is-active" : ""}`} aria-label="Tabs" aria-pressed={mode === "tabs"} title="Tabs" onClick={() => onModeChange("tabs")}><span className="brand-mark">S</span></button>
          <button className={`sidebar-action ${mode === "history" ? "is-active" : ""}`} aria-label="History" aria-pressed={mode === "history"} title="History (Ctrl+Y opens the full page)" onClick={() => toggleMode("history")}><History size={19} /></button>
          <button className={`sidebar-action ${mode === "downloads" ? "is-active" : ""}`} aria-label="Downloads" aria-pressed={mode === "downloads"} title="Downloads (Ctrl+J opens the full page)" onClick={() => toggleMode("downloads")}><DownloadIcon downloads={downloads} /></button>
        </div>
        <span className="sidebar-header-space" data-tauri-drag-region />
        <button className="sidebar-action" aria-label="Hide sidebar" title="Hide sidebar (Ctrl+Shift+S)" onClick={onHideSidebar}><PanelLeftClose size={19} /></button>
      </header>

      {mode === "tabs" ? (
        <>
        {props.bookmarks && (
          <section className={`sidebar-section ${props.bookmarksCollapsed ? "" : "is-open"}`}>
            {/* data-bookmark-grid: a tab dropped on the header is bookmarked even while it's collapsed. */}
            <button className="sidebar-section-header" data-bookmark-grid aria-expanded={!props.bookmarksCollapsed} onClick={props.onToggleBookmarks}>
              <ChevronRight size={15} className="sidebar-section-chevron" />
              <span>Bookmarks</span>
              {props.bookmarkCount !== undefined && <small>{props.bookmarkCount}</small>}
            </button>
            {!props.bookmarksCollapsed && props.bookmarks}
          </section>
        )}
        {props.bookmarkEditor}
        <div className="new-tab-group">
          <button className="new-tab-row" onClick={onNew}><Plus size={19} /><span>New tab</span><kbd>Ctrl T</kbd></button>
          <button className="new-private" aria-label="New private tab" title="New private tab (Ctrl+Shift+N)" onClick={onNewPrivate}><VenetianMask size={18} /></button>
        </div>
        </>
      ) : (
        <button className={`new-tab-row ${surface === mode ? "is-current" : ""}`} onClick={() => onSurfaceChange(mode)}>
          <List size={19} /><span>{mode === "history" ? "Show all history" : "Show all downloads"}</span><kbd>{mode === "history" ? "Ctrl Y" : "Ctrl J"}</kbd>
        </button>
      )}

      {mode === "tabs" && (
        <div className="tab-list" role="tablist" aria-label="Open tabs" ref={listRef}>
          {tabs.flatMap((tab, index) => {
            const group = tab.groupId ? groupById.get(tab.groupId) : undefined;
            const startsGroup = !!group && tabs[index - 1]?.groupId !== group.id;
            const color = group ? groupColor(group) : undefined;
            const slot = drag?.slot;
            const lineOn = (row: string) => slot?.row === row ? `is-drop-${slot.pos}` : "";
            let header: ReactNode[] = [];
            if (startsGroup && group) {
              const members = tabs.filter((item) => item.groupId === group.id).length;
              const rowKey = `group:${group.id}`;
              header = [editingGroup === group.id ? (
                <BookmarkEditor
                  key={`group-editor-${group.id}`}
                  heading="Group"
                  bookmark={{ id: group.id, kind: "folder", title: group.name, color }}
                  onSave={({ title }) => onRenameGroup?.(group.id, title)}
                  onColor={(next) => onGroupColor?.(group.id, next)}
                  onCancel={() => onRenameGroup?.(group.id, null)}
                />
              ) : (
                <div
                  key={`group-${group.id}`}
                  className={`tab-group-header ${group.collapsed ? "is-collapsed" : ""} ${slot?.group === group.id ? "is-drop-target" : ""} ${lineOn(rowKey)}`}
                  style={{ "--group": color } as CSSProperties}
                  data-row={rowKey}
                  data-header="1"
                  data-group={group.id}
                  data-first={index}
                  data-last={index + members - 1}
                  data-collapsed={group.collapsed ? "1" : undefined}
                  onContextMenu={(event) => groupMenu && openMenu(event, groupMenu(group))}
                >
                  <button className="tab-group-toggle" aria-expanded={!group.collapsed} onClick={() => onToggleGroup?.(group.id)} onDoubleClick={() => onEditGroup?.(group.id)} title="Click to fold, double-click to edit">
                    <ChevronRight size={15} className="tab-group-chevron" />
                    <span>{group.name}</span>
                    <small>{members}</small>
                  </button>
                </div>
              )];
            }
            if (group?.collapsed) return header;
            const asleep = sleeping.has(tab.id);
            const sound = audio[tab.id];
            const showSpeaker = !!sound && (sound.playing || sound.muted);
            const rowKey = `tab:${tab.id}`;
            const lastInGroup = !!group && tabs[index + 1]?.groupId !== group.id;
            return [...header, (
              <div
                className={`tab-item ${group ? "is-grouped" : ""} ${lastInGroup ? "is-group-end" : ""} ${tab.id === activeId && surface === "browser" ? "is-active" : ""} ${asleep ? "is-asleep" : ""} ${tab.private ? "is-private" : ""} ${drag?.id === tab.id ? "is-dragging" : ""} ${lineOn(rowKey)} ${slot?.row === rowKey && slot.group ? "is-drop-grouped" : ""}`}
                style={color ? ({ "--group": color } as CSSProperties) : undefined}
                key={tab.id}
                data-row={rowKey}
                data-index={index}
                data-group={tab.groupId && group ? tab.groupId : undefined}
                role="tab"
                aria-selected={tab.id === activeId}
                onContextMenu={(event) => openMenu(event, tabMenu(tab, index))}
                onPointerDown={(event) => { if (!(event.target as HTMLElement).closest(".tab-close, .tab-audio")) startTabDrag(event, tab.id); }}
              >
                {group && <i className="tab-group-line" aria-hidden="true" />}
                <span className="tab-lead" onClick={() => { if (!suppressClick.current) onActivate(tab.id); }}>
                  <span className="tab-number" aria-hidden="true">{index + 1}</span>
                  {crashed?.[tab.id]
                    ? <span className="tab-favicon is-crashed" aria-label="Page crashed"><Frown size={14} /></span>
                    : loading?.has(tab.id)
                    ? <span className="tab-favicon tab-spinner" aria-label="Loading" />
                    : tab.private && !tab.favicon
                    ? <span className="tab-favicon" aria-hidden="true"><VenetianMask size={13} /></span>
                    : asleep && !tab.favicon
                      ? <span className="tab-favicon" aria-hidden="true"><Moon size={11} /></span>
                      : <SiteIcon icon={tab.favicon} title={tab.title} url={tab.private ? undefined : tab.url} />}
                  {showSpeaker && (
                    <button className={`tab-audio ${sound.muted ? "is-muted" : ""}`} aria-label={sound.muted ? `Unmute ${tab.title}` : `Mute ${tab.title}`} title={sound.muted ? "Unmute tab" : "Mute tab"} onClick={(event) => { event.stopPropagation(); onToggleMute(tab.id); }}>
                      {sound.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                    </button>
                  )}
                </span>
                <button className="tab-main" onClick={() => { if (!suppressClick.current) onActivate(tab.id); }} title={asleep ? `${tab.title} (inactive, reloads when opened)` : tab.title}>
                  <span className="tab-copy">
                    <strong>{dockedIds?.has(tab.id) && <Columns2 size={12} className="tab-docked" aria-label="Docked" />}{tab.title || "Untitled"}</strong>
                    {detailed && <small>{isHomeUrl(tab.url) ? "Sleet" : displayHost(tab.url)}</small>}
                  </span>
                </button>
                <button className="tab-close" aria-label={`Close ${tab.title}`} onClick={() => onClose(tab.id)}>
                  <X size={18} />
                </button>
              </div>
            )];
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
                  <span className="side-copy"><strong>{download.filename}</strong><DownloadBar download={download} /><small>{status}</small></span>
                </button>
                {download.status === "complete" && <button className="side-row-action" aria-label={`Show ${download.filename} in folder`} title="Show in folder" onClick={() => onRevealDownload(download)}><FolderOpen size={16} /></button>}
              </div>
            );
          })}
          {downloads.length === 0 && <div className="side-empty">No downloads yet</div>}
        </div>
      )}

      <footer className="sidebar-footer" data-tauri-drag-region>
        <span data-tauri-drag-region>{footerLabel}</span>
        <button className={surface === "settings" ? "is-active" : ""} aria-label="Settings" title="Settings (Ctrl+,)" onClick={() => onSurfaceChange(surface === "settings" ? "browser" : "settings")}><Settings2 size={19} /></button>
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
