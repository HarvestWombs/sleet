import { Frown, Minimize2, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef } from "react";
import type { DockNode, DockSide } from "../lib/dock";
import { isHomeUrl } from "../lib/browser";
import type { BrowserTab } from "../types";
import { SiteIcon } from "./SiteIcon";

const DRAG_THRESHOLD = 4;

interface DockViewProps {
  layout: DockNode;
  tabs: Map<string, BrowserTab>;
  activeId: string;
  loading?: Set<string>;
  sleeping?: Set<string>;
  crashed?: Record<string, string>;
  /** A tab is being dragged: pages are hidden and panes show what they hold. */
  dragging?: boolean;
  /** Where the dragged tab would land. */
  drop?: { target: string; side: DockSide } | null;
  onFocusPane: (id: string) => void;
  onUndock: (id: string) => void;
  onClose: (id: string) => void;
  onResize: (path: string, ratio: number) => void;
  /** A pane's title bar was dragged past the threshold. */
  onPaneDrag: (id: string, start: PointerEvent) => void;
}

/**
 * Docked tabs side by side. Each pane is a title bar (drag to move, undock,
 * close) over an empty body that the tab's page webview is placed on.
 */
export function DockView(props: DockViewProps) {
  return <div className={`dock-view ${props.dragging ? "is-dragging" : ""}`}><DockBranch {...props} node={props.layout} path="" /></div>;
}

function DockBranch(props: DockViewProps & { node: DockNode; path: string }) {
  const { node, path } = props;
  const splitRef = useRef<HTMLDivElement>(null);
  if (node.kind === "pane") return <DockPane {...props} id={node.tabId} />;

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    const controller = new AbortController();
    document.body.classList.add(node.dir === "row" ? "is-resizing-dock-row" : "is-resizing-dock-column");
    event.currentTarget.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", (move) => {
      props.onResize(path, node.dir === "row" ? (move.clientX - box.left) / box.width : (move.clientY - box.top) / box.height);
    }, { signal: controller.signal });
    const finish = () => {
      controller.abort();
      document.body.classList.remove("is-resizing-dock-row", "is-resizing-dock-column");
    };
    window.addEventListener("pointerup", finish, { signal: controller.signal });
    window.addEventListener("pointercancel", finish, { signal: controller.signal });
  };

  return (
    <div className={`dock-split is-${node.dir}`} ref={splitRef}>
      <div className="dock-cell" style={{ flex: `${node.ratio} 1 0` }}><DockBranch {...props} node={node.a} path={`${path}a`} /></div>
      <div className="dock-divider" role="separator" aria-orientation={node.dir === "row" ? "vertical" : "horizontal"} aria-label="Resize docked pages" onPointerDown={startResize} />
      <div className="dock-cell" style={{ flex: `${1 - node.ratio} 1 0` }}><DockBranch {...props} node={node.b} path={`${path}b`} /></div>
    </div>
  );
}

function DockPane(props: DockViewProps & { id: string }) {
  const { id, tabs, activeId, dragging, drop } = props;
  const tab = tabs.get(id);
  const title = tab?.title || "Untitled";

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const [startX, startY] = [event.clientX, event.clientY];
    const controller = new AbortController();
    window.addEventListener("pointermove", (move) => {
      if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return;
      controller.abort();
      props.onPaneDrag(id, move);
    }, { signal: controller.signal });
    window.addEventListener("pointerup", () => controller.abort(), { signal: controller.signal });
  };

  const placeholder = () => {
    if (dragging) return <span className="dock-placeholder"><SiteIcon icon={tab?.favicon} title={title} url={tab?.private ? undefined : tab?.url} /><span>{title}</span></span>;
    if (props.crashed?.[id]) return <span className="dock-placeholder"><Frown size={20} /><span>This page crashed. Reload it from the sidebar.</span></span>;
    if (tab && isHomeUrl(tab.url)) return <span className="dock-placeholder"><span>Nothing open here. Type an address while this pane is selected.</span></span>;
    if (props.sleeping?.has(id)) return <span className="dock-placeholder"><span>Reloading…</span></span>;
    return <span className="dock-placeholder is-quiet"><SiteIcon icon={tab?.favicon} title={title} url={tab?.private ? undefined : tab?.url} /><span>{title}</span></span>;
  };

  return (
    <div className={`dock-pane ${id === activeId ? "is-active" : ""}`} data-dock-pane={id}>
      <div className="dock-titlebar" onPointerDown={startDrag} onClick={() => props.onFocusPane(id)} title={tab?.url}>
        {props.loading?.has(id) ? <span className="tab-favicon tab-spinner" aria-label="Loading" /> : <SiteIcon icon={tab?.favicon} title={title} url={tab?.private ? undefined : tab?.url} />}
        <span className="dock-title">{title}</span>
        <button className="dock-button" aria-label={`Undock ${title}`} title="Undock (back to a tab of its own)" onClick={(event) => { event.stopPropagation(); props.onUndock(id); }}><Minimize2 size={14} /></button>
        <button className="dock-button" aria-label={`Close ${title}`} title="Close tab" onClick={(event) => { event.stopPropagation(); props.onClose(id); }}><X size={15} /></button>
      </div>
      <div className="dock-body" data-dock-body={id}>{placeholder()}</div>
      {drop?.target === id && <div className={`dock-drop is-${drop.side}`} aria-hidden="true" />}
    </div>
  );
}
