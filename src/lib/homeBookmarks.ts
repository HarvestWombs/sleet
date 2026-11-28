import type { Bookmark } from "./bookmarks";

/**
 * Bookmarks on the Home page, laid out like the Windows 10 Start screen on
 * one grid. Bookmarks sit on the grid on their own or in groups. A group is a
 * name and some tiles; it sits at a grid location and is as big as its tiles
 * (or the size it was resized to). Moving a group moves its tiles with it; a
 * tile dropped in or right next to a group joins it, anywhere else it sits on
 * its own there. Groups are made and removed by hand and can be empty. (The
 * sidebar's grid is a separate, short list: pinned sites.)
 *
 * A bookmark on its own is stored as a `loose` entry: one tile, no name, no
 * background and no name strip, so it moves and settles like any group.
 *
 * Coordinates: columns are tile cells. Rows are half-tile units, so a group's
 * name strip takes one unit and each row of tiles two; a group at `y` has its
 * name in unit `y` and its first row of tiles in units `y + 1` and `y + 2`.
 */

/** `x`, `y`: the tile's cell inside its group (columns, tile rows). Tiles without one fill the first free cells. */
export interface HomeBookmark { id: string; title: string; url: string; x?: number; y?: number }
export interface Cell { x: number; y: number }
/**
 * `x`, `y`: where the group's top-left corner is on the board (columns, units).
 * `cols`, `rows`: its size in tiles, once someone resizes it (otherwise it's as
 * big as its tiles). `color`: its background tint.
 */
export interface HomeGroup { id: string; name: string; items: HomeBookmark[]; x?: number; y?: number; cols?: number; rows?: number; color?: string; loose?: boolean }
/** A group's area on the board, in columns and units. */
export interface Footprint { x: number; y: number; w: number; h: number }

/** Name for bookmarks added without choosing a group. */
export const DEFAULT_GROUP = "Bookmarks";
/** Tiles without a cell fill rows this wide. */
export const AUTO_WIDTH = 3;
/** Board width used to place groups that have no location yet (the page passes the real width). */
export const BOARD_WIDTH = 12;
/** Units per row of tiles. */
export const TILE_UNITS = 2;

export const makeHomeId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);
export const allHomeBookmarks = (groups: HomeGroup[]) => groups.flatMap((group) => group.items);
const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");
const cellKey = (x: number, y: number) => `${x},${y}`;
const isCell = (x: unknown, y: unknown) => Number.isInteger(x) && Number.isInteger(y) && (x as number) >= 0 && (y as number) >= 0;

/** The bookmark for an address, if there is one. */
export function findHomeBookmark(groups: HomeGroup[], url: string): { group: HomeGroup; item: HomeBookmark } | undefined {
  for (const group of groups) {
    const item = group.items.find((entry) => sameUrl(entry.url, url));
    if (item) return { group, item };
  }
  return undefined;
}

// ---- Tiles inside a group

const isSize = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

/**
 * Each tile's cell in its group: saved cells kept, the rest in the first free
 * cells, row by row. A resized group's tiles stay inside its size: tiles left
 * outside it (it got smaller) move to the first free cells inside, and only
 * if there's no room does it get more rows.
 */
export function layoutGroup(group: HomeGroup): (HomeBookmark & Cell)[] {
  const cols = isSize(group.cols) ? group.cols : undefined;
  const rows = isSize(group.rows) ? group.rows : undefined;
  const inside = (x: number, y: number) => (cols === undefined || x < cols) && (rows === undefined || y < rows);
  const taken = new Set<string>();
  const placed = new Map<string, Cell>();
  for (const item of group.items) {
    if (isCell(item.x, item.y) && inside(item.x!, item.y!) && !taken.has(cellKey(item.x!, item.y!))) {
      taken.add(cellKey(item.x!, item.y!));
      placed.set(item.id, { x: item.x!, y: item.y! });
    }
  }
  const width = cols ?? Math.max(AUTO_WIDTH, ...[...placed.values()].map((cell) => cell.x + 1));
  let next = 0;
  for (const item of group.items) {
    if (placed.has(item.id)) continue;
    while (taken.has(cellKey(next % width, Math.floor(next / width)))) next += 1;
    const cell = { x: next % width, y: Math.floor(next / width) };
    taken.add(cellKey(cell.x, cell.y));
    placed.set(item.id, cell);
  }
  return group.items.map((item) => ({ ...item, ...placed.get(item.id)! }));
}

