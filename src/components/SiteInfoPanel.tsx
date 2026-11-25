import { Info, LockKeyhole, LockKeyholeOpen, ShieldAlert, Trash2, VenetianMask } from "lucide-react";
import { useEffect, useState } from "react";
import { COMMON_PERMISSIONS, permissionName } from "../lib/permissions";

export type PermissionChoice = "ask" | "allow" | "block";

export interface SiteInfo {
  host: string;
  origin: string;
  security: "secure" | "insecure" | "local" | "none" | "cert";
  /** Certificate problem text when `security` is `cert`. */
  problem?: string;
  private: boolean;
  /** Saved answers for this site; missing kinds are "ask". */
  permissions: Record<string, "allow" | "block">;
  trackingPrevention: string;
}

interface SiteInfoPanelProps {
  info: SiteInfo;
  variant?: "inline" | "overlay";
  onSetPermission: (permission: string, choice: PermissionChoice) => void;
  onClearSite: () => void;
  onAllowCertificate: () => void;
  onOpenSettings: () => void;
}

const STATUS = {
  secure: { icon: LockKeyhole, title: "Connection is secure", text: "Information you send to this site is encrypted (HTTPS)." },
  insecure: { icon: LockKeyholeOpen, title: "Not secure", text: "This site doesn’t use HTTPS. Don’t enter passwords or payment details." },
  cert: { icon: ShieldAlert, title: "Certificate problem", text: "" },
  local: { icon: Info, title: "Local page", text: "This page is served from your own computer or network." },
  none: { icon: Info, title: "Sleet page", text: "This page is part of Sleet." },
};

/** What the lock icon opens: connection security, permissions and site data for the current site. */
export function SiteInfoPanel({ info, variant = "inline", onSetPermission, onClearSite, onAllowCertificate, onOpenSettings }: SiteInfoPanelProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);
  useEffect(() => { setConfirmClear(false); setCleared(false); }, [info.origin]);

  const status = STATUS[info.security];
  const Icon = status.icon;
  const kinds = [...new Set([...COMMON_PERMISSIONS, ...Object.keys(info.permissions)])];
  const isWebSite = info.security !== "none";

  return (
    <section className={`site-info ${variant === "overlay" ? "is-overlay" : ""}`} role="dialog" aria-label={`Site information for ${info.host}`}>
      <header className={`site-info-status is-${info.security}`}>
        <Icon size={20} />
        <span>
          <strong>{info.host || "Sleet"}</strong>
          <small>{status.title}</small>
        </span>
      </header>
      <p className="site-info-text">{info.security === "cert" ? `${info.problem ?? "The site's certificate isn't valid"}. Someone could be intercepting your connection.` : status.text}</p>
      {info.security === "cert" && (
        <button className="site-info-danger" onClick={onAllowCertificate}>Continue to this site anyway (unsafe)</button>
      )}
      {info.private && (
        <p className="site-info-note"><VenetianMask size={16} /> Private tab: nothing from this site is kept after your private tabs close.</p>
      )}

      {isWebSite && (
        <>
          <h4>Permissions</h4>
          {info.private && <p className="site-info-muted">Private tabs ask every time instead of remembering.</p>}
          <div className="site-info-permissions">
            {kinds.map((kind) => {
              const current: PermissionChoice = info.permissions[kind] ?? "ask";
              return (
                <div className="site-info-permission" key={kind}>
                  <span>{permissionName(kind)}</span>
                  <div className="segmented is-small" role="radiogroup" aria-label={permissionName(kind)}>
                    {(["ask", "allow", "block"] as PermissionChoice[]).map((choice) => (
                      <button
                        key={choice}
                        role="radio"
                        aria-checked={current === choice}
                        className={current === choice ? "is-on" : ""}
                        disabled={info.private}
                        onClick={() => onSetPermission(kind, choice)}
                      >
                        {choice === "ask" ? "Ask" : choice === "allow" ? "Allow" : "Block"}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <h4>Site data</h4>
          <p className="site-info-muted">Tracking prevention: {info.trackingPrevention}.</p>
          <button
            className={`site-info-action ${confirmClear ? "is-armed" : ""}`}
            onClick={() => {
              if (!confirmClear) { setConfirmClear(true); return; }
              setConfirmClear(false);
              setCleared(true);
              onClearSite();
            }}
          >
            <Trash2 size={16} /> {cleared ? "Cleared, page reloaded" : confirmClear ? "Click again to sign out and clear" : "Clear cookies and site data"}
          </button>
        </>
      )}
      <button className="site-info-link" onClick={onOpenSettings}>Privacy settings</button>
    </section>
  );
}
