import { describe, expect, it } from "vitest";
import { dockTab, pruneLayouts, removeTab, setRatio, sideAt, tabsIn, withoutTab, type DockNode } from "./dock";

describe("dock layouts", () => {
  it("starts a layout when a tab docks next to another", () => {
    const [layout] = dockTab([], "b", "a", "right");
    expect(tabsIn(layout)).toEqual(["a", "b"]);
    expect(layout).toMatchObject({ kind: "split", dir: "row" });
    const [top] = dockTab([], "b", "a", "top");
    expect(tabsIn(top)).toEqual(["b", "a"]);
    expect(top).toMatchObject({ dir: "column" });
  });

  it("splits the target pane inside an existing layout", () => {
    let layouts = dockTab([], "b", "a", "right");
    layouts = dockTab(layouts, "c", "b", "bottom");
    expect(layouts).toHaveLength(1);
    expect(tabsIn(layouts[0])).toEqual(["a", "b", "c"]);
  });

  it("moves a tab already docked instead of duplicating it", () => {
    let layouts = dockTab(dockTab([], "b", "a", "right"), "c", "a", "left");
    layouts = dockTab(layouts, "c", "b", "right");
    expect(tabsIn(layouts[0])).toEqual(["a", "b", "c"]);
  });

  it("ends a layout left with one pane", () => {
    const layouts = dockTab([], "b", "a", "right");
    expect(withoutTab(layouts, "b")).toEqual([]);
    expect(removeTab(layouts[0], "a")).toEqual({ kind: "pane", tabId: "b" });
    expect(pruneLayouts(dockTab(layouts, "c", "a", "top"), new Set(["a", "c"])).flatMap(tabsIn)).toEqual(["c", "a"]);
  });

  it("clamps split sizes", () => {
    const [layout] = dockTab([], "b", "a", "right");
    expect((setRatio(layout, "", 0.99) as Extract<DockNode, { kind: "split" }>).ratio).toBe(0.85);
  });

  it("finds the side nearest the pointer", () => {
    const box = { left: 0, top: 0, width: 100, height: 100 };
    expect(sideAt(box, 5, 50)).toBe("left");
    expect(sideAt(box, 50, 95)).toBe("bottom");
    expect(sideAt(box, 50, 50)).toBeNull();
  });
});