/** Rows of tiles a laid-out group has. */
export const rowsUsed = (cells: Cell[]) => cells.reduce((rows, cell) => Math.max(rows, cell.y + 1), 0);

/** Units a group's name strip takes (none for a bookmark on its own). */
export const headerUnits = (group: HomeGroup) => (group.loose ? 0 : 1);
/** Named groups, not bookmarks on their own. */
export const realGroups = (groups: HomeGroup[]) => groups.filter((group) => !group.loose);

/** A group's area: its size (or as wide as its tiles), and its name strip plus its rows of tiles tall. */
export function footprint(group: HomeGroup): Footprint {
  const cells = layoutGroup(group);
  const w = Math.max(isSize(group.cols) ? group.cols : 1, ...cells.map((cell) => cell.x + 1));
  const h = headerUnits(group) + TILE_UNITS * Math.max(isSize(group.rows) ? group.rows : 1, rowsUsed(cells));
  return { x: group.x ?? 0, y: group.y ?? 0, w, h };
}

const overlaps = (a: Footprint, b: Footprint) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Tightens a group around its tiles: an empty column on the left or an empty
 * row on top goes, and the group's corner moves so the tiles stay put. A size
 * someone chose by resizing is kept (empty space and all).
 */
function tighten(group: HomeGroup): HomeGroup {
  const cells = layoutGroup(group);
  if (cells.length === 0) return group;
  const minX = isSize(group.cols) ? 0 : Math.min(...cells.map((cell) => cell.x));
  const minY = isSize(group.rows) ? 0 : Math.min(...cells.map((cell) => cell.y));
  const located = isCell(group.x, group.y);
  return {
    ...group,
    x: located ? group.x! + minX : undefined,
    y: located ? group.y! + TILE_UNITS * minY : undefined,
    items: cells.map((cell) => ({ ...cell, x: cell.x - minX, y: cell.y - minY })),
  };
}

/**
 * Settles the board: every group gets a location (new ones in the first free
 * spot, left to right, top to bottom, within `width` columns), and a group
 * that overlaps another moves down until it's clear. Groups listed in
 * `first` keep their place; the rest give way to them.
 */
export function settleBoard(groups: HomeGroup[], width = BOARD_WIDTH, first: string[] = []): HomeGroup[] {
  // A bookmark on its own goes when its bookmark does; groups stay until removed, even empty.
  const kept = groups.filter((group) => group.items.length > 0 || !group.loose).map(tighten);
  const located = kept.filter((group) => isCell(group.x, group.y));
  const unplaced = kept.filter((group) => !isCell(group.x, group.y));
  const order = [
    ...located.filter((group) => first.includes(group.id)),
    ...located.filter((group) => !first.includes(group.id)).sort((a, b) => a.y! - b.y! || a.x! - b.x!),
  ];
  const settled: HomeGroup[] = [];
  const areas: Footprint[] = [];
  for (const group of order) {
    const area = footprint(group);
    // On top of another group: move whichever way is shorter, right if it
    // still fits the board, otherwise down. Groups may sit side by side.
    for (let hit = areas.find((other) => overlaps(area, other)); hit; hit = areas.find((other) => overlaps(area, other))) {
      const right = hit.x + hit.w - area.x;
      const down = hit.y + hit.h - area.y;
      if (right <= down && area.x + right + area.w <= Math.max(width, area.x + area.w)) area.x += right;
      else area.y += down;
    }
    settled.push({ ...group, x: area.x, y: area.y });
    areas.push(area);
  }
  // Groups with no location (new, imported or from an older layout): the first
  // free spot, a column and a unit clear of other groups so they don't run together.
  for (const group of unplaced) {
    const size = footprint({ ...group, x: 0, y: 0 });
    const fitWidth = Math.max(width, size.w);
    const clear = (x: number, y: number) => !areas.some((other) => overlaps({ x: x - 1, y: y - 1, w: size.w + 2, h: size.h + 2 }, other));
    for (let y = 0; ; y += 1) {
      const x = Array.from({ length: fitWidth - size.w + 1 }, (_, at) => at).find((at) => clear(at, y));
      if (x !== undefined) {
        settled.push({ ...group, x, y });
        areas.push({ ...size, x, y });
        break;
      }
    }
  }
  // Keep the saved order stable (by position), so lists read top to bottom.
  return settled.sort((a, b) => a.y! - b.y! || a.x! - b.x!);
}

