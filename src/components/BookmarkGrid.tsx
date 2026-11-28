import { FolderOpen } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { type Bookmark, FOLDER_COLORS } from "../lib/bookmarks";
import { SiteIcon } from "./SiteIcon";

export type BookmarkState = "active" | "open" | null;

interface BookmarkGridProps {
  bookmarks: Bookmark[];
  /** Folders currently expanded. */
  expanded: string[];
  stateOf: (bookmark: Bookmark) => BookmarkState;
  onOpen: (bookmark: Bookmark, inNewTab: boolean) => void;
  onToggleFolder: (folderId: string) => void;
  /** Edit a folder's label and color. */
  onEditFolder: (folder: Bookmark) => void;
  onMove: (id: string, parentId: string | null, index: number) => void;
  onGroup: (dragId: string, targetId: string) => void;
  onContextMenu: (x: number, y: number, bookmark: Bookmark) => void;
}

type Zone = "before" | "after" | "into";
interface DropTarget { id?: string; parentId: string | null; index: number; zone: Zone | "end" }

const DRAG_THRESHOLD = 4;

/**
 * Pinned sites as a grid of icon tiles at the top of the sidebar (like Arc's
 * favorites). Dropping one tile onto another makes a folder (like Discord);
 * a folder shows a preview of its sites and expands into a tinted panel.
 */
export function BookmarkGrid({ bookmarks, expanded, stateOf, onOpen, onToggleFolder, onEditFolder, onMove, onGroup, onContextMenu }: BookmarkGridProps) {
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; target: DropTarget | null } | null>(null);
  const suppressClick = useRef(false);

  /** Where a drop at (x, y) would land, from the element under the pointer. */
  const targetAt = (x: number, y: number, dragged: Bookmark | undefined): DropTarget | null => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const tile = element?.closest<HTMLElement>("[data-bm-id]");
    if (tile) {
      const id = tile.dataset.bmId!;
      const parentId = tile.dataset.bmParent || null;
      const index = Number(tile.dataset.bmIndex);
      const rect = tile.getBoundingClientRect();
      const ratio = (x - rect.left) / rect.width;
      const canGroup = dragged?.kind === "link" && id !== dragged.id;
      const zone: Zone = ratio < 0.28 ? "before" : ratio > 0.72 ? "after" : canGroup ? "into" : ratio < 0.5 ? "before" : "after";
      return { id, parentId, index, zone };
    }
    const panel = element?.closest<HTMLElement>("[data-bm-panel]");
    if (panel) return { parentId: panel.dataset.bmPanel!, index: Number.MAX_SAFE_INTEGER, zone: "end" };
    if (element?.closest("[data-bookmark-grid]")) return { parentId: null, index: Number.MAX_SAFE_INTEGER, zone: "end" };
    return null;
  };

  const findNode = (id: string) => bookmarks.flatMap((node) => [node, ...(node.children ?? [])]).find((node) => node.id === id);

  const startDrag = (event: ReactPointerEvent, bookmark: Bookmark) => {
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    let active = false;
    let target: DropTarget | null = null;
    const controller = new AbortController();
    window.addEventListener("pointermove", (move) => {
      if (!active && Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_THRESHOLD) return;
      if (!active) { active = true; document.body.classList.add("is-dragging-bookmark"); }
      target = targetAt(move.clientX, move.clientY, bookmark);
      setDrag({ id: bookmark.id, x: move.clientX, y: move.clientY, target });
    }, { signal: controller.signal });
    const finish = () => {
      controller.abort();
      document.body.classList.remove("is-dragging-bookmark");
      setDrag(null);
      if (!active) return;
      suppressClick.current = true;
      requestAnimationFrame(() => { suppressClick.current = false; });
      if (!target) return;
      if (target.zone === "into" && target.id) onGroup(bookmark.id, target.id);
      else if (target.zone === "end") onMove(bookmark.id, target.parentId, target.index);
      else onMove(bookmark.id, target.parentId, target.index + (target.zone === "after" ? 1 : 0));
    };
    window.addEventListener("pointerup", finish, { signal: controller.signal });
    window.addEventListener("pointercancel", finish, { signal: controller.signal });
  };

  const click = (event: ReactMouseEvent, bookmark: Bookmark) => {
    if (suppressClick.current) return;
    if (bookmark.kind === "folder") onToggleFolder(bookmark.id);
    else onOpen(bookmark, event.ctrlKey || event.metaKey || event.button === 1);
  };

  const dropClass = (id: string) => {
    const target = drag?.target;
    if (!target || target.id !== id || drag?.id === id) return "";
    return `is-drop-${target.zone}`;
  };

  const tile = (bookmark: Bookmark, parentId: string | null, index: number) => {
    const state = bookmark.kind === "link" ? stateOf(bookmark) : null;
    const isOpenFolder = bookmark.kind === "folder" && expanded.includes(bookmark.id);
    const childStates = bookmark.kind === "folder" ? (bookmark.children ?? []).map(stateOf) : [];
    const folderState: BookmarkState = childStates.includes("active") ? "active" : childStates.includes("open") ? "open" : null;
    return (
      <button
        key={bookmark.id}
        className={`bm-tile ${bookmark.kind === "folder" ? "is-folder" : ""} ${isOpenFolder ? "is-expanded" : ""} ${state ?? folderState ? `is-${state ?? folderState}` : ""} ${drag?.id === bookmark.id ? "is-dragging" : ""} ${dropClass(bookmark.id)}`}
        style={bookmark.color ? ({ "--folder-color": bookmark.color } as React.CSSProperties) : undefined}
        data-bm-id={bookmark.id}
        data-bm-parent={parentId ?? ""}
        data-bm-index={index}
        title={bookmark.kind === "folder" ? `${bookmark.title} (${bookmark.children?.length ?? 0})` : bookmark.multiTab ? `${bookmark.title}
Opens a new tab every time` : bookmark.title}
        aria-label={bookmark.title}
        aria-expanded={bookmark.kind === "folder" ? isOpenFolder : undefined}
        onPointerDown={(event) => startDrag(event, bookmark)}
        onClick={(event) => click(event, bookmark)}
        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); click(event, bookmark); } }}
        onContextMenu={(event) => { event.preventDefault(); onContextMenu(event.clientX, event.clientY, bookmark); }}
      >
        {bookmark.kind === "folder"
          ? isOpenFolder
            ? <FolderOpen size={20} className="bm-folder-glyph" />
            : (
              <span className="bm-preview" data-count={Math.min(bookmark.children?.length ?? 0, 4)} aria-hidden="true">
                {(bookmark.children ?? []).slice(0, 4).map((child) => <SiteIcon key={child.id} url={child.url} title={child.title} className="bm-mini" />)}
              </span>
            )
          : <SiteIcon url={bookmark.url} title={bookmark.title} className="bm-icon" />}
        <i className="bm-indicator" aria-hidden="true" />
        {bookmark.multiTab && <i className="bm-multi" aria-hidden="true" />}
      </button>
    );
  };

  const dragged = drag ? findNode(drag.id) : undefined;

  return (
    <div className={`bookmark-grid ${drag?.target?.zone === "end" && drag.target.parentId === null ? "is-drop-end" : ""}`} data-bookmark-grid aria-label="Bookmarks">
      {bookmarks.map((bookmark, index) => {
        const isOpenFolder = bookmark.kind === "folder" && expanded.includes(bookmark.id);
        return [
          tile(bookmark, null, index),
          isOpenFolder && (
            <div
              key={`${bookmark.id}-panel`}
              className={`bm-panel ${drag?.target?.zone === "end" && drag.target.parentId === bookmark.id ? "is-drop-end" : ""}`}
              style={{ "--folder-color": bookmark.color } as React.CSSProperties}
              data-bm-panel={bookmark.id}
            >
              <span className="bm-panel-title" title="Double-click to edit" onDoubleClick={() => onEditFolder(bookmark)}>{bookmark.title}</span>
              <div className="bm-panel-grid">
                {(bookmark.children ?? []).map((child, childIndex) => tile(child, bookmark.id, childIndex))}
              </div>
            </div>
          ),
        ];
      })}
      {bookmarks.length === 0 && <p className="bm-empty">Click the star (Ctrl+Shift+D) or drag a tab here to pin a site</p>}
      {drag && dragged && (
        <div className="bm-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          {dragged.kind === "folder" ? <FolderOpen size={20} /> : <SiteIcon url={dragged.url} title={dragged.title} className="bm-icon" />}
        </div>
      )}
    </div>
  );
}

