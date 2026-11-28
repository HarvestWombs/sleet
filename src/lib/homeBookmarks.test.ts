import { describe, expect, it } from "vitest";
import { addHomeBookmark, addHomeGroup, dropTile, gutterOf, removeHomeGroup, resizeGroup, takeOutOfGroup, findHomeBookmark, footprint, groupAt, groupsToTree, type HomeGroup, layoutGroup, moveGroupTo, moveHomeBookmark, recolorHomeGroup, removeHomeBookmark, rowsUsed, settleBoard, treeToGroups } from "./homeBookmarks";

const item = (id: string, url = `https://${id}.com/`) => ({ id, title: id, url });
/** Two groups side by side: g1 (3 tiles, 3 wide) at 0,0 and g2 (1 tile) at 4,0. */
const groups = (): HomeGroup[] => [
  { id: "g1", name: "Work", items: [item("a"), item("b"), item("c")], x: 0, y: 0 },
  { id: "g2", name: "Fun", items: [item("d")], x: 4, y: 0 },
];
const ids = (list: HomeGroup[]) => list.map((group) => `${group.id}:${group.items.map((entry) => entry.id).join("")}`).join(" ");
/** Each group's corner: "g1@0,0 g2@4,0". */
const places = (list: HomeGroup[]) => list.map((group) => `${group.id}@${group.x},${group.y}`).join(" ");
/** A tile's group and cell: "g1@2,0". */
const where = (list: HomeGroup[], id: string) => {
  const group = list.find((entry) => entry.items.some((bookmark) => bookmark.id === id))!;
  const cell = layoutGroup(group).find((bookmark) => bookmark.id === id)!;
  return `${group.id}@${cell.x},${cell.y}`;
};