/** Moves a whole group to a board location; its tiles come along, and groups in the way move down. */
export function moveGroupTo(groups: HomeGroup[], id: string, at: Cell, width = BOARD_WIDTH): HomeGroup[] {
  const board = settleBoard(groups, width);
  return settleBoard(board.map((group) => (group.id === id ? { ...group, x: Math.max(0, at.x), y: Math.max(0, at.y) } : group)), width, [id]);
}

/**
 * A group's gutter: the free cells just right of it and just under it, where a
 * dropped tile still joins it (and grows it). Cells another group covers
 * aren't part of it. Returned as runs of board cells (columns, units).
 */
export function gutterOf(board: HomeGroup[], id: string): Footprint[] {
  const group = board.find((entry) => entry.id === id);
  if (!group || group.loose) return [];
  const area = footprint(group);
  const others = board.filter((entry) => entry.id !== id).map(footprint);
  const free = (x: number, y: number) => !others.some((other) => overlaps(other, { x, y, w: 1, h: 1 }));
  const runs: Footprint[] = [];
  // Right: one column, from the top of the group to the bottom of its gutter row.
  let start = -1;
  for (let y = area.y; y <= area.y + area.h + TILE_UNITS; y += 1) {
    const open = y < area.y + area.h + TILE_UNITS && free(area.x + area.w, y);
    if (open && start < 0) start = y;
    if (!open && start >= 0) { runs.push({ x: area.x + area.w, y: start, w: 1, h: y - start }); start = -1; }
  }
  // Under: one row of tiles across the group.
  start = -1;
  for (let x = area.x; x <= area.x + area.w; x += 1) {
    const open = x < area.x + area.w && free(x, area.y + area.h) && free(x, area.y + area.h + 1);
    if (open && start < 0) start = x;
    if (!open && start >= 0) { runs.push({ x: start, y: area.y + area.h, w: x - start, h: TILE_UNITS }); start = -1; }
  }
  return runs;
}

/**
 * Resizes a group to `cols` by `rows` tiles (at least 1 by 1). Tiles that end
 * up outside move to free cells inside; groups it now covers move out of its way.
 */
export function resizeGroup(groups: HomeGroup[], id: string, cols: number, rows: number, width = BOARD_WIDTH): HomeGroup[] {
  const size = { cols: Math.max(1, Math.round(cols)), rows: Math.max(1, Math.round(rows)) };
  const board = settleBoard(groups, width);
  return settleBoard(board.map((group) => {
    if (group.id !== id) return group;
    const resized = { ...group, ...size };
    // Save where every tile is now, so the ones inside stay put next time.
    return { ...resized, items: layoutGroup(resized) };
  }), width, [id]);
}

/** The group a board cell drops into: inside its area, or the column just right of it / the tile row just below it. */
export function groupAt(board: HomeGroup[], at: Cell, exceptId?: string): HomeGroup | undefined {
  const named = realGroups(board);
  const inside = named.find((group) => group.id !== exceptId && overlaps(footprint(group), { x: at.x, y: at.y, w: 1, h: 1 }));
  if (inside) return inside;
  return named.find((group) => {
    if (group.id === exceptId) return false;
    const area = footprint(group);
    const grown = { ...area, w: area.w + 1, h: area.h + TILE_UNITS };
    return overlaps(grown, { x: at.x, y: at.y, w: 1, h: 1 });
  });
}

/** A group without bookmark `id`. A group it leaves empty keeps its size, so it stays where it was, ready for more. */
function liftOut(group: HomeGroup, id: string): HomeGroup {
  if (!group.items.some((item) => item.id === id)) return group;
  const items = layoutGroup(group).filter((item) => item.id !== id);
  if (items.length > 0 || group.loose) return { ...group, items };
  const area = footprint(group);
  return { ...group, items, cols: area.w, rows: (area.h - headerUnits(group)) / TILE_UNITS };
}

/** A bookmark on its own at a board cell (no cell: the first free spot). */
const looseTile = (item: HomeBookmark, at?: Cell): HomeGroup => ({ id: makeHomeId(), name: "", loose: true, x: at?.x, y: at?.y, items: [{ ...item, x: 0, y: 0 }] });

