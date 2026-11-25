import { AlertCircle, CheckCircle2, Download, ExternalLink, Globe, KeyRound, LockKeyholeOpen, Pause, Play, ShieldAlert, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import { canPauseDownloads, normalizeExtension } from "../lib/downloadTypes";
import { hostOf, permissionAsk } from "../lib/permissions";
import type { DownloadCheckEvent, DownloadItem } from "../types";

/** A question for the user raised by a page. */
export type Prompt =
  | { kind: "permission"; requestId: number; origin: string; permission: string; private: boolean }
  | { kind: "popup"; label: string; url: string; origin: string }
  | { kind: "https"; label: string; httpUrl: string; host: string }
  | { kind: "cert"; label: string; host: string; problem: string }
  | { kind: "default-browser" }
  | { kind: "remember-device" }
  | { kind: "external"; label: string; url: string; origin: string; scheme: string }
  | { kind: "password"; pendingId: string; label: string; origin: string; username: string; offer: "new" | "update" | "locked" };

/** Answers: permission allow/block (":once" = don't remember), popup open/always, https or cert continue. */
export type PromptChoice = "allow" | "block" | "allow:once" | "block:once" | "open" | "always" | "continue" | "make-default" | "not-now" | "turn-on" | "save" | "never" | "unlock";

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
  /** Pauses a running download or resumes a paused one. */
  onPauseDownload?: (download: DownloadItem) => void;
  /** Clicking a download notice opens the Downloads page. */
  onShowDownloads?: () => void;
  onResolveCheck: (check: DownloadCheckEvent, keep: boolean, remember?: boolean) => void;
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
  if (download.status === "complete") return "Done";
  if (download.status === "cancelled") return "Cancelled";
  if (download.status === "failed") return download.error ?? "Failed";
  const percent = percentOf(download);
  if (download.paused) {
    const done = percent !== null ? `${percent}%` : download.received ? formatBytes(download.received) : "";
    return [download.error ? `${download.error} · Resume to retry` : "Paused", done].filter(Boolean).join(" · ");
  }
  if (percent !== null && download.total) return `${percent}% · ${formatBytes(download.received ?? 0)} of ${formatBytes(download.total)}`;
  return download.received ? `${formatBytes(download.received)} downloaded` : "Downloading…";
};

/** 1.4 MB, 820 KB… */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

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
        <ShieldQuestion size={19} className="toast-icon" />
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
  const close = <button className="toast-close" aria-label="Dismiss" onClick={onDismiss}><X size={15} /></button>;
  if (prompt.kind === "password") {
    const site = hostOf(prompt.origin);
    return (
      <div className="toast is-prompt" role="dialog" aria-label="Save password">
        <KeyRound size={19} className="toast-icon" />
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
  if (prompt.kind === "remember-device") {
    return (
      <div className="toast is-prompt" role="dialog" aria-label="Remember this device">
        <KeyRound size={19} className="toast-icon" />
        <span className="toast-copy">
          <strong>Stop asking for your master password?</strong>
          <small>Sleet can save and fill passwords using this computer’s secure store. Viewing or exporting passwords still asks.</small>
          <span className="toast-actions">
            <button className="toast-action is-primary" onClick={() => onChoice("turn-on")}>Remember this device</button>
            <button className="toast-action" onClick={() => onChoice("not-now")}>Not now</button>
          </span>
        </span>
      </div>
    );
  }
  if (prompt.kind === "default-browser") {
    return (
      <div className="toast is-prompt" role="dialog" aria-label="Default browser">
        <Globe size={19} className="toast-icon" />
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
        <ExternalLink size={19} className="toast-icon" />
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
        <ExternalLink size={19} className="toast-icon" />
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
        <LockKeyholeOpen size={19} className="toast-icon" />
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
      <ShieldAlert size={19} className="toast-icon" />
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

/** "This file can harm your device": keep or delete, optionally for every file of this type. */
function CheckToast({ check, onResolve }: { check: DownloadCheckEvent; onResolve: (check: DownloadCheckEvent, keep: boolean, remember?: boolean) => void }) {
  const [remember, setRemember] = useState(false);
  const type = normalizeExtension(check.extension);
  return (
    <div className="toast is-check" role="alertdialog" aria-label="Download warning">
      <ShieldAlert size={19} className="toast-icon" />
      <span className="toast-copy">
        <strong>{fileName(check.path)}</strong>
        <small>Windows warns that {type ? `.${type} files` : "this type of file"} can harm your device. Only keep it if you trust where it came from.</small>
        {type && (
          <label className="toast-check">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Always keep .{type} files without asking
          </label>
        )}
        <span className="toast-actions">
          <button className="toast-action is-primary" onClick={() => onResolve(check, true, remember)}>Keep</button>
          <button className="toast-action" onClick={() => onResolve(check, false)}>Delete</button>
        </span>
      </span>
    </div>
  );
}

/** Small stack of notices in the upper left of the page area. */
export function Toasts({ toasts, downloads, onDismiss, onOpenDownload, onCancelDownload, onPauseDownload, onShowDownloads, onResolveCheck, onPromptChoice, variant = "fixed", position = "top-left", onHover }: ToastsProps) {
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
          return <CheckToast key={toast.id} check={toast.check} onResolve={onResolveCheck} />;
        }

        const download = toast.downloadId ? downloads.find((item) => item.id === toast.downloadId) : undefined;
        if (toast.downloadId && !download) return null;
        if (!download) {
          return (
            <div className="toast" key={toast.id}>
              <AlertCircle size={19} className="toast-icon" />
              <span className="toast-copy"><strong>{toast.message}</strong></span>
              <button className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}><X size={15} /></button>
            </div>
          );
        }

        const percent = percentOf(download);
        const active = download.status === "active";
        return (
          <div className={`toast is-${download.status} ${download.paused ? "is-paused" : ""}`} key={toast.id}>
            <button className="toast-body" onClick={() => onShowDownloads?.()} title="Show downloads">
              {download.status === "complete" ? <CheckCircle2 size={19} className="toast-icon" /> : active ? <Download size={19} className="toast-icon" /> : <AlertCircle size={19} className="toast-icon" />}
              <span className="toast-copy">
                <strong>{download.filename}</strong>
                <small>{downloadStatusText(download)}</small>
                {active && <i className="toast-progress"><b style={{ width: `${percent ?? 35}%` }} className={percent === null && !download.paused ? "is-indeterminate" : ""} /></i>}
              </span>
            </button>
            <span className="toast-buttons">
              {active && onPauseDownload && canPauseDownloads && (
                <button className="toast-button" aria-label={`${download.paused ? "Resume" : "Pause"} ${download.filename}`} title={download.paused ? "Resume download" : "Pause download"} onClick={() => onPauseDownload(download)}>
                  {download.paused ? <Play size={15} /> : <Pause size={15} />}
                </button>
              )}
              {download.status === "complete" && (
                <button className="toast-button" aria-label={`Open ${download.filename}`} title="Open file" onClick={() => onOpenDownload(download)}><ExternalLink size={15} /></button>
              )}
              {active
                ? <button className="toast-button" aria-label={`Cancel ${download.filename}`} title="Cancel download" onClick={() => onCancelDownload(download)}><X size={15} /></button>
                : <button className="toast-button" aria-label="Dismiss" title="Dismiss" onClick={() => onDismiss(toast.id)}><X size={15} /></button>}
            </span>
          </div>
        );
  }
}
