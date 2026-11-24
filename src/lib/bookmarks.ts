/**
 * Bookmarks: a flat list of links and one-level folders (like Discord server
 * folders; folders never nest). All operations are pure and return a new tree.
 */
export interface Bookmark {
  id: string;
  kind: "link" | "folder";
  title: string;
  /** Links only. */
  url?: string;
  /** Folders only. */
  children?: Bookmark[];
  /** Folder tint. */
  color?: string;
}

export const FOLDER_COLORS = ["#8e91ff", "#5fb3ff", "#4fc79a", "#f2b84b", "#f07c6c", "#c08bff"];

export const makeBookmarkId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

interface Location { node: Bookmark; parentId: string | null; index: number }

export function findBookmark(tree: Bookmark[], id: string): Location | null {
  for (let index = 0; index < tree.length; index += 1) {
    const node = tree[index];
    if (node.id === id) return { node, parentId: null, index };
    const childIndex = node.children?.findIndex((child) => child.id === id) ?? -1;
    if (childIndex >= 0 && node.children) return { node: node.children[childIndex], parentId: node.id, index: childIndex };
  }
  return null;
}

/** Every link, folders flattened (for lookups like "is this page bookmarked?"). */
export const allLinks = (tree: Bookmark[]): Bookmark[] =>
  tree.flatMap((node) => (node.kind === "folder" ? node.children ?? [] : [node]));

/**
 * Comparison key for addresses: ignores http vs https, "www.", letter case in
 * the host and a trailing slash, so youtube.com and https://www.youtube.com/ match.
 */
export function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${host}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}`;
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}
const sameUrl = (a: string, b: string) => urlKey(a) === urlKey(b);
export const findByUrl = (tree: Bookmark[], url: string) => allLinks(tree).find((link) => link.url && sameUrl(link.url, url));

/** Drops empty folders (a folder disappears once its last bookmark leaves). */
const tidy = (tree: Bookmark[]) => tree.filter((node) => node.kind !== "folder" || (node.children?.length ?? 0) > 0);

function without(tree: Bookmark[], id: string): [Bookmark[], Bookmark | null] {
  let removed: Bookmark | null = null;
  const next = tree
    .filter((node) => (node.id === id ? ((removed = node), false) : true))
    .map((node) => {
      if (removed || !node.children?.some((child) => child.id === id)) return node;
      removed = node.children.find((child) => child.id === id) ?? null;
      return { ...node, children: node.children.filter((child) => child.id !== id) };
    });
  return [next, removed];
}

export function addBookmark(tree: Bookmark[], link: { title: string; url: string }, parentId: string | null = null): Bookmark[] {
  const node: Bookmark = { id: makeBookmarkId(), kind: "link", title: link.title, url: link.url };
  return insertAt(tree, node, parentId, Number.MAX_SAFE_INTEGER);
}

export function removeBookmark(tree: Bookmark[], id: string): Bookmark[] {
  return tidy(without(tree, id)[0]);
}

export function updateBookmark(tree: Bookmark[], id: string, patch: Partial<Pick<Bookmark, "title" | "url" | "color">>): Bookmark[] {
  return tree.map((node) => {
    if (node.id === id) return { ...node, ...patch };
    if (!node.children?.some((child) => child.id === id)) return node;
    return { ...node, children: node.children.map((child) => (child.id === id ? { ...child, ...patch } : child)) };
  });
}

function insertAt(tree: Bookmark[], node: Bookmark, parentId: string | null, index: number): Bookmark[] {
  if (parentId === null) {
    const next = [...tree];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, node);
    return next;
  }
  return tree.map((folder) => {
    if (folder.id !== parentId || folder.kind !== "folder") return folder;
    const children = [...(folder.children ?? [])];
    children.splice(Math.max(0, Math.min(index, children.length)), 0, node);
    return { ...folder, children };
  });
}

/**
 * Moves a bookmark to `index` within `parentId` (null = top level). `index`
 * counts positions in the destination as it is now, before the move.
 * Folders can only live at the top level.
 */
export function moveBookmark(tree: Bookmark[], id: string, parentId: string | null, index: number): Bookmark[] {
  const from = findBookmark(tree, id);
  if (!from) return tree;
  if (from.node.kind === "folder" && parentId !== null) return tree;
  if (parentId === id) return tree;
  const adjusted = from.parentId === parentId && from.index < index ? index - 1 : index;
  const [rest, node] = without(tree, id);
  if (!node) return tree;
  return tidy(insertAt(rest, node, parentId, adjusted));
}

/**
 * Discord-style grouping: dropping a bookmark onto a folder adds it there;
 * dropping it onto another bookmark makes a new folder holding both, where the
 * target was. Folders can't be dropped into anything.
 */
export function groupBookmarks(tree: Bookmark[], dragId: string, targetId: string, folderTitle = "Folder"): Bookmark[] {
  if (dragId === targetId) return tree;
  const drag = findBookmark(tree, dragId);
  const target = findBookmark(tree, targetId);
  if (!drag || !target || drag.node.kind === "folder") return tree;
  if (target.node.kind === "folder") {
    if (drag.parentId === target.node.id) return tree;
    return moveBookmark(tree, dragId, target.node.id, Number.MAX_SAFE_INTEGER);
  }
  if (target.parentId !== null) {
    // Target is inside a folder: join that folder next to it.
    return moveBookmark(tree, dragId, target.parentId, target.index + 1);
  }
  const [rest, dragged] = without(tree, dragId);
  if (!dragged) return tree;
  const used = new Set(rest.filter((node) => node.kind === "folder").map((node) => node.color));
  const folder: Bookmark = {
    id: makeBookmarkId(),
    kind: "folder",
    title: folderTitle,
    color: FOLDER_COLORS.find((color) => !used.has(color)) ?? FOLDER_COLORS[0],
    children: [target.node, dragged],
  };
  return tidy(rest.map((node) => (node.id === targetId ? folder : node)));
}

/** Folder → its bookmarks in its place (ungroup). */
export function ungroupFolder(tree: Bookmark[], folderId: string): Bookmark[] {
  return tree.flatMap((node) => (node.id === folderId && node.kind === "folder" ? node.children ?? [] : [node]));
}