/**
 * Drops a bookmark on a board cell. In or next to a group it joins that group
 * at that cell (a tile already there moves to the next free cell); elsewhere
 * it sits there on its own.
 */
export function dropTile(groups: HomeGroup[], id: string, at: Cell, width = BOARD_WIDTH): { groups: HomeGroup[] } {
  const moving = allHomeBookmarks(groups).find((item) => item.id === id);
  if (!moving) return { groups };
  // Find the target on the board as it looks while dragging (what the page
  // outlines), before the tile leaves its group: lifting it first would shrink
  // its own group and a group could never grow by moving its own tiles.
  const board = settleBoard(groups, width);
  const target = groupAt(board, at);
  const lift = (group: HomeGroup) => liftOut(group, id);
  if (!target) {
    const placed = looseTile(moving, { x: Math.max(0, at.x), y: Math.max(0, at.y) });
    return { groups: settleBoard([...board.map(lift), placed], width, [placed.id]) };
  }
  // Which of the target's cells: dropping on its name strip means its first row.
  const local = { x: Math.max(0, at.x - target.x!), y: Math.max(0, Math.floor((at.y - target.y! - 1) / TILE_UNITS)) };
  const cells = layoutGroup({ ...target, items: target.items.filter((item) => item.id !== id) });
  const occupant = cells.find((cell) => cell.x === local.x && cell.y === local.y);
  const taken = new Set(cells.filter((cell) => cell !== occupant).map((cell) => cellKey(cell.x, cell.y)));
  taken.add(cellKey(local.x, local.y));
  const rowWidth = Math.max(footprint(target).w, local.x + 1);
  const items = cells.map((cell) => {
    if (cell !== occupant) return cell;
    for (let index = local.y * rowWidth + local.x + 1; ; index += 1) {
      const free = { x: index % rowWidth, y: Math.floor(index / rowWidth) };
      if (!taken.has(cellKey(free.x, free.y))) return { ...cell, ...free };
    }
  });
  // A resized group dropped on in its gutter grows to take the tile in.
  const grown = {
    cols: isSize(target.cols) ? Math.max(target.cols, local.x + 1, ...items.map((cell) => cell.x + 1)) : undefined,
    rows: isSize(target.rows) ? Math.max(target.rows, local.y + 1, ...items.map((cell) => cell.y + 1)) : undefined,
  };
  const updated = { ...target, ...grown, items: [...items, { ...moving, ...local }] };
  // settleBoard then tightens every group and drops the one the tile left if it's empty.
  return { groups: settleBoard(board.map((group) => (group.id === target.id ? updated : lift(group))), width, [target.id]) };
}

// ---- Adding, editing, removing

/** Adds a bookmark: into a group's next free cell, or on its own in the first free spot. Never adds the same address twice. */
export function addHomeBookmark(groups: HomeGroup[], item: HomeBookmark, groupId?: string): HomeGroup[] {
  if (findHomeBookmark(groups, item.url)) return groups;
  const target = realGroups(groups).find((group) => group.id === groupId);
  if (!target) return [...groups, looseTile(item)];
  return groups.map((group) => (group === target ? { ...group, items: [...group.items, item] } : group));
}

export function removeHomeBookmark(groups: HomeGroup[], id: string): HomeGroup[] {
  return settleBoard(groups.map((group) => liftOut(group, id)));
}

/** Takes a bookmark out of its group: it sits on its own in the first free spot. */
export function takeOutOfGroup(groups: HomeGroup[], id: string, width = BOARD_WIDTH): HomeGroup[] {
  const found = allHomeBookmarks(groups).find((item) => item.id === id);
  if (!found) return groups;
  const board = settleBoard(groups, width);
  return settleBoard([...board.map((group) => liftOut(group, id)), looseTile({ ...found, x: undefined, y: undefined })], width);
}

/** Makes an empty group, 2 tiles wide and 1 tall, at a board cell (or the first free spot). Returns the board and its id. */
export function addHomeGroup(groups: HomeGroup[], at?: Cell, width = BOARD_WIDTH): { groups: HomeGroup[]; id: string } {
  const group: HomeGroup = { id: makeHomeId(), name: "", cols: 2, rows: 1, items: [], x: at ? Math.max(0, at.x) : undefined, y: at ? Math.max(0, at.y) : undefined };
  return { groups: settleBoard([...settleBoard(groups, width), group], width, [group.id]), id: group.id };
}

