import { Search, Trash2, X } from "lucide-react";
import { hostOf, permissionName } from "../lib/permissions";
import { permissionDelete, permissionSet, permissionsList, type SitePermission } from "../native/store";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { TEXT_AREAS, TEXT_SIZES, TOAST_POSITIONS } from "../lib/appearance";
import { countImport, parseBookmarksHtml } from "../lib/bookmarkImport";
import { allLinks, type Bookmark } from "../lib/bookmarks";
import { type BookmarkSource, detectBookmarkSources, readBookmarkSource } from "../native/bookmarkImport";
import { BookmarkImportPage, type PendingImport } from "./BookmarkImportPage";
import { PasswordList, PasswordsPanel } from "./Passwords";
import { ShortcutKeys } from "./ShortcutKeys";
import { resolveShortcuts, SHORTCUT_ACTIONS } from "../lib/shortcuts";
import { checkForUpdate, installUpdate, type UpdateInfo } from "../native/browserEngine";
import { APP_ZOOM_LEVELS, GROUP_TINTS, SEARCH_ENGINES, type Settings, ZOOM_LEVELS } from "../lib/settings";

export interface ClearDataOptions {
  history: boolean;
  downloads: boolean;
  cookies: boolean;
  cache: boolean;
  storage: boolean;
  autofill: boolean;
  /** Only data from after this time (epoch ms); everything when absent. */
  since?: number;
}

const RANGES: [string, string, number | undefined][] = [
  ["hour", "Last hour", 60 * 60 * 1000],
  ["day", "Last 24 hours", 24 * 60 * 60 * 1000],
  ["week", "Last 7 days", 7 * 24 * 60 * 60 * 1000],
  ["month", "Last 4 weeks", 28 * 24 * 60 * 60 * 1000],
  ["all", "All time", undefined],
];

const CLEAR_ITEMS: [keyof Omit<ClearDataOptions, "since">, string, string][] = [
  ["history", "History", "Pages you visited"],
  ["downloads", "Download list", "The list only; files stay on disk"],
  ["cookies", "Cookies", "Signs you out of most websites"],
  ["cache", "Cached images and files", "Pages may load slower the first time"],
  ["storage", "Site storage", "Data sites save on this device (local storage, databases)"],
  ["autofill", "Autofill and saved passwords", "Form entries and passwords the engine remembered"],
];

