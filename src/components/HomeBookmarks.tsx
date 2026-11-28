import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MoreVertical } from "lucide-react";
import { type Cell, footprint, groupAt, gutterOf, headerUnits, type HomeBookmark, type HomeGroup, layoutGroup, resizeGroup, settleBoard, TILE_UNITS } from "../lib/homeBookmarks";
import { BookmarkEditor } from "./BookmarkGrid";
import { SiteIcon } from "./SiteIcon";

const DRAG_THRESHOLD = 5;
/** Space between cells, in CSS pixels. */
const GAP = 6;
/** Most extra units a drag can add under the board by holding the pointer at the bottom edge. */
const MAX_ROOM = 40;

export type GroupTint = "none" | "subtle" | "strong";

/** Group color swatches (Group settings). */
export const GROUP_COLORS: [string, string][] = [
  ["#8e91ff", "Periwinkle"], ["#5fb3ff", "Blue"], ["#45c4d6", "Teal"], ["#4fc79a", "Green"], ["#a6cf4f", "Lime"], ["#f2b84b", "Amber"],
  ["#f5945b", "Orange"], ["#f07c6c", "Coral"], ["#ef7fb8", "Pink"], ["#c08bff", "Violet"], ["#a58a6f", "Brown"], ["#9aa4b2", "Slate"],
];

interface HomeBookmarksProps {
  groups: HomeGroup[];
  /** Tile edge in CSS pixels. */
  size: number;
  /** Show site names under the tiles. */
  showLabels: boolean;
  /** How much a group's background is tinted. */
  tint: GroupTint;
  /** Opens a bookmark in this tab, or a new one (Ctrl/middle click). */
  onOpen: (item: HomeBookmark, newTab: boolean) => void;
  /** Drops a tile on a board cell (`columns`: how many fit the window). Returns the new group's id, if it made one. */
  onDropTile: (id: string, at: Cell, columns: number) => void;
  /** Moves a group's corner to a board cell. */
  onMoveGroup: (id: string, at: Cell, columns: number) => void;
  /** Resizes a group to `cols` by `rows` tiles. */
  onResizeGroup: (id: string, cols: number, rows: number, columns: number) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRecolorGroup: (id: string, color: string | undefined) => void;
  onEdit: (id: string, change: { title: string; url: string }) => void;
  onTileMenu: (x: number, y: number, item: HomeBookmark) => void;
  /** Group settings: open every bookmark in it, or remove it. */
  onOpenGroup: (group: HomeGroup) => void;
  onRemoveGroup: (id: string, withBookmarks: boolean) => void;
  /** Right-click on empty grid: `at` is the cell under the pointer (for "New group here"). */
  onBoardMenu: (x: number, y: number, at: Cell, columns: number) => void;
  /** How many columns fit the window (for placing groups made elsewhere, like the New group button). */
  onColumns: (columns: number) => void;
  onGroupMenu: (x: number, y: number, group: HomeGroup) => void;
  /** Bookmark being edited or group whose settings are open, and group being named in place. */
  editing: string | null;
  onEditingChange: (id: string | null) => void;
  renaming: string | null;
  onRenamingChange: (id: string | null) => void;
}

type Drag =
  | { kind: "tile"; id: string; x: number; y: number; cell: Cell | null }
  | { kind: "group"; id: string; left: number; top: number; cell: Cell | null }
  | { kind: "resize"; id: string; cols: number; rows: number };

/**
 * Bookmarks on the Home page, laid out like the Windows 10 Start screen: one
 * grid, as many columns as fit the window. Groups sit anywhere on it and are
 * as big as their tiles. Drag a group by its name to any grid location and
 * its tiles come along; drag a tile into a group (or just beside one) to put
 * it in that cell, or onto empty grid to start a new group there.
 */
