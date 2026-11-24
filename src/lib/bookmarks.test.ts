import { describe, expect, it } from "vitest";
import { type Bookmark, findBookmark, findByUrl, groupBookmarks, moveBookmark, removeBookmark, ungroupFolder } from "./bookmarks";

const link = (id: string): Bookmark => ({ id, kind: "link", title: id, url: `https://${id}.test/` });
const ids = (tree: Bookmark[]) => tree.map((node) => (node.kind === "folder" ? `[${node.children?.map((child) => child.id).join(",")}]` : node.id));

describe("groupBookmarks", () => {
  it("makes a folder where the target was", () => {
    const tree = groupBookmarks([link("a"), link("b"), link("c")], "c", "a");
    expect(ids(tree)).toEqual(["[a,c]", "b"]);
    expect(tree[0].kind).toBe("folder");
  });

  it("adds to an existing folder", () => {
    const grouped = groupBookmarks([link("a"), link("b"), link("c")], "b", "a");
    const folderId = findBookmark(grouped, "a")!.parentId!;
    expect(ids(groupBookmarks(grouped, "c", folderId))).toEqual(["[a,b,c]"]);
    // Dropping onto a bookmark inside the folder joins the folder too.
    expect(ids(groupBookmarks(grouped, "c", "b"))).toEqual(["[a,b,c]"]);
  });

  it("never nests folders", () => {
    const grouped = groupBookmarks([link("a"), link("b"), link("c")], "b", "a");
    const folderId = grouped[0].id;
    expect(groupBookmarks(grouped, folderId, "c")).toBe(grouped);
  });
});

describe("moveBookmark", () => {
  it("reorders at the top level", () => {
    expect(ids(moveBookmark([link("a"), link("b"), link("c")], "a", null, 3))).toEqual(["b", "c", "a"]);
    expect(ids(moveBookmark([link("a"), link("b"), link("c")], "c", null, 0))).toEqual(["c", "a", "b"]);
  });

  it("moving the last bookmark out of a folder removes the folder", () => {
    let tree = groupBookmarks([link("a"), link("b")], "b", "a");
    tree = moveBookmark(tree, "a", null, 1);
    tree = moveBookmark(tree, "b", null, 0);
    expect(ids(tree)).toEqual(["b", "a"]);
  });
});

describe("other operations", () => {
  it("removes, ungroups and finds by address", () => {
    const grouped = groupBookmarks([link("a"), link("b"), link("c")], "b", "a");
    expect(ids(ungroupFolder(grouped, grouped[0].id))).toEqual(["a", "b", "c"]);
    expect(ids(removeBookmark(grouped, "c"))).toEqual(["[a,b]"]);
    expect(findByUrl(grouped, "https://b.test")?.id).toBe("b");
  });
});
