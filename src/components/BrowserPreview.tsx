import { ArrowUpRight, Bookmark, Headphones, Sparkles } from "lucide-react";

export function BrowserPreview() {
  return (
    <main className="browser-preview">
      <article>
        <div className="article-kicker"><Sparkles size={14} /> Today’s quiet corner</div>
        <h2>The web, with room to breathe.</h2>
        <p className="article-dek">Sleet keeps the page at the center. Tabs live at the edge, tools arrive when called, and everything else gets out of the way.</p>
        <div className="article-meta"><span>6 min read</span><span>Updated today</span></div>
        <div className="article-rule" />
        <p>Open this project through Tauri to browse live sites in native child webviews. The regular web preview shows this composed reading surface because remote pages generally refuse to load inside iframes.</p>
        <p>The shell is intentionally calm: a warm paper canvas, strong editorial type, and motion used only to clarify what changed.</p>
        <blockquote>Fast is a feeling before it is a benchmark.</blockquote>
        <div className="article-actions">
          <button><Bookmark size={16} /> Save</button>
          <button><Headphones size={16} /> Listen</button>
          <button><ArrowUpRight size={16} /> Open source</button>
        </div>
      </article>
      <aside className="reading-progress"><span>01</span><div><i /></div><span>04</span></aside>
    </main>
  );
}
