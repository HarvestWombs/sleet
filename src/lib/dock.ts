/**
 * Docked layouts: several tabs shown side by side in the page area, as a tree
 * of splits. A window can keep several layouts; the one holding the active
 * tab is shown, and selecting any of its tabs brings it back.
 */
export type DockNode =
  | { kind: "pane"; tabId: string }
  | { kind: "split"; dir: "row" | "column"; ratio: number; a: DockNode; b: DockNode };

/** Where a tab lands next to another: its left, right, top or bottom half. */
export type DockSide = "left" | "right" | "top" | "bottom";

const pane = (tabId: string): DockNode => ({ kind: "pane", tabId });

/** Tabs in a layout, in reading order. */
export function tabsIn(node: DockNode | null | undefined): string[] {
  if (!node) return [];
  return node.kind === "pane" ? [node.tabId] : [...tabsIn(node.a), ...tabsIn(node.b)];
}

/** Removes a tab; the split it was in gives its space to the other side. A single pane left is no layout. */
export function removeTab(node: DockNode, tabId: string): DockNode | null {
  if (node.kind === "pane") return node.tabId === tabId ? null : node;
  const a = removeTab(node.a, tabId);
  const b = removeTab(node.b, tabId);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/** Splits `target`'s pane, putting `tabId` on `side` of it. */
export function insertNextTo(node: DockNode, target: string, tabId: string, side: DockSide): DockNode {
  if (node.kind === "pane") {
    if (node.tabId !== target) return node;
    const dir = side === "left" || side === "right" ? "row" : "column";
    const first = side === "left" || side === "top";
    return { kind: "split", dir, ratio: 0.5, a: first ? pane(tabId) : node, b: first ? node : pane(tabId) };
  }
  return { ...node, a: insertNextTo(node.a, target, tabId, side), b: insertNextTo(node.b, target, tabId, side) };
}

/** Changes the split at `path` (a string of "a"/"b" steps from the root). */
export function setRatio(node: DockNode, path: string, ratio: number): DockNode {
  if (node.kind === "pane") return node;
  if (path === "") return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  const [step, rest] = [path[0], path.slice(1)];
  return step === "a" ? { ...node, a: setRatio(node.a, rest, ratio) } : { ...node, b: setRatio(node.b, rest, ratio) };
}

/** Drops a tab from every layout (closed, undocked, or about to be docked elsewhere). Layouts left with one pane end. */
export function withoutTab(layouts: DockNode[], tabId: string): DockNode[] {
  return layouts
    .map((layout) => (tabsIn(layout).includes(tabId) ? removeTab(layout, tabId) : layout))
    .filter((layout): layout is DockNode => !!layout && layout.kind === "split");
}

/**
 * Docks `tabId` on `side` of `target`. The tab leaves any layout it was in;
 * `target` keeps its layout, or starts a new one with the two of them.
 */
export function dockTab(layouts: DockNode[], tabId: string, target: string, side: DockSide): DockNode[] {
  if (tabId === target) return layouts;
  const rest = withoutTab(layouts, tabId);
  const index = rest.findIndex((layout) => tabsIn(layout).includes(target));
  if (index === -1) return [...rest, insertNextTo(pane(target), target, tabId, side)];
  return rest.map((layout, i) => (i === index ? insertNextTo(layout, target, tabId, side) : layout));
}

/** Keeps only tabs that still exist. */
export function pruneLayouts(layouts: DockNode[], tabIds: Set<string>): DockNode[] {
  let result = layouts;
  for (const id of new Set(result.flatMap(tabsIn))) {
    if (!tabIds.has(id)) result = withoutTab(result, id);
  }
  return result;
}

/** Which side of a box a point is nearest to, or `null` in the middle (no docking there). */
export function sideAt(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): DockSide | null {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const edges: [DockSide, number][] = [["left", fx], ["right", 1 - fx], ["top", fy], ["bottom", 1 - fy]];
  const [side, distance] = edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best));
  return distance < 0.34 ? side : null;
}
