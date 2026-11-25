import { FOLDER_COLORS } from "./bookmarks";

/**
 * Tab groups: tabs kept together under a header in the sidebar, which folds
 * open and closed like a bookmark folder. A tab's `groupId` says which group
 * it is in; a group's tabs always sit next to each other in the tab list.
 */
export interface TabGroup {
  id: string;
  name: string;
  /** A CSS color, picked like a bookmark folder's (older groups saved a color name). */
  color: string;
  collapsed?: boolean;
  /** Made for a docked layout: tabs leave it when they leave the layout. */
  docked?: boolean;
}

/** Colors offered for groups: the same swatches as bookmark folders. */
export const GROUP_COLORS = FOLDER_COLORS;

/** Colors saved by name before groups used folder colors. */
const NAMED: Record<string, string> = { blue: "#5fb3ff", green: "#4fc79a", yellow: "#f2b84b", orange: "#f2a04b", red: "#f07c6c", purple: "#c08bff", gray: "#8a8f9c" };

/** The CSS color to draw a group with. */
export const groupColor = (group: TabGroup) => NAMED[group.color] ?? group.color;

interface Groupable { id: string; groupId?: string }

/** Keeps each group's tabs together, where the group's first tab is. Order inside a group is kept. */
export function keepGroupsTogether<T extends Groupable>(tabs: T[]): T[] {
  const placed = new Set<string>();
  const result: T[] = [];
  for (const tab of tabs) {
    if (!tab.groupId) { result.push(tab); continue; }
    if (placed.has(tab.groupId)) continue;
    placed.add(tab.groupId);
    result.push(...tabs.filter((item) => item.groupId === tab.groupId));
  }
  return result;
}

/** Puts tabs in a group (or none), moving them to the end of that group. */
export function setGroup<T extends Groupable>(tabs: T[], ids: string[], groupId: string | undefined): T[] {
  const moving = new Set(ids);
  const changed = tabs.map((tab) => (moving.has(tab.id) ? { ...tab, groupId } : tab));
  if (!groupId) return keepGroupsTogether(changed);
  const members = changed.filter((tab) => tab.groupId === groupId && !moving.has(tab.id));
  if (members.length === 0) return keepGroupsTogether(changed);
  // Joining tabs go after the group's current last tab.
  const rest = changed.filter((tab) => !moving.has(tab.id));
  const at = rest.indexOf(members[members.length - 1]) + 1;
  return keepGroupsTogether([...rest.slice(0, at), ...changed.filter((tab) => moving.has(tab.id)), ...rest.slice(at)]);
}

/**
 * After a tab was dragged to `index` in `tabs` (already moved), which group it
 * belongs to: dropped between two tabs of one group, it joins; dropped next to
 * its own group it stays; anywhere else it leaves its group.
 */
export function groupAfterMove<T extends Groupable>(tabs: T[], index: number): string | undefined {
  const tab = tabs[index];
  const before = tabs[index - 1]?.groupId;
  const after = tabs[index + 1]?.groupId;
  if (before && before === after) return before;
  if (tab?.groupId && (tab.groupId === before || tab.groupId === after)) return tab.groupId;
  return undefined;
}

/** Groups that still have tabs. */
export function liveGroups<T extends Groupable>(groups: TabGroup[], tabs: T[]): TabGroup[] {
  const used = new Set(tabs.map((tab) => tab.groupId).filter(Boolean));
  return groups.filter((group) => used.has(group.id));
}

/** A name for a new group: "Group 1", "Group 2"… */
export function nextGroupName(groups: TabGroup[]) {
  const taken = new Set(groups.map((group) => group.name));
  let n = 1;
  while (taken.has(`Group ${n}`)) n += 1;
  return `Group ${n}`;
}

/** The next color not in use, cycling once all are taken. */
export function nextGroupColor(groups: TabGroup[]): string {
  return GROUP_COLORS.find((color) => !groups.some((group) => groupColor(group).toLowerCase() === color.toLowerCase())) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length];
}
