import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SiteInfoPanel } from "../components/SiteInfoPanel";
import { LoginsMenu } from "../components/LoginsMenu";
import { SuggestionList } from "../components/SuggestionList";
import { Toasts } from "../components/Toasts";
import { PromptModal } from "../components/PromptModal";
import { ContextMenu } from "../components/ContextMenu";
import { applyVars } from "../lib/appearance";
import { OVERLAY_EVENTS, type OverlayAction, type OverlayKind, type OverlayState } from "../lib/overlay";
import { emitEvent, listenEvent } from "../native/browserEngine";

/**
 * Root for an overlay webview: renders one piece of UI above page webviews and
 * reports its size so the native view can be fitted to it.
 */
export function OverlayApp({ kind }: { kind: OverlayKind }) {
  const [state, setState] = useState<OverlayState | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const send = (action: OverlayAction) => { void emitEvent(OVERLAY_EVENTS.action, action); };

  useEffect(() => {
    document.documentElement.classList.add("is-overlay");
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listenEvent<OverlayState>(OVERLAY_EVENTS.state, ({ payload }) => {
      if (payload.kind === kind) setState(payload);
    }).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
      void emitEvent(OVERLAY_EVENTS.ready, { kind });
    });
    return () => { disposed = true; unlisten?.(); };
  }, [kind]);

  useEffect(() => {
    if (state) document.documentElement.dataset.theme = state.theme;
    if (state?.vars) applyVars(state.vars);
  }, [state?.theme, JSON.stringify(state?.vars ?? {})]);

  // Report content size so the native overlay can match it exactly.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const report = () => {
      const rect = root.getBoundingClientRect();
      void emitEvent(OVERLAY_EVENTS.size, { kind, width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
    };
    const observer = new ResizeObserver(report);
    observer.observe(root);
    return () => observer.disconnect();
  }, [kind]);

  // Tooltips: report once the new text is on screen, so the main window only
  // shows this overlay with the right text and size (no flash of the old one).
  const tooltipSeq = state?.kind === "tooltip" ? state.seq : 0;
  useLayoutEffect(() => {
    if (kind !== "tooltip" || !tooltipSeq || !rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    void emitEvent(OVERLAY_EVENTS.rendered, { kind, seq: tooltipSeq, width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
  }, [kind, tooltipSeq]);

  // The palette closes when focus really leaves the overlay (a click on the
  // page or the sidebar). WebView2 can blur a webview for a moment while it is
  // shown or refocused, so a blur only counts if focus is still gone shortly
  // after, and never right after opening.
  const openedAt = useRef(0);
  const paletteOpen = state?.kind === "siteinfo" && state.open;
  const session = state?.kind === "siteinfo" ? state.session : 0;
  const closeSelf = (refocusPage: boolean) => send({ kind: "siteinfo", type: "close", refocusPage });
  useEffect(() => { if (paletteOpen) openedAt.current = Date.now(); }, [paletteOpen, session]);

  // A menu closes when Sleet loses focus (another app came forward).
  const menuOpen = state?.kind === "menu" && !!state.menu;
  useEffect(() => {
    if (kind !== "menu" || !menuOpen) return;
    const openedMenuAt = Date.now();
    let timer: number | undefined;
    const onBlur = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (!document.hasFocus() && Date.now() - openedMenuAt > 400) send({ kind: "menu", type: "close" }); }, 150);
    };
    window.addEventListener("blur", onBlur);
    return () => { window.clearTimeout(timer); window.removeEventListener("blur", onBlur); };
  }, [kind, menuOpen]);
  useEffect(() => {
    if (kind !== "siteinfo" || !paletteOpen) return;
    let timer: number | undefined;
    const onBlur = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.hasFocus() || Date.now() - openedAt.current < 400) return;
        closeSelf(false);
      }, 150);
    };
    const onFocus = () => window.clearTimeout(timer);
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        closeSelf(true);
      }
      if (event.key === "Escape" && kind === "siteinfo") closeSelf(true);
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [kind, paletteOpen]);

  return (
    <div className={`overlay-root is-${kind}`} ref={rootRef}>
      {state?.kind === "tooltip" && state.text && <div className="tooltip is-overlay" role="tooltip">{state.text}</div>}
      {state?.kind === "logins" && <LoginsMenu variant="overlay" items={state.items} onPick={(item) => send({ kind: "logins", type: "pick", item })} />}
      {state?.kind === "siteinfo" && state.open && state.info && (
        <SiteInfoPanel
          key={state.session}
          variant="overlay"
          info={state.info}
          onSetPermission={(permission, choice) => send({ kind: "siteinfo", type: "set-permission", permission, choice })}
          onClearSite={() => send({ kind: "siteinfo", type: "clear-site" })}
          onAllowCertificate={() => send({ kind: "siteinfo", type: "allow-certificate" })}
          onOpenSettings={() => send({ kind: "siteinfo", type: "open-settings" })}
        />
      )}
      {state?.kind === "suggest" && (
        <SuggestionList
          variant="overlay"
          items={state.items}
          selected={state.selected}
          onPick={(index) => send({ kind: "suggest", type: "pick", item: state.items[index] })}
          onHover={(index) => send({ kind: "suggest", type: "hover", index })}
        />
      )}
      {state?.kind === "menu" && (
        <ContextMenu
          menu={state.menu}
          onPick={(id) => send({ kind: "menu", type: "pick", id })}
          onClose={() => send({ kind: "menu", type: "close" })}
        />
      )}
      {state?.kind === "modal" && state.toast && (
        <PromptModal
          variant="overlay"
          toast={state.toast}
          onChoice={(toast, choice) => send({ kind: "toasts", type: "prompt", toast, choice })}
          onDismiss={(id) => send({ kind: "toasts", type: "dismiss", id })}
        />
      )}
      {state?.kind === "toasts" && (
        <Toasts
          variant="overlay"
          toasts={state.toasts}
          downloads={state.downloads}
          onDismiss={(id) => send({ kind: "toasts", type: "dismiss", id })}
          onOpenDownload={(download) => send({ kind: "toasts", type: "open-download", id: download.id })}
          onCancelDownload={(download) => send({ kind: "toasts", type: "cancel-download", id: download.id })}
          onPauseDownload={(download) => send({ kind: "toasts", type: "pause-download", id: download.id })}
          onShowDownloads={() => send({ kind: "toasts", type: "show-downloads" })}
          onResolveCheck={(check, keep, remember) => send({ kind: "toasts", type: "resolve-check", check, keep, remember })}
          onPromptChoice={(toast, choice) => send({ kind: "toasts", type: "prompt", toast, choice })}
          onHover={(id, hovering) => send({ kind: "toasts", type: "hover", id, hovering })}
        />
      )}
    </div>
  );
}
