import { Download } from "lucide-react";
import type { DownloadItem } from "../types";

/** Combined progress of running downloads: 0–1, or `null` when a size is unknown. */
export function downloadsProgress(downloads: DownloadItem[]): { active: number; fraction: number | null } {
  const running = downloads.filter((item) => item.status === "active");
  if (running.length === 0) return { active: 0, fraction: null };
  if (running.some((item) => !item.total)) return { active: running.length, fraction: null };
  const total = running.reduce((sum, item) => sum + (item.total ?? 0), 0);
  const received = running.reduce((sum, item) => sum + (item.received ?? 0), 0);
  return { active: running.length, fraction: total > 0 ? Math.min(1, received / total) : null };
}

/** One download's progress, 0–1, or `null` when its size is unknown. */
export const downloadFraction = (download: DownloadItem) =>
  download.total && download.received !== undefined ? Math.min(1, download.received / download.total) : null;

const RADIUS = 10;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The downloads icon, with a progress ring around it while something is downloading. */
export function DownloadIcon({ downloads, size = 19 }: { downloads: DownloadItem[]; size?: number }) {
  const { active, fraction } = downloadsProgress(downloads);
  return (
    <span className={`download-icon ${active ? "is-downloading" : ""}`}>
      <Download size={active ? size - 4 : size} />
      {active > 0 && (
        <svg className={`download-ring ${fraction === null ? "is-indeterminate" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
          <circle className="download-ring-track" cx="12" cy="12" r={RADIUS} />
          <circle
            className="download-ring-value"
            cx="12"
            cy="12"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={fraction === null ? CIRCUMFERENCE * 0.72 : CIRCUMFERENCE * (1 - fraction)}
          />
        </svg>
      )}
    </span>
  );
}

/** A thin bar for one download (moving stripe when the size is unknown). */
export function DownloadBar({ download }: { download: DownloadItem }) {
  if (download.status !== "active") return null;
  const fraction = downloadFraction(download);
  return (
    <span className={`download-bar ${download.paused ? "is-paused" : fraction === null ? "is-indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
      <i style={fraction !== null ? { width: `${fraction * 100}%` } : download.paused ? { width: "35%" } : undefined} />
    </span>
  );
}
