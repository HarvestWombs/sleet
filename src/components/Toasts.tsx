import { AlertCircle, CheckCircle2, Download, ExternalLink, Globe, KeyRound, LockKeyholeOpen, ShieldAlert, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { hostOf, permissionAsk } from "../lib/permissions";
import type { DownloadCheckEvent, DownloadItem } from "../types";

/** A question for the user raised by a page. */
export type Prompt =
  | { kind: "permission"; requestId: number; origin: string; permission: string; private: boolean }
  | { kind: "popup"; label: string; url: string; origin: string }
  | { kind: "https"; label: string; httpUrl: string; host: string }
  | { kind: "cert"; label: string; host: string; problem: string }
  | { kind: "default-browser" }
  | { kind: "external"; label: string; url: string; origin: string; scheme: string }
  | { kind: "password"; pendingId: string; label: string; origin: string; username: string; offer: "new" | "update" | "locked" };

/** Answers: permission allow/block (":once" = don't remember), popup open/always, https or cert continue. */
export type PromptChoice = "allow" | "block" | "allow:once" | "block:once" | "open" | "always" | "continue" | "make-default" | "not-now" | "save" | "never" | "unlock";

export interface Toast {
  id: string;
  /** Download this toast tracks; otherwise `message` or `check` is shown. */
  downloadId?: string;
  message?: string;
  /** Windows flagged this file type; the user must keep or delete it. */
  check?: DownloadCheckEvent;
  prompt?: Prompt;
  /** When the toast hides; `null` while it needs the user (open check or prompt) or is hovered. */
  expiresAt: number | null;
  /** Fading out (the last moment before `expiresAt`). */
  leaving?: boolean;
}

interface ToastsProps {
  toasts: Toast[];
  downloads: DownloadItem[];
  onDismiss: (id: string) => void;
  onOpenDownload: (download: DownloadItem) => void;
  onCancelDownload: (download: DownloadItem) => void;
  onResolveCheck: (check: DownloadCheckEvent, keep: boolean) => void;
  onPromptChoice: (toast: Toast, choice: PromptChoice) => void;
  /** `overlay` lays the stack out in normal flow inside an overlay webview. */
  variant?: "fixed" | "overlay";
  /** Corner of the page area (fixed variant only). */
  position?: string;
  /** Hovering a toast keeps it on screen. */
  onHover?: (id: string, hovering: boolean) => void;
}

export const percentOf = (download: DownloadItem) =>
  download.total && download.received !== undefined ? Math.min(100, Math.round((download.received / download.total) * 100)) : null;

export const downloadStatusText = (download: DownloadItem) => {
  if (download.status === "complete") return "Done · click to open";
  if (download.status === "cancelled") return "Cancelled";
  if (download.status === "failed") return download.error ?? "Failed";
  const percent = percentOf(download);
  return percent === null ? "Downloading…" : `${percent}%`;
};

/** Friendly names for common app links. */
const EXTERNAL_APPS: Record<string, string> = {
  mailto: "your email app", tel: "your phone app", sms: "your messaging app", callto: "your calling app",
  zoommtg: "Zoom", zoomus: "Zoom", msteams: "Microsoft Teams", slack: "Slack", discord: "Discord",
  spotify: "Spotify", steam: "Steam", magnet: "your torrent app", webcal: "your calendar",
  vscode: "Visual Studio Code", "ms-teams": "Microsoft Teams", skype: "Skype", tg: "Telegram", whatsapp: "WhatsApp",
};

const fileName = (path: string) => path.split(/[\\/]/).at(-1) || path;

function PromptToast({ prompt, onChoice, onDismiss }: { prompt: Prompt; onChoice: (choice: PromptChoice) => void; onDismiss: () => void }) {
  const [remember, setRemember] = useState(true);
  const [always, setAlways] = useState(false);
  if (prompt.kind === "permission") {
    return (
      <div className="toast is-prompt" role="alertdialog" aria-label="Permission request">
        <ShieldQuestion size={15} className="toast-icon" />
        <span className="toast-copy">
          <strong>{hostOf(prompt.origin)}</strong>
          <small>wants to {permissionAsk(prompt.permission)}</small>
          {!prompt.private && (
            <label className="toast-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Remember for this site</label>
          )}
          <span className="toast-actions">
            <button className="toast-action is-primary" onClick={() => onChoice(remember && !prompt.private ? "allow" : "allow:once")}>Allow</button>
            <button className="toast-action" onClick={() => onChoice(remember && !prompt.private ? "block" : "block:once")}>Block</button>
          </span>
        </span>
      </div>
    );
  }
  const close = <button className="toast-close" aria-label="Dismiss" onClick={onDismiss}><X size={12} /></button>;
  if (prompt.kind === "password") {
    const site = hostOf(prompt.origin);
    return (
      <div className="toast is-prompt" role="dialog" aria-label="Save password">
        <KeyRound size={15} className="toast-icon" />
        <span className="toast-copy">
          <strong>{prompt.offer === "update" ? `Update password for ${site}?` : `Save password for ${site}?`}</strong>
          <small>{prompt.offer === "locked" ? "Unlock your passwords to save it." : prompt.username ? `For ${prompt.username}` : "No username detected"}</small>
          <span className="toast-actions">
            {prompt.offer === "locked"
              ? <button className="toast-action is-primary" onClick={() => onChoice("unlock")}>Unlock</button>
              : <button className="toast-action is-primary" onClick={() => onChoice("save")}>{prompt.offer === "update" ? "Update" : "Save"}</button>}
            {prompt.offer !== "update" && <button className="toast-action" onClick={() => onChoice("never")}>Never for this site</button>}
          </span>
        </span>
        {close}
      </div>
    );
  }
  if (prompt.kind === "default-browser") {
    return (
      <div className="toast is-prompt" role="dialog" aria-label="Default browser">
        <Globe size={15} className="toast-icon" />
        <span className="toast-copy">
          <strong>Make Sleet your default browser?</strong>
          <small>Links from other apps would open here. You can change this any time in Settings.</small>
          <span className="toast-actions">
            <button className="toast-action is-primary" onClick={() => onChoice("make-default")}>Make default</button>
            <button className="toast-action" onClick={() => onChoice("not-now")}>Not now</button>
          </span>
        </span>
      </div>
    );
  }
  if (prompt.kind === "popup") {
    return (
      <div className="toast is-prompt" role="status">
        <ExternalLink size={15} className="toast-icon" />
        <span className="toast-copy">
          <strong>Popup blocked</strong>
          <small title={prompt.url}>{hostOf(prompt.origin || prompt.url)} tried to open {hostOf(prompt.url)}</small>
          <span className="toast-actions">
            <button className="toast-action is-primary" onClick={() => onChoice("open")}>Open it</button>
            {prompt.origin && <button className="toast-action" onClick={() => onChoice("always")}>Always allow</button>}
          </span>
        </span>
        {close}
      </div>
    );
  }
  if (prompt.kind === "external") {
    const app = EXTERNAL_APPS[prompt.scheme] ?? `the app for ${prompt.scheme}: links`;
    return (
      <div className="toast is-prompt" role="alertdialog" aria-label="Open another app">
        <ExternalLink size={15} className="toast-icon" />
        <span className="toast-copy">
          <strong>Open {app}?</strong>
          <small title={prompt.url}>{prompt.origin ? `${hostOf(prompt.origin)} wants to open ` : "Open "}{prompt.url.length > 80 ? `${prompt.url.slice(0, 80)}…` : prompt.url}</small>
          {prompt.origin && <label className="toast-remember"><input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} /> Always allow {hostOf(prompt.origin)} to open these links</label>}
          <span className="toast-actions">
            <button className="toast-action is-primary" onClick={() => onChoice(always && prompt.origin ? "always" : "open")}>Open</button>
            <button className="toast-action" onClick={onDismiss}>Cancel</button>
          </span>
        </span>
        {close}
      </div>
    );
  }
  if (prompt.kind === "https") {
    return (
      <div className="toast is-prompt is-warning" role="alertdialog" aria-label="Secure connection unavailable">
        <LockKeyholeOpen size={15} className="toast-icon" />
        <span className="toast-copy">
          <strong>{prompt.host}</strong>
          <small>doesn’t support a secure connection, so HTTPS-only mode stopped it.</small>
          <span className="toast-actions">
            <button className="toast-action" onClick={() => onChoice("continue")}>Continue on http</button>
          </span>
        </span>
        {close}
      </div>
    );
  }
  return (
    <div className="toast is-prompt is-warning" role="alertdialog" aria-label="Certificate problem">
      <ShieldAlert size={15} className="toast-icon" />
      <span className="toast-copy">
        <strong>{prompt.host}</strong>
        <small>{prompt.problem}. Someone could be intercepting your connection.</small>
        <span className="toast-actions">
          <button className="toast-action" onClick={() => onChoice("continue")}>Continue anyway (unsafe)</button>
        </span>
      </span>
      {close}
    </div>
  );
}

