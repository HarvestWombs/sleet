import { type Bookmark, FOLDER_COLORS, allLinks, makeBookmarkId, urlKey } from "./bookmarks";

/** A bookmark or folder as read from another browser (any depth). */
export interface ImportNode {
  title: string;
  url?: string | null;
  children?: ImportNode[] | null;
}

/** A top-level group in the source. `grid` = bookmarks bar / Arc favorites. */
export interface ImportRoot {
  title: string;
  grid: boolean;
  nodes: ImportNode[];
}

export interface ImportOptions {
  /** `folders`: each source folder becomes a Sleet folder. `single`: everything in one folder. */
  mode: "folders" | "single";
  /** Put the bookmarks bar / Arc favorites straight into the grid (folders mode). */
  gridRoots: boolean;
  sourceName: string;
}

export interface ImportPlan {
  tree: Bookmark[];
  added: number;
  skipped: number;
  folders: number;
}

const usable = (url: string | null | undefined): url is string => !!url && /^https?:\/\//i.test(url);
const normal = urlKey;

/**
 * Fits imported bookmarks into Sleet's model (links plus one level of
 * folders): nested folders are flattened into "Parent / Child" folders, and
 * addresses already in Sleet (or repeated in the import) are skipped.
 */
export function planImport(existing: Bookmark[], roots: ImportRoot[], options: ImportOptions): ImportPlan {
  const seen = new Set(allLinks(existing).flatMap((link) => (link.url ? [normal(link.url)] : [])));
  let skipped = 0;
  const take = (node: ImportNode): Bookmark | null => {
    if (!usable(node.url)) return null;
    const key = normal(node.url);
    if (seen.has(key)) { skipped += 1; return null; }
    seen.add(key);
    return { id: makeBookmarkId(), kind: "link", title: node.title?.trim() || node.url, url: node.url };
  };
  const usedColors = existing.filter((node) => node.kind === "folder").length;
  const folders: Bookmark[] = [];
  const loose: Bookmark[] = [];
  const makeFolder = (title: string, children: Bookmark[]) => {
    if (children.length === 0) return;
    folders.push({ id: makeBookmarkId(), kind: "folder", title, color: FOLDER_COLORS[(usedColors + folders.length) % FOLDER_COLORS.length], children });
  };

  if (options.mode === "single") {
    const links: Bookmark[] = [];
    const walk = (nodes: ImportNode[]) => nodes.forEach((node) => {
      if (node.children) walk(node.children);
      else { const link = take(node); if (link) links.push(link); }
    });
    roots.forEach((root) => walk(root.nodes));
    makeFolder(`From ${options.sourceName}`, links);
  } else {
    // Links directly in a folder go to that folder; subfolders become their own "A / B" folder.
    const walkFolder = (path: string, nodes: ImportNode[]) => {
      const links: Bookmark[] = [];
      const subfolders: ImportNode[] = [];
      nodes.forEach((node) => {
        if (node.children) subfolders.push(node);
        else { const link = take(node); if (link) links.push(link); }
      });
      makeFolder(path, links);
      subfolders.forEach((folder) => walkFolder(`${path} / ${folder.title || "Folder"}`, folder.children ?? []));
    };
    roots.forEach((root) => {
      const directLinks: Bookmark[] = [];
      root.nodes.forEach((node) => {
        if (node.children) walkFolder(node.title || "Folder", node.children);
        else { const link = take(node); if (link) directLinks.push(link); }
      });
      if (root.grid && options.gridRoots) loose.push(...directLinks);
      else makeFolder(root.title, directLinks);
    });
  }

  const added = loose.length + folders.reduce((sum, folder) => sum + (folder.children?.length ?? 0), 0);
  return { tree: [...existing, ...loose, ...folders], added, skipped, folders: folders.length };
}

/**
 * Parses a bookmarks HTML file (the "Netscape" format every browser exports).
 * The toolbar folder, when marked, becomes a grid root.
 */
export function parseBookmarksHtml(html: string): ImportRoot[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const readList = (list: Element | null): ImportNode[] => {
    if (!list) return [];
    const nodes: ImportNode[] = [];
    for (const dt of Array.from(list.children).filter((child) => child.tagName === "DT")) {
      const anchor = dt.querySelector(":scope > a");
      const heading = dt.querySelector(":scope > h3");
      if (anchor) nodes.push({ title: anchor.textContent?.trim() ?? "", url: anchor.getAttribute("href") });
      else if (heading) {
        // The folder's list is the next <DL>, inside the DT or right after it.
        const sublist = dt.querySelector(":scope > dl") ?? (dt.nextElementSibling?.tagName === "DL" ? dt.nextElementSibling : null);
        nodes.push({ title: heading.textContent?.trim() ?? "Folder", children: readList(sublist), url: heading.hasAttribute("personal_toolbar_folder") ? "__toolbar__" : null });
      }
    }
    return nodes;
  };
  const top = readList(doc.querySelector("dl"));
  const roots: ImportRoot[] = [];
  const loose: ImportNode[] = [];
  for (const node of top) {
    if (node.children && node.url === "__toolbar__") roots.push({ title: node.title || "Bookmarks bar", grid: true, nodes: node.children });
    else if (node.children) roots.push({ title: node.title, grid: false, nodes: [{ ...node, url: null }] });
    else loose.push(node);
  }
  if (loose.length > 0) roots.push({ title: "Bookmarks", grid: false, nodes: loose });
  return roots;
}

export const countImport = (roots: ImportRoot[]) => {
  const count = (nodes: ImportNode[]): number => nodes.reduce((sum, node) => sum + (node.children ? count(node.children) : usable(node.url) ? 1 : 0), 0);
  return roots.reduce((sum, root) => sum + count(root.nodes), 0);
};