export function HomeBookmarks(props: HomeBookmarksProps) {
  const { groups, size, editing, renaming, showLabels, tint } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  /** Units of page left under the board's top (so dragging can use it without making the page scroll), and extra units a drag asked for. */
  const [fill, setFill] = useState(0);
  const [room, setRoom] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const suppressClick = useRef(false);

  // Cell geometry: matches the CSS variables set on the root below.
  const cellW = size + (showLabels ? 26 : 8);
  const cellH = size + (showLabels ? 30 : 8);
  const pitchX = cellW + GAP;
  const unitH = (cellH + GAP) / TILE_UNITS;
  const columns = Math.max(1, Math.floor((available + GAP) / pitchX));

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const style = getComputedStyle(root);
      setAvailable(root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  /** How many units fit between the board's top and the bottom of the visible page. */
  const measureFill = () => {
    const root = rootRef.current;
    const scroller = root?.closest<HTMLElement>(".home-surface");
    const boardEl = boardRef.current;
    if (!root || !scroller || !boardEl) return;
    const top = boardEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const below = parseFloat(getComputedStyle(root).paddingBottom) || 0;
    setFill(Math.max(0, Math.floor((scroller.clientHeight - top - below - 1) / unitH)));
  };

  // While a group is resized, the board shows the result live (tiles reflow, neighbors move).
  const { onColumns } = props;
  useEffect(() => { onColumns(columns); }, [columns, onColumns]);

  const board = drag?.kind === "resize" ? resizeGroup(groups, drag.id, drag.cols, drag.rows, columns) : settleBoard(groups, columns);
  const areas = new Map(board.map((group) => [group.id, footprint(group)]));
  const right = Math.max(columns, ...[...areas.values()].map((area) => area.x + area.w));
  // While dragging, the board reaches the bottom of the window (somewhere to drop, with no
  // scrollbar); only holding the pointer at the bottom edge makes the page longer.
  const content = Math.max(TILE_UNITS + 1, ...[...areas.values()].map((area) => area.y + area.h));
  const bottom = drag ? Math.max(content, fill + room) : content;
  const dragged = drag?.kind === "tile" ? board.flatMap((group) => group.items).find((item) => item.id === drag.id) : undefined;

  /** The board cell under a point on screen (columns, units), or null off the board. */
  const cellAt = (x: number, y: number): Cell | null => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect || x < rect.left || y < rect.top || x > rect.right + pitchX) return null;
    return { x: Math.max(0, Math.floor((x - rect.left) / pitchX)), y: Math.max(0, Math.floor((y - rect.top) / unitH)) };
  };

  /** Scrolls the page while a drag is near its top or bottom edge. */
  const autoScroll = (y: number) => {
    const scroller = rootRef.current?.closest<HTMLElement>(".home-surface");
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    if (y > rect.bottom - 48) {
      // At the end of the page: make a little more room to drag into.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) setRoom((units) => Math.min(MAX_ROOM, units + TILE_UNITS));
      scroller.scrollBy(0, 14);
    } else if (y < rect.top + 48) scroller.scrollBy(0, -14);
  };

  /** Shared pointer tracking: past the threshold it calls `move`; on release, `drop` (if it moved). */
  const track = (event: ReactPointerEvent<HTMLElement>, move: (x: number, y: number) => void, drop: (ok: boolean) => void, bodyClass = "is-dragging-tile") => {
    const [startX, startY] = [event.clientX, event.clientY];
    const element = event.currentTarget;
    let active = false;
    const controller = new AbortController();
    window.addEventListener("pointermove", (next) => {
      if (!active && Math.hypot(next.clientX - startX, next.clientY - startY) < DRAG_THRESHOLD) return;
      if (!active) {
        active = true;
        measureFill();
        setRoom(0);
        document.body.classList.add(bodyClass);
        try { element.setPointerCapture(next.pointerId); } catch { /* not capturable */ }
      }
      autoScroll(next.clientY);
      move(next.clientX, next.clientY);
    }, { signal: controller.signal });
    const finish = (end: PointerEvent) => {
      controller.abort();
      document.body.classList.remove(bodyClass);
      setDrag(null);
      if (!active) return;
      suppressClick.current = true;
      requestAnimationFrame(() => { suppressClick.current = false; });
      drop(end.type === "pointerup");
    };
    window.addEventListener("pointerup", finish, { signal: controller.signal });
    window.addEventListener("pointercancel", finish, { signal: controller.signal });
  };

  const startTileDrag = (event: ReactPointerEvent<HTMLElement>, item: HomeBookmark) => {
    if (event.button !== 0) return;
    let cell: Cell | null = null;
    track(event, (x, y) => {
      cell = cellAt(x, y);
      setDrag({ kind: "tile", id: item.id, x, y, cell });
    }, (ok) => {
      if (!ok || !cell) return;
      props.onDropTile(item.id, cell, columns);
    });
  };

  const startGroupDrag = (event: ReactPointerEvent<HTMLElement>, group: HomeGroup) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("input")) return;
    // Where the group was grabbed, so it moves with the pointer instead of jumping to it.
    const rect = (event.currentTarget.closest("[data-home-group]") as HTMLElement).getBoundingClientRect();
    const [dx, dy] = [event.clientX - rect.left, event.clientY - rect.top];
    let cell: Cell | null = null;
    track(event, (x, y) => {
      const boardRect = boardRef.current!.getBoundingClientRect();
      cell = { x: Math.max(0, Math.round((x - dx - boardRect.left) / pitchX)), y: Math.max(0, Math.round((y - dy - boardRect.top) / unitH)) };
      // The group follows the pointer in window coordinates (fixed), so it never makes the page longer.
      setDrag({ kind: "group", id: group.id, left: x - dx, top: y - dy, cell });
    }, (ok) => { if (ok && cell) props.onMoveGroup(group.id, cell, columns); });
  };

  /** Drags a group's right edge, bottom edge or corner: its size snaps to whole tiles. */
  const startResize = (event: ReactPointerEvent<HTMLElement>, group: HomeGroup, axes: "x" | "y" | "xy") => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const area = areas.get(group.id)!;
    const startCols = area.w;
    const startRows = (area.h - 1) / TILE_UNITS;
    let size = { cols: startCols, rows: startRows };
    track(event, (x, y) => {
      const boardRect = boardRef.current!.getBoundingClientRect();
      const left = boardRect.left + area.x * pitchX;
      const top = boardRect.top + (area.y + 1) * unitH;
      size = {
        cols: axes === "y" ? startCols : Math.max(1, Math.round((x - left + GAP) / pitchX)),
        rows: axes === "x" ? startRows : Math.max(1, Math.round((y - top + GAP) / (unitH * TILE_UNITS))),
      };
      setDrag({ kind: "resize", id: group.id, ...size });
    }, (ok) => { if (ok) props.onResizeGroup(group.id, size.cols, size.rows, columns); }, `is-resizing-${axes}`);
  };

  const openTile = (event: ReactMouseEvent, item: HomeBookmark) => {
    if (suppressClick.current) return;
    props.onOpen(item, event.ctrlKey || event.metaKey || event.button === 1);
  };

  /** Where a dragged tile would land, as a box on the board: a cell of a group, or a new group's outline. */
  const tileTarget = (() => {
    if (drag?.kind !== "tile" || !drag.cell) return null;
    const target = groupAt(board, drag.cell);
    if (!target) return { x: drag.cell.x, y: drag.cell.y, w: 1, h: TILE_UNITS, isNew: true, groupId: null, inGutter: false };
    const lx = Math.max(0, drag.cell.x - target.x!);
    const ly = Math.max(0, Math.floor((drag.cell.y - target.y! - 1) / TILE_UNITS));
    const area = areas.get(target.id)!;
    const inGutter = drag.cell.x >= area.x + area.w || drag.cell.y >= area.y + area.h;
    return { x: target.x! + lx, y: target.y! + 1 + ly * TILE_UNITS, w: 1, h: TILE_UNITS, isNew: false, groupId: target.id, inGutter };
  })();
  const groupTarget = drag?.kind === "group" && drag.cell ? { ...areas.get(drag.id)!, x: drag.cell.x, y: drag.cell.y } : null;
  const box = (area: { x: number; y: number; w: number; h: number }): CSSProperties => ({
    left: area.x * pitchX,
    top: area.y * unitH,
    width: area.w * pitchX - GAP,
    height: area.h * unitH - GAP,
  });

  return (
    <div
      ref={rootRef}
      className={`home-bookmarks ${drag ? "is-dragging" : ""} ${showLabels ? "" : "no-labels"} tint-${tint}`}
      style={{ "--home-tile": `${size}px`, "--home-cell": `${cellW}px`, "--home-cell-h": `${cellH}px`, "--home-unit": `${unitH}px` } as CSSProperties}
      aria-label="Bookmarks"
    >
      {groups.length === 0 && <p className="home-board-hint">Bookmark pages with the bookmark button in the address bar (Ctrl+D) and they'll appear here.</p>}
      <div
        ref={boardRef}
        className="home-board"
        style={{ width: right * pitchX - GAP, height: bottom * unitH }}
        onContextMenu={(event) => {
          // Only empty grid: groups and tiles have menus of their own.
          if ((event.target as HTMLElement).closest("[data-home-group], .home-group-settings, .home-editor-pop")) return;
          const at = cellAt(event.clientX, event.clientY);
          if (!at) return;
          event.preventDefault();
          props.onBoardMenu(event.clientX, event.clientY, at, columns);
        }}
      >
        {drag && <div className="home-grid-lines" aria-hidden="true" style={{ backgroundSize: `${pitchX}px ${unitH}px` }} />}
        {/* While dragging a tile: each group's gutter, where a tile still joins (and grows) it. */}
        {drag?.kind === "tile" && board.flatMap((group) => gutterOf(board, group.id).map((run, index) => (
          <div
            key={`${group.id}-${index}`}
            className={`home-gutter ${drag.cell && tileTarget?.groupId === group.id && drag.cell.x >= run.x && drag.cell.x < run.x + run.w && drag.cell.y >= run.y && drag.cell.y < run.y + run.h ? "is-active" : ""}`}
            style={{ ...box(run), ...(group.color ? { "--group-color": group.color } : {}) } as CSSProperties}
            aria-hidden="true"
          />
        )))}
        {groupTarget && <div className="home-drop-outline" style={box(groupTarget)} aria-hidden="true" />}
        {tileTarget && (
          <div className="home-drop-outline is-cell" style={box(tileTarget)} aria-hidden="true" />
        )}
        {board.map((group) => {
          const area = areas.get(group.id)!;
          const moving = drag?.kind === "group" && drag.id === group.id;
          const style: CSSProperties = { ...box(area), ...(group.color ? { "--group-color": group.color } : {}) };
          if (moving) Object.assign(style, { position: "fixed", left: drag.left, top: drag.top });
          const head = headerUnits(group);
          const tiles = layoutGroup(group).map((item) => (
            <button
              key={item.id}
              className={`home-tile ${drag?.kind === "tile" && drag.id === item.id ? "is-dragging" : ""}`}
              style={{ left: item.x * pitchX, top: (head + item.y * TILE_UNITS) * unitH }}
              data-home-tile={item.id}
              data-group={group.id}
              title={`${item.title}\n${item.url}`}
              onPointerDown={(event) => startTileDrag(event, item)}
              onClick={(event) => openTile(event, item)}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); openTile(event, item); } }}
              onContextMenu={(event) => { event.preventDefault(); props.onTileMenu(event.clientX, event.clientY, item); }}
            >
              <span className="home-tile-box"><SiteIcon url={item.url} title={item.title} className="home-tile-icon" /></span>
              {showLabels && <span className="home-tile-label">{item.title || item.url}</span>}
            </button>
          ));
          // A bookmark on its own: just its tile.
          if (group.loose) return <section key={group.id} className="home-loose" style={box(area)} data-home-group={group.id}>{tiles}</section>;
          return (
            <section
              key={group.id}
              className={`home-group ${moving ? "is-dragging" : ""} ${group.color ? "has-color" : ""} ${tileTarget?.groupId === group.id ? "is-target" : ""} ${editing === group.id ? "is-open" : ""} ${drag?.kind === "resize" && drag.id === group.id ? "is-resizing" : ""}`}
              style={style}
              data-home-group={group.id}
            >
              <header
                className="home-group-header"
                style={{ height: unitH - GAP / 2 }}
                onPointerDown={(event) => startGroupDrag(event, group)}
                onContextMenu={(event) => { event.preventDefault(); props.onGroupMenu(event.clientX, event.clientY, group); }}
                // Double-click anywhere on the name strip (not just the name, which can be one letter) to rename.
                onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest(".home-group-more, input")) props.onRenamingChange(group.id); }}
                title="Double-click to rename, drag to move"
              >
                {renaming === group.id ? (
                  <GroupNameInput name={group.name} onDone={(name) => { if (name !== null) props.onRenameGroup(group.id, name); props.onRenamingChange(null); }} />
                ) : (
                  <button className={`home-group-name ${group.name ? "" : "is-unnamed"}`} onClick={() => { if (!suppressClick.current) props.onRenamingChange(group.id); }} title="Click to name the group, drag to move it">
                    {group.name || "Name group"}
                  </button>
                )}
                <button
                  className="home-group-more"
                  title="Group settings"
                  aria-label={`Settings for ${group.name || "this group"}`}
                  aria-expanded={editing === group.id}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => props.onEditingChange(editing === group.id ? null : group.id)}
                >
                  <MoreVertical size={16} />
                </button>
              </header>
              {tiles}
              {group.items.length === 0 && <p className="home-group-empty" style={{ top: unitH }}>Drag bookmarks here</p>}
              {/* Resize: drag the right edge, the bottom edge or the corner. */}
              <div className="home-resize is-right" onPointerDown={(event) => startResize(event, group, "x")} title="Drag to resize the group" aria-hidden="true" />
              <div className="home-resize is-bottom" onPointerDown={(event) => startResize(event, group, "y")} title="Drag to resize the group" aria-hidden="true" />
              <div className="home-resize is-corner" onPointerDown={(event) => startResize(event, group, "xy")} title="Drag to resize the group" aria-hidden="true" />
            </section>
          );
        })}
        {editing && (() => {
          // The editor opens under the bookmark or group it edits.
          for (const group of board) {
            const area = areas.get(group.id)!;
            if (group.id === editing) {
              return (
                <GroupSettings
                  key={group.id}
                  group={group}
                  style={{ left: Math.max(0, (area.x + area.w) * pitchX - GAP - 288), top: (area.y + 1) * unitH }}
                  onRename={(name) => props.onRenameGroup(group.id, name)}
                  onRecolor={(color) => props.onRecolorGroup(group.id, color)}
                  onOpenAll={() => { props.onOpenGroup(group); props.onEditingChange(null); }}
                  onRemove={(withBookmarks) => { props.onRemoveGroup(group.id, withBookmarks); props.onEditingChange(null); }}
                  onClose={() => props.onEditingChange(null)}
                />
              );
            }
            const item = layoutGroup(group).find((entry) => entry.id === editing);
            if (item) {
              return (
                <div className="home-editor-pop" style={{ left: (area.x + item.x) * pitchX, top: (area.y + headerUnits(group) + (item.y + 1) * TILE_UNITS) * unitH }}>
                  <BookmarkEditor
                    key={item.id}
                    bookmark={{ id: item.id, kind: "link", title: item.title, url: item.url }}
                    onSave={({ title, url }) => { props.onEdit(item.id, { title, url: url ?? item.url }); props.onEditingChange(null); }}
                    onColor={() => undefined}
                    onCancel={() => props.onEditingChange(null)}
                  />
                </div>
              );
            }
          }
          return null;
        })()}
      </div>
      {drag?.kind === "tile" && dragged && (
        <div className="home-tile-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          <SiteIcon url={dragged.url} title={dragged.title} className="home-tile-icon" />
        </div>
      )}
    </div>
  );
}

