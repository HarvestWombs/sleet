import { faviconFor } from "../lib/favicons";

/** A site's icon: its favicon when known, otherwise its first letter. */
export function SiteIcon({ url, title, icon, className = "tab-favicon" }: { url?: string; title?: string; icon?: string; className?: string }) {
  const src = icon ?? (url ? faviconFor(url) : undefined);
  if (src) return <img className={`${className} is-image`} src={src} alt="" aria-hidden="true" draggable={false} />;
  return <span className={className} aria-hidden="true">{(title || "U").slice(0, 1).toUpperCase()}</span>;
}