/** Saved site permissions, as a settings page (Security → Site permissions). */
function PermissionsPage() {
  const [rows, setRows] = useState<SitePermission[] | null>(null);
  const load = () => { void permissionsList().then(setRows).catch(() => setRows([])); };
  useEffect(load, []);
  const origins = [...new Set((rows ?? []).map((row) => row.origin))];

  return (
    <div className="permission-list is-page">
      {rows !== null && origins.length === 0 && (
        <div className="settings-card"><div className="settings-row"><div className="settings-copy"><strong>No saved permissions yet</strong><small>When you allow or block something for a site and keep "Remember" ticked, it appears here.</small></div></div></div>
      )}
      {origins.map((origin) => (
        <div className="permission-site settings-card" key={origin}>
          <header>
            <strong>{hostOf(origin)}</strong>
            <button className="link-button" onClick={() => void permissionDelete(origin).then(load)}>Forget all</button>
          </header>
          {(rows ?? []).filter((row) => row.origin === origin).map((row) => (
            <div className="site-info-permission" key={row.kind}>
              <span>{permissionName(row.kind)}</span>
              <div className="permission-controls">
                <div className="segmented is-small" role="radiogroup" aria-label={permissionName(row.kind)}>
                  {(["allow", "block"] as const).map((state) => (
                    <button key={state} role="radio" aria-checked={row.state === state} className={row.state === state ? "is-on" : ""} onClick={() => void permissionSet(origin, row.kind, state).then(load)}>
                      {state === "allow" ? "Allow" : "Block"}
                    </button>
                  ))}
                </div>
                <button className="icon-remove" aria-label={`Forget ${permissionName(row.kind)} for ${hostOf(origin)}`} onClick={() => void permissionDelete(origin, row.kind).then(load)}><X size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface SettingsSurfaceProps {
  settings: Settings;
  section?: string;
  downloadDirError: string | null;
  onChange: (patch: Partial<Settings>) => void;
  onResetSidebar: () => void;
  onClearData: (options: ClearDataOptions) => Promise<void>;
  onOpenDevtools: () => void;
  onReset: () => void;
  bookmarks: Bookmark[];
  onImportBookmarks: (tree: Bookmark[], icons: Record<string, string>) => void;
  /** Sites pinned in the sidebar (separate from bookmarks). */
  pinnedCount: number;
  onRemoveAllPinned: () => void;
  onRemoveAllBookmarks: () => void;
  /** Whether Sleet is the system's default browser (null while unknown). */
  defaultBrowser: { supported: boolean; isDefault: boolean } | null;
  onMakeDefault: () => void;
  /** Bumped by Ctrl+Shift+Delete to open the clear-data dialog. */
  clearRequest?: number;
}

interface Row {
  section: string;
  label: string;
  detail?: string;
  keywords?: string;
  control: ReactNode;
}

const SECTIONS = [
  { id: "appearance", title: "Appearance", description: "How Sleet looks: theme, spacing and zoom." },
  { id: "tabs", title: "Tabs", description: "What opens at launch and how background tabs use memory." },
  { id: "browsing", title: "Browsing", description: "Where new tabs go and how addresses are searched." },
  { id: "downloads", title: "Downloads", description: "Where files are saved and how progress is shown." },
  { id: "privacy", title: "Privacy", description: "What Sleet keeps on this device, and clearing it." },
  { id: "security", title: "Security", description: "Secure connections, popups and what sites may access." },
  { id: "bookmarks", title: "Bookmarks", description: "Bring bookmarks over from another browser or a file." },
  { id: "passwords", title: "Passwords", description: "Saved passwords, encrypted on this device with a master password." },
  { id: "shortcuts", title: "Keyboard shortcuts", description: "The keys for each action. Alt with a letter is quick to reach and easy to remember; the usual browser keys work too." },
  { id: "advanced", title: "Advanced", description: "Developer options and resetting Sleet." },
];

/** Pages opened from a row; shown under their parent category. */
const SUBPAGES: Record<string, { parent: string; title: string; description: string }> = {
  permissions: { parent: "security", title: "Site permissions", description: "Answers you saved for sites. Forget one and the site asks again." },
  "passwords-list": { parent: "passwords", title: "Saved passwords", description: "Copying a password clears it from the clipboard after 30 seconds. Showing one asks for your master password." },
  "import-bookmarks": { parent: "bookmarks", title: "Import bookmarks", description: "Check what will be added, then import. Nothing changes until you press Import." },
  "text-sizes": { parent: "appearance", title: "Text sizes", description: "Make one part of Sleet larger or smaller without changing the rest. Each size multiplies the overall text size." },
};

function ClearDataModal({ onCancel, onClear }: { onCancel: () => void; onClear: (options: ClearDataOptions) => Promise<void> }) {
  const [options, setOptions] = useState<ClearDataOptions>({ history: true, downloads: true, cookies: false, cache: true, storage: false, autofill: false });
  const [range, setRange] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nothing = CLEAR_ITEMS.every(([key]) => !options[key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const toggle = (key: keyof Omit<ClearDataOptions, "since">) => setOptions((current) => ({ ...current, [key]: !current[key] }));
  const run = async () => {
    setBusy(true);
    const span = RANGES.find(([id]) => id === range)?.[2];
    try { await onClear({ ...options, since: span === undefined ? undefined : Date.now() - span }); onCancel(); } catch (reason) { setError(String(reason)); setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="clear-data-title">
        <h3 id="clear-data-title">Clear browsing data</h3>
        <p>Choose what to remove from this device. This can’t be undone. Private tabs aren’t affected.</p>
        <label className="modal-range">
          <span>Time range</span>
          <select className="settings-select" value={range} onChange={(event) => setRange(event.target.value)}>
            {RANGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        {CLEAR_ITEMS.map(([key, title, detail]) => (
          <label className="modal-check" key={key}><input type="checkbox" checked={options[key]} onChange={() => toggle(key)} /><span><strong>{title}</strong><small>{detail}</small></span></label>
        ))}
        {error && <p className="modal-error">Could not clear: {error}</p>}
        <footer className="modal-actions">
          <button className="settings-button" onClick={onCancel}>Cancel</button>
          <button className="settings-button is-primary-danger" disabled={nothing || busy} onClick={() => void run()}><Trash2 size={16} /> {busy ? "Clearing…" : "Clear data"}</button>
        </footer>
      </section>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} role="radio" aria-checked={value === id} className={value === id ? "is-on" : ""} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button className={`toggle ${checked ? "is-on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i /></button>;
}

/** Text field that commits on blur or Enter, so typing a URL doesn't apply half-finished values. */
function CommitInput({ value, onCommit, placeholder, label }: { value: string; onCommit: (value: string) => void; placeholder?: string; label: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft.trim()); };
  return (
    <input
      className="settings-input"
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") setDraft(value); }}
    />
  );
}

function ConfirmButton({ children, onConfirm, danger = true }: { children: ReactNode; onConfirm: () => void | Promise<void>; danger?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      className={`settings-button ${danger ? "is-danger" : ""} ${armed ? "is-armed" : ""}`}
      onClick={() => { if (armed) { setArmed(false); void onConfirm(); } else setArmed(true); }}
    >
      {armed ? "Click again to confirm" : children}
    </button>
  );
}

export function SettingsSurface({ settings, section, downloadDirError, onChange, onResetSidebar, onClearData, onOpenDevtools, onReset, defaultBrowser, onMakeDefault, bookmarks, onImportBookmarks, onRemoveAllBookmarks, pinnedCount, onRemoveAllPinned, clearRequest = 0 }: SettingsSurfaceProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(section ?? "appearance");
  const [sources, setSources] = useState<BookmarkSource[] | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<string | null>(null);
  useEffect(() => {
    if (category === "bookmarks" && sources === null) void detectBookmarkSources().then(setSources);
  }, [category, sources]);

  const startImport = async (source: BookmarkSource) => {
    setImportError(null);
    setImportBusy(source.id);
    try {
      const data = await readBookmarkSource(source.id);
      setPendingImport({ sourceName: source.browser, roots: data.roots, icons: data.icons });
      setCategory("import-bookmarks");
    } catch (error) {
      setImportError(`Couldn't read ${source.browser}'s bookmarks: ${String(error)}`);
    } finally {
      setImportBusy(null);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    try {
      const roots = parseBookmarksHtml(await file.text());
      if (countImport(roots) === 0) { setImportError("No bookmarks found in that file."); return; }
      setPendingImport({ sourceName: file.name.replace(/\.html?$/i, ""), roots, icons: {} });
      setCategory("import-bookmarks");
    } catch (error) {
      setImportError(`Couldn't read that file: ${String(error)}`);
    }
  };
  const [clearOpen, setClearOpen] = useState(false);
  const [clearStatus, setClearStatus] = useState<string | null>(null);
  const scrollRef = useRef<HTMLElement>(null);
  useEffect(() => { if (clearRequest > 0) { setClearStatus(null); setClearOpen(true); } }, [clearRequest]);

  useEffect(() => {
    if (!section) return;
    setQuery("");
    setCategory(section);
  }, [section]);

  const set = <K extends keyof Settings>(key: K) => (value: Settings[K]) => onChange({ [key]: value } as Partial<Settings>);

  const rows: Row[] = [
    { section: "appearance", label: "Theme", keywords: "dark light system color", control: <Segmented label="Theme" value={settings.theme} onChange={set("theme")} options={[["dark", "Dark"], ["system", "System"], ["light", "Light"]]} /> },
    { section: "appearance", label: "Density", detail: "Detailed shows each tab’s website under its title", keywords: "compact comfortable detailed", control: <Segmented label="Density" value={settings.density} onChange={set("density")} options={[["compact", "Compact"], ["comfortable", "Comfortable"], ["detailed", "Detailed"]]} /> },
    { section: "appearance", label: "Sidebar width", detail: "Drag the sidebar edge to resize", control: <button className="settings-button" onClick={onResetSidebar}>Reset width</button> },
    {
      section: "appearance", label: "Interface zoom", detail: "Size of Sleet itself; pages keep their own zoom", keywords: "app ui scale size",
      control: (
        <select className="settings-select" aria-label="Interface zoom" value={settings.appZoom} onChange={(event) => onChange({ appZoom: Number(event.target.value) })}>
          {APP_ZOOM_LEVELS.map((level) => <option key={level} value={level}>{Math.round(level * 100)}%</option>)}
        </select>
      ),
    },
    {
      section: "appearance", label: "Default page zoom", detail: "Ctrl + / Ctrl − / Ctrl+scroll zoom a single tab; Ctrl 0 resets", keywords: "zoom scale size",
      control: (
        <select className="settings-select" aria-label="Default page zoom" value={settings.zoom} onChange={(event) => onChange({ zoom: Number(event.target.value) })}>
          {ZOOM_LEVELS.map((level) => <option key={level} value={level}>{Math.round(level * 100)}%</option>)}
        </select>
      ),
    },
    { section: "appearance", label: "Show full URLs", detail: "Otherwise the address bar shows a simplified address until focused", keywords: "address url", control: <Toggle label="Show full URLs" checked={settings.fullUrls} onChange={set("fullUrls")} /> },
    {
      section: "appearance", label: "Text size", detail: "Size of all of Sleet's text", keywords: "font text bigger smaller accessibility",
      control: (
        <select className="settings-select" aria-label="Text size" value={settings.textSize} onChange={(event) => onChange({ textSize: Number(event.target.value) })}>
          {TEXT_SIZES.map((size) => <option key={size} value={size}>{Math.round(size * 100)}%</option>)}
        </select>
      ),
    },
    {
      section: "appearance", label: "Bookmark size on Home", detail: "How big the bookmark tiles are on the Home page", keywords: "bookmarks tiles home size icons grid",
      control: (
        <select className="settings-select" aria-label="Bookmark size on Home" value={settings.homeTileSize} onChange={(event) => onChange({ homeTileSize: Number(event.target.value) })}>
          {[[48, "Small"], [64, "Medium"], [80, "Large"], [96, "Extra large"]].map(([size, label]) => <option key={size} value={size}>{label} ({size}px)</option>)}
        </select>
      ),
    },
    {
      section: "appearance", label: "Bookmark group background", detail: "How much each group of bookmarks on the Home page is tinted (pick a group's color from its menu)", keywords: "bookmarks groups background tint color home",
      control: (
        <select className="settings-select" aria-label="Bookmark group background" value={settings.homeGroupTint} onChange={(event) => onChange({ homeGroupTint: event.target.value as Settings["homeGroupTint"] })}>
          {GROUP_TINTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      ),
    },
    { section: "appearance", label: "Names under bookmarks", detail: "Show each site's name under its tile on the Home page", keywords: "bookmarks labels names home", control: <Toggle label="Names under bookmarks" checked={settings.homeShowLabels} onChange={set("homeShowLabels")} /> },
    {
      section: "appearance", label: "Pinned site size", detail: "How big the pinned sites are at the top of the sidebar", keywords: "pinned favorites sidebar size icons grid",
      control: (
        <select className="settings-select" aria-label="Pinned site size" value={settings.pinnedSize} onChange={(event) => onChange({ pinnedSize: Number(event.target.value) })}>
          {[[40, "Small"], [50, "Medium"], [60, "Large"], [72, "Extra large"]].map(([size, label]) => <option key={size} value={size}>{label} ({size}px)</option>)}
        </select>
      ),
    },
    { section: "appearance", label: "Text sizes by area", detail: "Sidebar, address bar, notifications, menus and pages on their own", keywords: "font sidebar toast palette menu", control: <button className="settings-button" onClick={() => { setQuery(""); setCategory("text-sizes"); }}>Customize</button> },
    {
      section: "appearance", label: "Notification position", detail: "Where download and site notices appear over the page", keywords: "toast corner",
      control: (
        <select className="settings-select" aria-label="Notification position" value={settings.toastPosition} onChange={(event) => onChange({ toastPosition: event.target.value as Settings["toastPosition"] })}>
          {TOAST_POSITIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      ),
    },
    ...TEXT_AREAS.map((area) => ({
      section: "text-sizes",
      label: area.label,
      detail: "detail" in area ? area.detail : undefined,
      keywords: "text size font",
      control: (
        <select className="settings-select" aria-label={`${area.label} text size`} value={settings.textAreas[area.id] ?? 1} onChange={(event) => onChange({ textAreas: { ...settings.textAreas, [area.id]: Number(event.target.value) } })}>
          {TEXT_SIZES.map((size) => <option key={size} value={size}>{Math.round(size * 100)}%</option>)}
        </select>
      ),
    })),
    { section: "appearance", label: "Reduce motion", detail: "Turn off interface animations", keywords: "animation accessibility", control: <Toggle label="Reduce motion" checked={settings.reducedMotion} onChange={set("reducedMotion")} /> },

    { section: "tabs", label: "On startup", keywords: "restore session launch", control: <Segmented label="On startup" value={settings.startup} onChange={set("startup")} options={[["new-tab", "New tab"], ["restore", "Restore tabs"], ["page", "Specific page"]]} /> },
    ...(settings.startup === "page" ? [{ section: "tabs", label: "Startup page", keywords: "home", control: <CommitInput label="Startup page" value={settings.startupPage} onCommit={set("startupPage")} placeholder="https://" /> }] : []),
    { section: "browsing", label: "New tab page", keywords: "home start", control: <CommitInput label="New tab page" value={settings.newTabPage} onCommit={set("newTabPage")} placeholder="https://" /> },
    {
      section: "browsing", label: "Search engine", keywords: "google duckduckgo bing brave startpage",
      control: (
        <select className="settings-select" aria-label="Search engine" value={settings.searchEngine} onChange={(event) => onChange({ searchEngine: event.target.value as Settings["searchEngine"] })}>
          {Object.entries(SEARCH_ENGINES).map(([id, engine]) => <option key={id} value={id}>{engine.name}</option>)}
        </select>
      ),
    },
    {
      section: "tabs", label: "Unload inactive tabs", detail: "Free memory from tabs you haven’t opened in a while. They reload when selected.", keywords: "sleep memory inactive discard",
      control: (
        <select className="settings-select" aria-label="Unload inactive tabs" value={settings.inactiveMinutes} onChange={(event) => onChange({ inactiveMinutes: Number(event.target.value) })}>
          <option value={0}>Never</option>
          {[1, 5, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>After {minutes} min</option>)}
        </select>
      ),
    },
    { section: "security", label: "Prefer HTTPS", detail: "Upgrade typed http:// addresses, except local hosts", keywords: "secure tls", control: <Toggle label="Prefer HTTPS" checked={settings.preferHttps} onChange={set("preferHttps")} /> },

    {
      section: "downloads", label: "Download location", detail: downloadDirError ?? "Full path to an existing folder. Leave empty for the system default.", keywords: "folder path save",
      control: <CommitInput label="Download location" value={settings.downloadDir} onCommit={set("downloadDir")} placeholder="System default" />,
    },
    { section: "downloads", label: "Ask where to save each file", detail: "Choose a folder and name for every download", keywords: "save as dialog location prompt", control: <Toggle label="Ask where to save each file" checked={settings.downloadAsk} onChange={set("downloadAsk")} /> },
    {
      section: "downloads", label: "Open automatically",
      detail: settings.autoOpenTypes.length ? "These file types open as soon as they finish downloading" : "None yet. Right-click a download and choose “Always open” to add its file type. Programs and scripts are never opened automatically.",
      keywords: "always open file type extension auto",
      control: settings.autoOpenTypes.length > 0 && (
        <span className="settings-chips">
          {settings.autoOpenTypes.map((extension) => (
            <button key={extension} type="button" className="settings-chip" title={`Stop opening .${extension} files automatically`} onClick={() => onChange({ autoOpenTypes: settings.autoOpenTypes.filter((item) => item !== extension) })}>
              .{extension} <X size={13} />
            </button>
          ))}
        </span>
      ),
    },
    { section: "downloads", label: "Download notifications", detail: "Show a small notice with progress in the upper left", keywords: "toast progress", control: <Toggle label="Download notifications" checked={settings.downloadToasts} onChange={set("downloadToasts")} /> },
    {
      section: "downloads", label: "Notification time", detail: "How long a notice stays after its download finishes", keywords: "toast seconds",
      control: (
        <select className="settings-select" aria-label="Notification time" value={settings.toastSeconds} onChange={(event) => onChange({ toastSeconds: Number(event.target.value) })}>
          {[3, 5, 8, 12, 20].map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
        </select>
      ),
    },
    { section: "downloads", label: "Clear completed downloads", detail: "Remove finished downloads from the list on launch", control: <Toggle label="Clear completed downloads" checked={settings.clearCompletedDownloads} onChange={set("clearCompletedDownloads")} /> },

    {
      section: "privacy", label: "Tracking prevention", detail: "Blocks trackers from sites you haven\u2019t visited. Strict may break some sites.", keywords: "trackers cookies third-party fingerprint",
      control: <Segmented label="Tracking prevention" value={settings.trackingPrevention} onChange={set("trackingPrevention")} options={[["none", "Off"], ["basic", "Basic"], ["balanced", "Balanced"], ["strict", "Strict"]]} />,
    },
    { section: "security", label: "HTTPS-only mode", detail: "Load every page over a secure connection; ask before falling back to http", keywords: "secure https tls encryption", control: <Toggle label="HTTPS-only mode" checked={settings.httpsOnly} onChange={set("httpsOnly")} /> },
    { section: "security", label: "Block popups", detail: "Only open new windows a site opens when you click", keywords: "popup window", control: <Toggle label="Block popups" checked={settings.blockPopups} onChange={set("blockPopups")} /> },
    { section: "security", label: "Site permissions", detail: "Camera, microphone, location, notifications and more", keywords: "camera microphone location notifications allow block", control: <button className="settings-button" onClick={() => { setQuery(""); setCategory("permissions"); }}>Open</button> },
    ...(sources === null
      ? [{ section: "bookmarks", label: "Looking for other browsers…", control: <span className="settings-value">Checking</span> }]
      : sources.length === 0
        ? [{ section: "bookmarks", label: "No other browsers found", detail: "Chrome, Edge, Brave, Vivaldi, Opera, Firefox and Arc are checked. You can still import a bookmarks file.", control: <span /> }]
        : sources.map((source) => ({
          section: "bookmarks",
          label: `Import from ${source.browser}`,
          detail: `${source.profile} · ${source.count} bookmark${source.count === 1 ? "" : "s"}`,
          keywords: "import bookmarks favorites browser",
          control: <button className="settings-button" disabled={importBusy !== null || source.count === 0} onClick={() => void startImport(source)}>{importBusy === source.id ? "Reading…" : "Import…"}</button>,
        }))),
    {
      section: "bookmarks", label: "Import from a file", detail: importError ?? "A bookmarks .html file exported from any browser", keywords: "import bookmarks html file netscape",
      control: (
        <label className="settings-button file-button">
          Choose file…
          <input type="file" accept=".html,.htm,text/html" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
      ),
    },
    { section: "bookmarks", label: "Bookmarks in Sleet", detail: `${allLinks(bookmarks).length} bookmarks in ${bookmarks.filter((node) => node.kind === "folder").length} groups on the Home page`, keywords: "remove delete all bookmarks", control: <ConfirmButton onConfirm={onRemoveAllBookmarks}>Remove all</ConfirmButton> },
    { section: "bookmarks", label: "Pinned sites", detail: `${pinnedCount} pinned at the top of the sidebar (the star in the address bar)`, keywords: "remove delete all pinned favorites sidebar", control: <ConfirmButton onConfirm={onRemoveAllPinned}>Remove all</ConfirmButton> },
    { section: "security", label: "Passwords", detail: "Saved passwords, master password, import and export", keywords: "password vault login master autofill", control: <button className="settings-button" onClick={() => { setQuery(""); setCategory("passwords"); }}>Open</button> },
    { section: "security", label: "Harmful downloads", detail: "Windows checks installers and other risky files; Sleet asks before keeping one it flags", keywords: "smartscreen exe download virus", control: <span className="settings-value">Always on</span> },
    {
      section: "security", label: "Kept without asking",
      detail: settings.trustedDownloadTypes.length ? "Flagged files of these types are kept without asking. Click one to be asked again." : "None. Tick “Always keep” on a download warning to add its file type.",
      keywords: "harmful download keep trust file type exe always",
      control: settings.trustedDownloadTypes.length > 0 && (
        <span className="settings-chips">
          {settings.trustedDownloadTypes.map((extension) => (
            <button key={extension} type="button" className="settings-chip" title={`Ask again before keeping .${extension} files`} onClick={() => onChange({ trustedDownloadTypes: settings.trustedDownloadTypes.filter((item) => item !== extension) })}>
              .{extension} <X size={13} />
            </button>
          ))}
        </span>
      ),
    },
    { section: "privacy", label: "Keep history", keywords: "retention forever days session disabled", control: <Segmented label="Keep history" value={settings.historyRetention} onChange={set("historyRetention")} options={[["forever", "Forever"], ["30-days", "30 days"], ["session", "This session"], ["disabled", "Off"]]} /> },
    {
      section: "privacy", label: "Clear browsing data", keywords: "cookies cache storage delete",
      detail: clearStatus ?? "History, downloads, cookies, cache and more, for a time range.",
      control: <button className="settings-button is-danger" onClick={() => { setClearStatus(null); setClearOpen(true); }}><Trash2 size={16} /> Clear data…</button>,
    },

    { section: "privacy", label: "Clear history when Sleet closes", keywords: "exit quit", control: <Toggle label="Clear history when Sleet closes" checked={settings.clearHistoryOnExit} onChange={set("clearHistoryOnExit")} /> },
    { section: "privacy", label: "Clear cookies and site data when Sleet closes", detail: "Signs you out of sites each time", keywords: "exit quit cookies", control: <Toggle label="Clear cookies and site data when Sleet closes" checked={settings.clearSiteDataOnExit} onChange={set("clearSiteDataOnExit")} /> },

    {
      section: "shortcuts", label: "All shortcuts", detail: Object.keys(settings.shortcuts ?? {}).length ? `${Object.keys(settings.shortcuts).length} changed from the defaults` : "All on their default keys",
      keywords: "keyboard shortcuts keys reset defaults",
      control: <ConfirmButton onConfirm={() => onChange({ shortcuts: {} })}>Reset all</ConfirmButton>,
    },
    ...SHORTCUT_ACTIONS.map((action) => ({
      section: "shortcuts",
      label: action.label,
      detail: action.group,
      keywords: `keyboard shortcut key ${action.group} ${resolveShortcuts(settings.shortcuts)[action.id].join(" ")}`,
      control: <ShortcutKeys action={action} overrides={settings.shortcuts ?? {}} onChange={(shortcuts) => onChange({ shortcuts })} />,
    })),
    { section: "shortcuts", label: "Fixed keys", detail: "Alt+1–9 and Alt with a longer number pick a tab by number, Ctrl+1–9 open your pinned sites in order (Ctrl+9 the last), Esc stops a page loading, Ctrl+scroll zooms.", keywords: "keyboard digits number tab pinned escape zoom", control: <span /> },
    { section: "advanced", label: "Updates", detail: "Sleet checks a signed release feed; nothing installs without your click.", keywords: "update version upgrade release about", control: <UpdateControl /> },
    { section: "advanced", label: "Custom user agent", detail: "Applies to tabs opened after the change. Leave empty for the default.", keywords: "ua", control: <CommitInput label="Custom user agent" value={settings.userAgent} onCommit={set("userAgent")} placeholder="Default" /> },
    { section: "advanced", label: "Developer tools", detail: "Inspect the current page", keywords: "devtools inspect debug", control: <button className="settings-button" onClick={onOpenDevtools}>Open</button> },
    { section: "advanced", label: "Reset Sleet", detail: "Restore default settings and clear tabs, history and downloads list", keywords: "factory defaults", control: <ConfirmButton onConfirm={onReset}>Reset</ConfirmButton> },
  ];

  const text = query.trim().toLowerCase();
  const visible = text ? rows.filter((row) => `${row.label} ${row.detail ?? ""} ${row.keywords ?? ""} ${row.section}`.toLowerCase().includes(text)) : rows;

  const subpage = !text ? SUBPAGES[category] : undefined;
  const current = SECTIONS.find((item) => item.id === (subpage ? subpage.parent : category)) ?? SECTIONS[0];
  const shownSections = text ? [...SECTIONS, { id: "text-sizes", title: "Text sizes", description: "" }] : [subpage ? { id: category, title: subpage.title, description: subpage.description } : current];

  return (
    <main className="library-surface settings-surface" ref={scrollRef}>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings categories">
          <label className="settings-search">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings" aria-label="Search settings" />
          </label>
          <span className="settings-nav-label">Settings</span>
          {SECTIONS.map((item) => (
            <button key={item.id} className={!text && item.id === current.id ? "is-current" : ""} aria-current={!text && item.id === current.id ? "page" : undefined} onClick={() => { setQuery(""); setCategory(item.id); }}>
              {item.title}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {defaultBrowser?.supported && !text && (
            defaultBrowser.isDefault
              ? <div className="default-browser is-set">Sleet is your default browser.</div>
              : (
                <div className="default-browser">
                  <span><strong>Make Sleet your default browser</strong><small>Links you open in other apps will open here. Windows asks you to confirm.</small></span>
                  <button className="settings-button is-primary" onClick={onMakeDefault}>Make default</button>
                </div>
              )
          )}
          {text
            ? <header className="settings-heading"><h2>Results</h2><p>Settings matching “{query.trim()}”.</p></header>
            : subpage
              ? (
                <header className="settings-heading">
                  <button className="settings-back" onClick={() => setCategory(subpage.parent)}>← {current.title}</button>
                  <h2>{subpage.title}</h2>
                  <p>{subpage.description}</p>
                </header>
              )
              : <header className="settings-heading"><h2>{current.title}</h2><p>{current.description} Changes apply as you make them.</p></header>}
          {category === "permissions" && !text && <PermissionsPage />}
          {category === "passwords" && !text && <PasswordsPanel settings={settings} onChange={onChange} onOpenList={() => setCategory("passwords-list")} />}
          {category === "passwords-list" && !text && <PasswordList />}
          {category === "import-bookmarks" && !text && pendingImport && (
            <BookmarkImportPage
              pending={pendingImport}
              bookmarks={bookmarks}
              onImport={onImportBookmarks}
              onDone={() => { setPendingImport(null); setCategory("bookmarks"); }}
            />
          )}

          {shownSections.map(({ id, title }) => {
            const sectionRows = visible.filter((row) => row.section === id);
            if (sectionRows.length === 0) return null;
            return (
              <section className="settings-section" id={`settings-${id}`} key={id}>
                {text && <h3>{title}</h3>}
                <div className="settings-card">
                  {sectionRows.map((row) => (
                    <div className="settings-row" key={row.label}>
                      <div className="settings-copy">
                        <strong>{row.label}</strong>
                        {row.detail && <small className={row.label === "Download location" && downloadDirError ? "is-error" : ""}>{row.detail}</small>}
                      </div>
                      <div className="settings-control">{row.control}</div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          {visible.length === 0 && <div className="empty-state"><Search size={34} /><strong>No matching settings</strong></div>}
        </div>
      </div>
      {clearOpen && (
        <ClearDataModal
          onCancel={() => setClearOpen(false)}
          onClear={async (options) => { await onClearData(options); setClearStatus("Cleared."); }}
        />
      )}
    </main>
  );
}

/** Version, "Check for updates", and "Install and restart" when one is found. */
function UpdateControl() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "installing" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => { void checkForUpdate().then(setInfo).catch(() => undefined); }, []);
  const check = async () => {
    setState("checking");
    try { setInfo(await checkForUpdate()); setState("idle"); } catch (failure) { setError(String(failure)); setState("error"); }
  };
  const install = async () => {
    setState("installing");
    try { await installUpdate(); } catch (failure) { setError(String(failure)); setState("error"); }
  };
  if (info && !info.configured) return <span className="settings-note">Version {info.current} · updates aren’t set up for this build</span>;
  return (
    <span className="settings-inline">
      <span className="settings-note">
        {info ? `Version ${info.current}` : "Version …"}
        {state === "error" ? ` · ${error}` : info?.available ? ` · ${info.available} is available` : info ? " · up to date" : ""}
      </span>
      {info?.available
        ? <button className="settings-button is-primary" disabled={state === "installing"} onClick={() => void install()}>{state === "installing" ? "Installing…" : "Install and restart"}</button>
        : <button className="settings-button" disabled={state === "checking"} onClick={() => void check()}>{state === "checking" ? "Checking…" : "Check for updates"}</button>}
    </span>
  );
}