export function updateHomeBookmark(groups: HomeGroup[], id: string, change: Partial<Omit<HomeBookmark, "id">>): HomeGroup[] {
  return groups.map((group) => ({ ...group, items: group.items.map((item) => (item.id === id ? { ...item, ...change } : item)) }));
}

/** Moves a bookmark into another group's next free cell ("Move to group"). */
export function moveHomeBookmark(groups: HomeGroup[], id: string, toGroupId: string): HomeGroup[] {
  const found = allHomeBookmarks(groups).find((item) => item.id === id);
  if (!found || !realGroups(groups).some((group) => group.id === toGroupId)) return groups;
  const moving = { ...found, x: undefined, y: undefined };
  const removed = groups.map((group) => liftOut(group, id));
  return settleBoard(removed.map((group) => (group.id === toGroupId ? { ...group, items: [...group.items, moving] } : group)), BOARD_WIDTH, [toGroupId]);
}

export function renameHomeGroup(groups: HomeGroup[], id: string, name: string): HomeGroup[] {
  return groups.map((group) => (group.id === id ? { ...group, name } : group));
}

export function recolorHomeGroup(groups: HomeGroup[], id: string, color: string | undefined): HomeGroup[] {
  return groups.map((group) => (group.id === id ? { ...group, color } : group));
}

/** Removes a group. Its bookmarks stay where they were, on their own, unless `withBookmarks`. */
export function removeHomeGroup(groups: HomeGroup[], id: string, withBookmarks = false): HomeGroup[] {
  const group = groups.find((entry) => entry.id === id);
  if (!group) return groups;
  const rest = groups.filter((entry) => entry !== group);
  if (withBookmarks || !isCell(group.x, group.y)) return withBookmarks ? rest : [...rest, ...group.items.map((item) => looseTile(item))];
  const freed = layoutGroup(group).map((cell) => looseTile(cell, { x: group.x! + cell.x, y: group.y! + headerUnits(group) + cell.y * TILE_UNITS }));
  return settleBoard([...rest, ...freed]);
}

// ---- Bookmark import

/** Groups as the one-level folder tree the bookmark importer works with (bookmarks on their own are top-level links). */
export function groupsToTree(groups: HomeGroup[]): Bookmark[] {
  const link = (item: HomeBookmark): Bookmark => ({ id: item.id, kind: "link" as const, title: item.title, url: item.url });
  return groups.map((group) => (group.loose && group.items[0] ? link(group.items[0]) : {
    id: group.id,
    kind: "folder" as const,
    title: group.name || DEFAULT_GROUP,
    children: group.items.map(link),
  }));
}

/**
 * Back from the importer's tree: each folder is a group; bookmarks outside a
 * folder sit on their own. Groups and bookmarks that were already there keep
 * their place, tiles and color; new ones take free spots.
 */
export function treeToGroups(tree: Bookmark[], previous: HomeGroup[] = []): HomeGroup[] {
  const before = new Map(previous.map((group) => [group.id, group]));
  const looseBefore = new Map(previous.filter((group) => group.loose && group.items[0]).map((group) => [group.items[0].id, group]));
  const groups: HomeGroup[] = [];
  const linkOf = (node: Bookmark): HomeBookmark | null => (node.kind === "link" && node.url ? { id: node.id, title: node.title, url: node.url } : null);
  for (const node of tree) {
    if (node.kind === "folder") {
      const old = before.get(node.id);
      const oldItems = new Map((old?.items ?? []).map((item) => [item.id, item]));
      const items = (node.children ?? []).map(linkOf).filter((item): item is HomeBookmark => !!item).map((item) => oldItems.get(item.id) ?? item);
      if (items.length > 0 || old) groups.push({ ...(old ?? {}), id: node.id, name: node.title, items, loose: undefined });
    } else {
      const item = linkOf(node);
      const old = item && looseBefore.get(item.id);
      if (old) groups.push({ ...old, items: [{ ...old.items[0], title: item.title, url: item.url }] });
      else if (item) groups.push(looseTile(item));
    }
  }
  return settleBoard(groups);
}
