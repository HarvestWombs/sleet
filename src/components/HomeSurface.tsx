import { Search, VenetianMask } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

interface HomeSurfaceProps {
  searchName: string;
  /** Private tab: explain what is and isn't kept. */
  private?: boolean;
  onNavigate: (value: string) => void;
}

const greetingFor = (hour: number) => (hour < 5 ? "Good night" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

/**
 * Sleet's built-in home screen (sleet://home). Rendered by the chrome, so it
 * needs no page webview. Bookmarks and history/download summaries go below the
 * search box as their own sections.
 */
export function HomeSurface({ searchName, private: isPrivate = false, onNavigate }: HomeSurfaceProps) {
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) onNavigate(query);
  };

  return (
    <main className={`home-surface ${isPrivate ? "is-private" : ""}`}>
      <div className="home-inner">
        <div className="home-mark" aria-hidden="true">{isPrivate ? <VenetianMask size={22} /> : "S"}</div>
        <p className="home-time">{clock.format(now)} · {day.format(now)}</p>
        <h1>{isPrivate ? "Private tab" : greetingFor(now.getHours())}</h1>
        {isPrivate && (
          <p className="home-private-note">
            Pages you visit here aren’t saved to history, and cookies and site data are deleted when you close your last private tab.
            Downloads are kept. Your network, employer or internet provider can still see where you go.
          </p>
        )}
        <form className="home-search" onSubmit={submit} role="search">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${searchName} or enter an address`} aria-label="Search or enter an address" spellCheck={false} />
          <kbd>↵</kbd>
        </form>
        <p className="home-hint"><kbd>Ctrl K</kbd> commands · <kbd>Ctrl L</kbd> address bar · <kbd>Ctrl T</kbd> new tab</p>
      </div>
    </main>
  );
}
