import { describe, expect, it } from "vitest";
import type { Bookmark } from "./bookmarks";
import { type ImportRoot, planImport } from "./bookmarkImport";

const roots: ImportRoot[] = [
  { title: "Bookmarks bar", grid: true, nodes: [
    { title: "YouTube", url: "https://youtube.com/" },
    { title: "Work", children: [
      { title: "Jira", url: "https://jira.test/" },
      { title: "Docs", children: [{ title: "Spec", url: "https://docs.test/spec" }] },
    ] },
  ] },
  { title: "Other bookmarks", grid: false, nodes: [
    { title: "Dup", url: "https://youtube.com" },
    { title: "Script", url: "javascript:alert(1)" },
    { title: "Reddit", url: "https://reddit.com/" },
  ] },
];

const shape = (tree: Bookmark[]) => tree.map((node) => (node.kind === "folder" ? `${node.title}[${node.children?.map((child) => child.title).join(",")}]` : node.title));

describe("planImport", () => {
  it("keeps folders, flattens nesting and puts the bar in the grid", () => {
    const plan = planImport([], roots, { mode: "folders", gridRoots: true, sourceName: "Edge" });
    expect(shape(plan.tree)).toEqual(["YouTube", "Work[Jira]", "Work / Docs[Spec]", "Other bookmarks[Reddit]"]);
    expect(plan).toMatchObject({ added: 4, skipped: 1, folders: 3 });
  });

  it("can put the bar in a folder instead", () => {
    const plan = planImport([], roots, { mode: "folders", gridRoots: false, sourceName: "Edge" });
    expect(shape(plan.tree)[0]).toBe("Work[Jira]");
    expect(shape(plan.tree)).toContain("Bookmarks bar[YouTube]");
  });

  it("puts everything in one folder", () => {
    const plan = planImport([], roots, { mode: "single", gridRoots: true, sourceName: "Arc" });
    expect(shape(plan.tree)).toEqual(["From Arc[YouTube,Jira,Spec,Reddit]"]);
  });

  it("treats www, http/https and trailing slashes as the same address", () => {
    const existing: Bookmark[] = [{ id: "y", kind: "link", title: "YT", url: "http://www.YouTube.com" }];
    const plan = planImport(existing, roots, { mode: "folders", gridRoots: true, sourceName: "Edge" });
    expect(plan.tree.filter((node) => node.title === "YouTube")).toHaveLength(0);
    expect(plan.skipped).toBe(2);
  });

  it("skips what Sleet already has", () => {
    const existing: Bookmark[] = [{ id: "x", kind: "link", title: "Mine", url: "https://reddit.com" }];
    const plan = planImport(existing, roots, { mode: "single", gridRoots: true, sourceName: "Edge" });
    expect(plan.skipped).toBe(2);
    expect(plan.tree[0].id).toBe("x");
  });
});

// parseBookmarksHtml needs a DOM; it is checked in the browser preview instead.