/** A group's settings, under its ⋮ button: name, color swatches, open all, remove. Changes apply as you make them. */
function GroupSettings({ group, style, onRename, onRecolor, onOpenAll, onRemove, onClose }: {
  group: HomeGroup;
  style: CSSProperties;
  onRename: (name: string) => void;
  onRecolor: (color: string | undefined) => void;
  onOpenAll: () => void;
  /** `withBookmarks`: remove its bookmarks too (otherwise they stay on the grid on their own). */
  onRemove: (withBookmarks: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(group.name);
  const current = (group.color ?? "").toLowerCase();
  const custom = !!current && !GROUP_COLORS.some(([color]) => color.toLowerCase() === current);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) { if (event.key === "Escape") onClose(); return; }
      const target = event.target as HTMLElement;
      if (ref.current?.contains(target) || target.closest?.(".home-group-more")) return;
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", close); };
  }, [onClose]);
  const swatch = (color: string | undefined, label: string) => (
    <button
      key={label}
      type="button"
      className={`home-swatch ${color ? "" : "is-default"} ${current === (color ?? "").toLowerCase() ? "is-on" : ""}`}
      style={color ? ({ "--swatch": color } as CSSProperties) : undefined}
      title={label}
      aria-label={label}
      aria-pressed={current === (color ?? "").toLowerCase()}
      onClick={() => onRecolor(color)}
    />
  );
  return (
    <div className="home-group-settings" style={style} ref={ref} role="dialog" aria-label="Group settings">
      <label className="home-settings-field">
        <span>Name</span>
        <input
          value={name}
          placeholder="Name group"
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => onRename(name.trim())}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") { onRename(name.trim()); onClose(); } if (event.key === "Escape") onClose(); }}
        />
      </label>
      <div className="home-settings-field">
        <span>Color</span>
        <div className="home-swatches">
          {swatch(undefined, "Default")}
          {GROUP_COLORS.map(([color, label]) => swatch(color, label))}
          <label className={`home-swatch is-custom ${custom ? "is-on" : ""}`} title="Custom color" style={custom ? ({ "--swatch": group.color } as CSSProperties) : undefined}>
            <input type="color" value={group.color ?? GROUP_COLORS[0][0]} aria-label="Custom color" onChange={(event) => onRecolor(event.target.value)} />
          </label>
        </div>
      </div>
      <div className="home-settings-actions">
        {group.items.length > 0 && <button type="button" onClick={onOpenAll}>Open all in new tabs</button>}
        <button type="button" onClick={() => onRemove(false)} title="The bookmarks stay where they are, outside any group">Remove group, keep bookmarks</button>
        {group.items.length > 0 && <button type="button" className="is-danger" onClick={() => onRemove(true)}>Remove group and its bookmarks</button>}
      </div>
    </div>
  );
}

/** A group's name, typed in place: Enter or leaving saves, Escape cancels (`null`). */
function GroupNameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (next: string | null) => { if (done.current) return; done.current = true; onDone(next === null ? null : next.trim()); };
  return (
    <input
      ref={ref}
      className="home-group-input"
      value={value}
      placeholder="Name group"
      maxLength={40}
      aria-label="Group name"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(value);
        if (event.key === "Escape") finish(null);
      }}
    />
  );
}