/**
 * Inline editor shown in the sidebar (pages can't cover it there). Bookmarks:
 * name and address. Folders: label and color; color changes apply right away.
 */
export function BookmarkEditor({ bookmark, onSave, onColor, onCancel, heading }: {
  bookmark: Bookmark;
  onSave: (patch: { title: string; url?: string }) => void;
  onColor: (color: string) => void;
  onCancel: () => void;
  /** Title over the fields (tab groups use this editor too). */
  heading?: string;
}) {
  const [title, setTitle] = useState(bookmark.title);
  const [url, setUrl] = useState(bookmark.url ?? "");
  const [color, setColor] = useState(bookmark.color ?? FOLDER_COLORS[0]);
  const pick = (next: string) => { setColor(next); onColor(next); };
  const isFolder = bookmark.kind === "folder";
  return (
    <form
      className="bm-editor"
      style={isFolder ? ({ "--folder-color": color } as React.CSSProperties) : undefined}
      onSubmit={(event) => { event.preventDefault(); onSave({ title: title.trim() || bookmark.title, url: isFolder ? undefined : url.trim() || bookmark.url }); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}
    >
      <strong>{heading ?? (isFolder ? "Folder" : "Edit bookmark")}</strong>
      <input autoFocus value={title} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setTitle(event.target.value)} aria-label={isFolder ? "Folder label" : "Name"} placeholder={isFolder ? "Label" : "Name"} />
      {!isFolder && <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Address" placeholder="https://" spellCheck={false} />}
      {isFolder && (
        <div className="bm-swatches" role="radiogroup" aria-label="Folder color">
          {FOLDER_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={color.toLowerCase() === swatch.toLowerCase()}
              aria-label={`Color ${swatch}`}
              className={`bm-swatch ${color.toLowerCase() === swatch.toLowerCase() ? "is-on" : ""}`}
              style={{ background: swatch }}
              onClick={() => pick(swatch)}
            />
          ))}
          <label className={`bm-swatch is-custom ${FOLDER_COLORS.some((swatch) => swatch.toLowerCase() === color.toLowerCase()) ? "" : "is-on"}`} title="Custom color">
            <input type="color" value={color} onChange={(event) => pick(event.target.value)} aria-label="Custom folder color" />
          </label>
        </div>
      )}
      <span className="bm-editor-actions">
        <button type="button" onClick={onCancel}>{isFolder ? "Close" : "Cancel"}</button>
        <button type="submit" className="is-primary">Save</button>
      </span>
    </form>
  );
}
