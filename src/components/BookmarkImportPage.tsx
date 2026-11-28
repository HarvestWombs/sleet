import { useMemo, useState } from "react";
import { type ImportRoot, countImport, planImport } from "../lib/bookmarkImport";
import type { Bookmark } from "../lib/bookmarks";

export interface PendingImport {
  sourceName: string;
  roots: ImportRoot[];
  icons: Record<string, string>;
}

interface BookmarkImportPageProps {
  pending: PendingImport;
  bookmarks: Bookmark[];
  onImport: (tree: Bookmark[], icons: Record<string, string>) => void;
  onDone: () => void;
}

/** Shows what an import will add, with how to fit it into Sleet's folders, before anything changes. */
export function BookmarkImportPage({ pending, bookmarks, onImport, onDone }: BookmarkImportPageProps) {
  const [mode, setMode] = useState<"folders" | "single">("folders");
  const [gridRoots, setGridRoots] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const hasGridRoot = pending.roots.some((root) => root.grid);
  const plan = useMemo(
    () => planImport(bookmarks, pending.roots, { mode, gridRoots, sourceName: pending.sourceName }),
    [bookmarks, pending, mode, gridRoots],
  );
  const total = countImport(pending.roots);
  const loose = plan.added - plan.tree.filter((node) => node.kind === "folder" && !bookmarks.includes(node)).reduce((sum, folder) => sum + (folder.children?.length ?? 0), 0);

  if (result) {
    return (
      <div className="settings-card import-result">
        <div className="settings-row">
          <div className="settings-copy"><strong>{result}</strong><small>They're on the Home page.</small></div>
          <div className="settings-control"><button className="settings-button" onClick={onDone}>Done</button></div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-copy">
            <strong>{total} bookmarks found</strong>
            <small>{pending.roots.map((root) => root.title).join(" · ")}</small>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-copy">
            <strong>Groups</strong>
            <small>Each folder becomes a group on the Home page; nested folders become “Parent / Child”.</small>
          </div>
          <div className="settings-control">
            <div className="segmented" role="radiogroup" aria-label="Folders">
              <button role="radio" aria-checked={mode === "folders"} className={mode === "folders" ? "is-on" : ""} onClick={() => setMode("folders")}>A group per folder</button>
              <button role="radio" aria-checked={mode === "single"} className={mode === "single" ? "is-on" : ""} onClick={() => setMode("single")}>One group</button>
            </div>
          </div>
        </div>
        {hasGridRoot && mode === "folders" && (
          <div className="settings-row">
            <div className="settings-copy">
              <strong>Bookmarks bar and favorites in “Bookmarks”</strong>
              <small>Put them in the main “Bookmarks” group instead of a group of their own</small>
            </div>
            <div className="settings-control">
              <button className={`toggle ${gridRoots ? "is-on" : ""}`} role="switch" aria-checked={gridRoots} aria-label="Bookmarks bar in the Bookmarks group" onClick={() => setGridRoots((value) => !value)}><i /></button>
            </div>
          </div>
        )}
      </div>

      <div className="settings-card import-summary">
        <div className="settings-row">
          <div className="settings-copy">
            <strong>{plan.added === 0 ? "Nothing new to add" : `Adds ${plan.added} bookmark${plan.added === 1 ? "" : "s"}`}</strong>
            <small>
              {[
                loose > 0 ? `${loose} in “Bookmarks”` : null,
                plan.folders > 0 ? `${plan.folders} group${plan.folders === 1 ? "" : "s"}` : null,
                plan.skipped > 0 ? `${plan.skipped} already in Sleet or repeated, skipped` : null,
                Object.keys(pending.icons).length > 0 ? `${Object.keys(pending.icons).length} site icons` : null,
              ].filter(Boolean).join(" · ") || "Everything here is already in Sleet."}
            </small>
          </div>
          <div className="settings-control">
            <button className="settings-button" onClick={onDone}>Cancel</button>
            <button
              className="settings-button is-primary"
              disabled={plan.added === 0}
              onClick={() => { onImport(plan.tree, pending.icons); setResult(`Imported ${plan.added} bookmark${plan.added === 1 ? "" : "s"} from ${pending.sourceName}`); }}
            >
              Import
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