/** Small stack of notices in the upper left of the page area. */
export function Toasts({ toasts, downloads, onDismiss, onOpenDownload, onCancelDownload, onResolveCheck, onPromptChoice, variant = "fixed", position = "top-left", onHover }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div className={`toasts ${variant === "overlay" ? "is-overlay" : `is-${position}`}`} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast-slot ${toast.leaving ? "is-leaving" : ""}`}
          onMouseEnter={() => onHover?.(toast.id, true)}
          onMouseLeave={() => onHover?.(toast.id, false)}
        >
          {renderToast(toast)}
        </div>
      ))}
    </div>
  );

  function renderToast(toast: Toast) {
        if (toast.prompt) {
          return <PromptToast key={toast.id} prompt={toast.prompt} onChoice={(choice) => onPromptChoice(toast, choice)} onDismiss={() => onDismiss(toast.id)} />;
        }
        if (toast.check) {
          const check = toast.check;
          return (
            <div className="toast is-check" key={toast.id} role="alertdialog" aria-label="Download warning">
              <ShieldAlert size={15} className="toast-icon" />
              <span className="toast-copy">
                <strong>{fileName(check.path)}</strong>
                <small>Windows warns that {check.extension ? `${check.extension} files` : "this type of file"} can harm your device. Only keep it if you trust where it came from.</small>
                <span className="toast-actions">
                  <button className="toast-action is-primary" onClick={() => onResolveCheck(check, true)}>Keep</button>
                  <button className="toast-action" onClick={() => onResolveCheck(check, false)}>Delete</button>
                </span>
              </span>
            </div>
          );
        }

        const download = toast.downloadId ? downloads.find((item) => item.id === toast.downloadId) : undefined;
        if (toast.downloadId && !download) return null;
        if (!download) {
          return (
            <div className="toast" key={toast.id}>
              <AlertCircle size={15} className="toast-icon" />
              <span className="toast-copy"><strong>{toast.message}</strong></span>
              <button className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}><X size={12} /></button>
            </div>
          );
        }

        const percent = percentOf(download);
        const active = download.status === "active";
        return (
          <div className={`toast is-${download.status}`} key={toast.id}>
            <button className="toast-body" onClick={() => download.status === "complete" && onOpenDownload(download)} title={download.path ?? download.url}>
              {download.status === "complete" ? <CheckCircle2 size={15} className="toast-icon" /> : active ? <Download size={15} className="toast-icon" /> : <AlertCircle size={15} className="toast-icon" />}
              <span className="toast-copy">
                <strong>{download.filename}</strong>
                <small>{downloadStatusText(download)}</small>
                {active && <i className="toast-progress"><b style={{ width: `${percent ?? 35}%` }} className={percent === null ? "is-indeterminate" : ""} /></i>}
              </span>
            </button>
            {active
              ? <button className="toast-close" aria-label={`Cancel ${download.filename}`} title="Cancel download" onClick={() => onCancelDownload(download)}><X size={12} /></button>
              : <button className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}><X size={12} /></button>}
          </div>
        );
  }
}