describe("home bookmarks", () => {
  it("adds a bookmark on its own (or into a chosen group), without duplicates", () => {
    expect(addHomeBookmark([], item("x"))[0]).toMatchObject({ loose: true, items: [{ id: "x" }] });
    expect(addHomeBookmark(groups(), item("x")).map((group) => group.loose ?? false)).toEqual([false, false, true]);
    expect(ids(addHomeBookmark(groups(), item("x"), "g2"))).toBe("g1:abc g2:dx");
    expect(ids(addHomeBookmark(groups(), item("y", "https://a.com")))).toBe("g1:abc g2:d");
    expect(findHomeBookmark(groups(), "https://d.com")?.group.id).toBe("g2");
  });

  it("lays tiles out in cells, keeping blanks; groups are as wide as their tiles", () => {
    const group: HomeGroup = { id: "g", name: "", items: [{ ...item("a"), x: 2, y: 1 }, item("b"), item("c")] };
    expect(layoutGroup(group).map((entry) => `${entry.id}@${entry.x},${entry.y}`)).toEqual(["a@2,1", "b@0,0", "c@1,0"]);
    expect(rowsUsed(layoutGroup(group))).toBe(2);
    // Name strip (1 unit) plus two rows of tiles (2 units each).
    expect(footprint(group)).toMatchObject({ w: 3, h: 5 });
    // A tile far to the right makes the group that wide; one tile makes it one wide.
    expect(footprint({ ...group, items: [{ ...item("a"), x: 5, y: 0 }] })).toMatchObject({ w: 6 });
    expect(footprint({ ...group, items: [item("a")] })).toMatchObject({ w: 1, h: 3 });
  });

  it("settles the board: new groups take free spots, overlapping groups move down", () => {
    expect(places(settleBoard(groups()))).toBe("g1@0,0 g2@4,0");
    const placed = settleBoard([...groups(), { id: "g3", name: "", items: [item("e")] }], 6);
    // Kept a column and a unit clear of the others: no room beside them in 6 columns.
    expect(places(placed)).toBe("g1@0,0 g2@4,0 g3@0,4");
    // g2 on top of g1: the later one (by position) moves the shorter way out, keeping a column clear.
    expect(places(settleBoard([groups()[0], { ...groups()[1], x: 1, y: 1 }]))).toBe("g1@0,0 g2@3,1");
    // Below and to the left: down is shorter.
    expect(places(settleBoard([groups()[0], { ...groups()[1], x: 0, y: 2 }]))).toBe("g1@0,0 g2@0,3");
    // Side by side is fine: nothing moves.
    expect(places(settleBoard([groups()[0], { ...groups()[1], x: 3, y: 0 }]))).toBe("g1@0,0 g2@3,0");
    // Empty groups stay (they're removed by hand); a bookmark on its own goes with its bookmark.
    expect(places(settleBoard([...groups(), { id: "e", name: "", items: [], x: 8, y: 0 }]))).toBe("g1@0,0 g2@4,0 e@8,0");
    expect(places(settleBoard([...groups(), { id: "l", name: "", loose: true, items: [], x: 8, y: 0 }]))).toBe("g1@0,0 g2@4,0");
  });

  it("moves a whole group to any grid location, its tiles with it", () => {
    const moved = moveGroupTo(groups(), "g2", { x: 7, y: 6 });
    expect(places(moved)).toBe("g1@0,0 g2@7,6");
    expect(where(moved, "d")).toBe("g2@0,0");
    // Onto another group: the moved one keeps the spot, the other moves out of its way.
    expect(places(moveGroupTo(groups(), "g2", { x: 1, y: 0 }))).toBe("g2@1,0 g1@2,0");
  });

  it("finds the group a cell drops into: inside it or right next to it", () => {
    const board = settleBoard(groups());
    expect(groupAt(board, { x: 2, y: 2 })?.id).toBe("g1");
    expect(groupAt(board, { x: 3, y: 1 })?.id).toBe("g1");
    expect(groupAt(board, { x: 1, y: 4 })?.id).toBe("g1");
    expect(groupAt(board, { x: 8, y: 10 })).toBeUndefined();
  });

  it("drops a tile on any cell of a group, nudging a tile that was there", () => {
    // Unit 3 is g1's second tile row (name strip is unit 0, first row units 1-2).
    const blank = dropTile(groups(), "a", { x: 2, y: 3 });
    // Column 0 is empty now, so the group tightens to start at column 1; the tiles stay put.
    expect(places(blank.groups)).toBe("g1@1,0 g2@4,0");
    expect(where(blank.groups, "a")).toBe("g1@1,1");
    expect(where(blank.groups, "b")).toBe("g1@0,0");
    const bumped = dropTile(groups(), "d", { x: 1, y: 1 }).groups;
    expect(where(bumped, "d")).toBe("g1@1,0");
    // "b" moves to the next free cell; "c" stays put.
    expect(where(bumped, "b")).toBe("g1@0,1");
    expect(where(bumped, "c")).toBe("g1@2,0");
    // g2 is empty now but stays, the same size, until it's removed.
    expect(bumped.map((group) => group.id)).toEqual(["g1", "g2"]);
    expect(footprint(bumped[1])).toMatchObject({ x: 4, w: 1, h: 3 });
    // Just right of a group: it grows a column.
    expect(where(dropTile(groups(), "d", { x: 3, y: 1 }).groups, "d")).toBe("g1@3,0");
  });

  it("grows a group by dragging its own tiles past its edge", () => {
    const pair: HomeGroup[] = [{ id: "g", name: "", x: 0, y: 0, items: [{ ...item("a"), x: 0, y: 0 }, { ...item("b"), x: 1, y: 0 }] }];
    // "a" to the column right of "b": the group becomes 3 wide, it doesn't shift over.
    const wider = dropTile(pair, "a", { x: 2, y: 1 }).groups;
    expect(places(wider)).toBe("g@1,0");
    expect(where(wider, "a")).toBe("g@1,0");
    // Then one further out: still the same group, now spanning columns 1 to 3.
    const wider2 = dropTile(wider, "b", { x: 3, y: 1 }).groups;
    expect(wider2).toHaveLength(1);
    expect(footprint(wider2[0])).toMatchObject({ x: 2, w: 2 });
    // And below: a tile dropped under the last row adds a row.
    const taller = dropTile(pair, "a", { x: 1, y: 3 }).groups;
    expect(footprint(taller[0])).toMatchObject({ x: 1, w: 1, h: 5 });
  });

  it("has a gutter right of and under each group, minus cells other groups cover", () => {
    const board = settleBoard(groups());
    // g1 is 3 wide and 3 units tall: column 3 for units 0-4, and units 3-4 under columns 0-2.
    expect(gutterOf(board, "g1")).toEqual([{ x: 3, y: 0, w: 1, h: 5 }, { x: 0, y: 3, w: 3, h: 2 }]);
    // A neighbor right beside it takes that column away.
    const beside = settleBoard([groups()[0], { ...groups()[1], x: 3, y: 0 }]);
    expect(gutterOf(beside, "g1")).toEqual([{ x: 3, y: 3, w: 1, h: 2 }, { x: 0, y: 3, w: 3, h: 2 }]);
    // Dropping in the neighbor's cells joins the neighbor, not g1.
    expect(groupAt(beside, { x: 3, y: 1 })?.id).toBe("g2");
  });

  it("resizes a group: tiles outside move inside, neighbors move out of the way", () => {
    // g1 is 3 wide (a b c). 2 wide: "c" moves to the next row.
    const narrow = resizeGroup(groups(), "g1", 2, 1);
    expect(footprint(narrow[0])).toMatchObject({ w: 2, h: 5 });
    expect(where(narrow, "c")).toBe("g1@0,1");
    // Wider than its tiles: the empty space stays, and g2 (at column 4) moves right.
    const wide = resizeGroup(groups(), "g1", 5, 2, 12);
    expect(footprint(wide.find((group) => group.id === "g1")!)).toMatchObject({ w: 5, h: 5 });
    expect(places(wide)).toBe("g1@0,0 g2@5,0");
    // Too small for its tiles: it gets the rows it needs.
    expect(footprint(resizeGroup(groups(), "g1", 1, 1)[0])).toMatchObject({ w: 1, h: 7 });
    // A tile leaving a resized group doesn't shrink it.
    const kept = dropTile(wide, "a", { x: 9, y: 9 }, 12).groups;
    expect(footprint(kept.find((group) => group.id === "g1")!)).toMatchObject({ x: 0, w: 5 });
    // Dropping in its gutter (here, the row under it; g2 sits right beside it) grows it.
    const grown = dropTile(wide, "d", { x: 1, y: 5 }, 12).groups;
    expect(footprint(grown.find((group) => group.id === "g1")!)).toMatchObject({ w: 5, h: 7 });
  });

  it("drops a tile on empty grid space: it sits there on its own", () => {
    const result = dropTile(groups(), "b", { x: 8, y: 9 });
    const loose = result.groups.find((group) => group.loose)!;
    expect(loose).toMatchObject({ x: 8, y: 9, items: [{ id: "b", x: 0, y: 0 }] });
    // One tile tall, no name strip.
    expect(footprint(loose)).toMatchObject({ w: 1, h: 2 });
    // The tiles left behind stay where they were.
    expect(where(result.groups, "c")).toBe("g1@2,0");
    // Moving it again moves it (no empty leftovers), and dropping it in a group's gutter puts it in the group.
    const moved = dropTile(result.groups, "b", { x: 10, y: 2 }).groups;
    expect(moved.filter((group) => group.loose).map((group) => `${group.x},${group.y}`)).toEqual(["10,2"]);
    expect(where(dropTile(moved, "b", { x: 3, y: 1 }).groups, "b")).toBe("g1@3,0");
    // A bookmark on its own isn't something to drop into: dropping on it pushes it aside.
    expect(groupAt(moved, { x: 10, y: 2 })).toBeUndefined();
  });

  it("adds and removes groups by hand", () => {
    const added = addHomeGroup(groups(), { x: 8, y: 0 });
    expect(added.groups.find((group) => group.id === added.id)).toMatchObject({ name: "", x: 8, y: 0, items: [] });
    expect(footprint(added.groups.find((group) => group.id === added.id)!)).toMatchObject({ w: 2, h: 3 });
    // Removing a group keeps its bookmarks where they were, on their own.
    const removed = removeHomeGroup(groups(), "g1");
    expect(removed.filter((group) => group.loose).map((group) => `${group.items[0].id}@${group.x},${group.y}`)).toEqual(["a@0,1", "b@1,1", "c@2,1"]);
    expect(removeHomeGroup(groups(), "g1", true).map((group) => group.id)).toEqual(["g2"]);
    // Taking one out of its group: on its own, in a free spot.
    const out = takeOutOfGroup(groups(), "a");
    expect(ids(out.filter((group) => !group.loose))).toBe("g1:bc g2:d");
    expect(out.find((group) => group.loose)?.items[0].id).toBe("a");
  });

  it("moves, removes and recolors", () => {
    expect(where(moveHomeBookmark(groups(), "a", "g2"), "a")).toBe("g2@1,0");
    const removed = removeHomeBookmark(groups(), "a");
    // The group tightens around what's left and keeps the tiles in place on the board.
    expect(places(removed)).toBe("g1@1,0 g2@4,0");
    expect(removeHomeBookmark(groups(), "d").map((group) => group.items.length)).toEqual([3, 0]);
    expect(recolorHomeGroup(groups(), "g2", "#ff0000")[1].color).toBe("#ff0000");
  });

  it("round-trips through the importer's tree, keeping places and colors", () => {
    const start = recolorHomeGroup(moveGroupTo(groups(), "g2", { x: 0, y: 4 }), "g2", "#123456");
    const back = treeToGroups(groupsToTree(start), start);
    expect(places(back)).toBe("g1@0,0 g2@0,4");
    expect(back.find((group) => group.id === "g2")?.color).toBe("#123456");
    const merged = treeToGroups([...groupsToTree(groups()), { id: "f1", kind: "folder", title: "New", children: [{ id: "l1", kind: "link", title: "x", url: "https://x.com/" }] }], groups());
    expect(places(merged)).toBe("g1@0,0 g2@4,0 f1@6,0");
  });
});
