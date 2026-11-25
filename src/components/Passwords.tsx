import { Copy, Eye, KeyRound, Lock, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { Settings } from "../lib/settings";
import { listenEvent } from "../native/browserEngine";
import {
  type VaultEntry, type VaultStatus, passwordStrength, vaultAdd, vaultChangePassword, vaultCopy, vaultCreate, vaultDelete,
  vaultError, vaultExportBackup, vaultExportCsv, vaultGenerate, vaultImportBackup, vaultImportCsv, vaultList, vaultLock,
  vaultReset, vaultReveal, vaultRevealExport, vaultSetRemember, vaultStatus, vaultUnlock, vaultUnlockDevice, vaultUpdate,
} from "../native/vault";
import { SiteIcon } from "./SiteIcon";

/** Vault status, refreshed whenever the vault changes (lock, unlock, edits). */
export function useVaultStatus() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  useEffect(() => {
    const refresh = () => { void vaultStatus().then(setStatus).catch(() => undefined); };
    refresh();
    const stop = listenEvent("sleet-vault-changed", refresh);
    return () => { void stop.then((fn) => fn()); };
  }, []);
  return status;
}

const host = (origin: string) => origin.replace(/^https?:\/\//, "");

function Row({ label, detail, children }: { label: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-copy"><strong>{label}</strong>{detail && <small>{detail}</small>}</div>
      {children && <div className="settings-control">{children}</div>}
    </div>
  );
}

/** Inline "enter your master password" step for reveal and export. */
function MasterPrompt({ action, onSubmit, onCancel }: { action: string; onSubmit: (master: string) => Promise<void>; onCancel: () => void }) {
  const [master, setMaster] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await onSubmit(master); setMaster(""); } catch (reason) { setError(vaultError(reason)); } finally { setBusy(false); }
  };
  return (
    <form className="vault-prompt" onSubmit={(event) => void submit(event)}>
      <input type="password" autoFocus value={master} onChange={(event) => setMaster(event.target.value)} placeholder="Master password" aria-label="Master password" autoComplete="off" />
      <button type="submit" className="settings-button is-primary" disabled={!master || busy}>{busy ? "Checking…" : action}</button>
      <button type="button" className="settings-button" onClick={onCancel}>Cancel</button>
      {error && <span className="vault-error">{error}</span>}
    </form>
  );
}

function Strength({ password }: { password: string }) {
  const { score, label } = passwordStrength(password);
  if (!password) return null;
  return <span className={`vault-strength is-${score}`}><i style={{ width: `${(score / 4) * 100}%` }} />{label}</span>;
}

/** Settings → Passwords: create, unlock, and manage the vault. */
export function PasswordsPanel({ settings, onChange, onOpenList }: { settings: Settings; onChange: (patch: Partial<Settings>) => void; onOpenList: () => void }) {
  const status = useVaultStatus();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [change, setChange] = useState({ current: "", next: "", confirm: "" });
  const [generated, setGenerated] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"backup" | "csv" | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [backupFile, setBackupFile] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); } catch (reason) { setError(vaultError(reason)); } finally { setBusy(false); }
  };

  // Remembered device: opening Passwords unlocks without the master password.
  useEffect(() => {
    if (status?.exists && !status.unlocked && status.remembered) void vaultUnlockDevice().catch(() => undefined);
  }, [status?.exists, status?.unlocked, status?.remembered]);

  if (!status) return <div className="settings-card"><Row label="Loading…" /></div>;

  if (!status.exists) {
    const mismatch = confirm.length > 0 && confirm !== password;
    const ready = password.length >= 8 && password === confirm && understood && !busy;
    return (
      <form className="settings-card vault-card" onSubmit={(event) => { event.preventDefault(); if (ready) void run(async () => { await vaultCreate(password); setPassword(""); setConfirm(""); }); }}>
        <Row label="Set up the password vault" detail="Sleet saves your passwords encrypted with a master password that only you know. It's never stored or sent anywhere." />
        <div className="vault-fields">
          <label>Master password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="At least 8 characters; a long phrase is best" /></label>
          <Strength password={password} />
          <label>Confirm master password<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" /></label>
          {mismatch && <span className="vault-error">The passwords don't match.</span>}
          <label className="vault-check"><input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} /> I understand Sleet can't recover my passwords if I forget this master password.</label>
          {error && <span className="vault-error">{error}</span>}
          <div><button type="submit" className="settings-button is-primary" disabled={!ready}>{busy ? "Creating… (this takes a moment)" : "Create vault"}</button></div>
        </div>
      </form>
    );
  }

  if (!status.unlocked) {
    return (
      <div className="settings-card vault-card">
        <Row label="Passwords are locked" detail={`Unlock with your master password to save, fill or manage passwords.${status.retryIn > 0 ? ` Too many wrong attempts — wait ${status.retryIn} s.` : ""}`}><Lock size={20} /></Row>
        <form className="vault-fields" onSubmit={(event) => { event.preventDefault(); void run(async () => { await vaultUnlock(password); setPassword(""); }); }}>
          <label>Master password<input type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
          {error && <span className="vault-error">{error}</span>}
          <div className="vault-actions">
            <button type="submit" className="settings-button is-primary" disabled={!password || busy}>{busy ? "Unlocking…" : "Unlock"}</button>
            {status.remembered && <button type="button" className="settings-button" disabled={busy} onClick={() => void run(vaultUnlockDevice)}>Unlock with this device</button>}
          </div>
        </form>
        <Row label="Forgot your master password?" detail="It can't be recovered. You can delete the vault and start over; every saved password is lost.">
          <ResetButton onReset={() => void run(vaultReset)} />
        </Row>
      </div>
    );
  }

  const never = settings.passwordsNever ?? [];
  return (
    <>
      <div className="settings-card">
        <Row label="Saved passwords" detail={`${status.count} saved, encrypted on this device`}><button className="settings-button is-primary" onClick={onOpenList}>Open</button></Row>
        <Row label="Lock passwords now" detail={status.remembered ? "Clears them from memory. On this remembered device Sleet unlocks again by itself when needed." : "Sleet locks them by itself after the time below."}><button className="settings-button" onClick={() => void vaultLock()}><Lock size={16} /> Lock</button></Row>
        <Row label="Lock after">
          <select className="settings-select" aria-label="Lock after" value={settings.vaultAutoLock} onChange={(event) => onChange({ vaultAutoLock: Number(event.target.value) })}>
            {[1, 5, 15, 30, 60, 240].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} min` : `${minutes / 60} h`} unused</option>)}
            <option value={0}>Never (not recommended)</option>
          </select>
        </Row>
        <Row label="Remember on this device" detail="Save and fill passwords without the master password, using this computer's secure store (Credential Manager, Keychain or keyring). Viewing, exporting and changing the master password still ask. Anyone signed in to this computer account could use your saved logins.">
          <button className={`toggle ${status.remembered ? "is-on" : ""}`} role="switch" aria-checked={status.remembered} aria-label="Remember on this device" onClick={() => void run(() => vaultSetRemember(!status.remembered))}><i /></button>
        </Row>
        <Row label="Change master password">
          <button className="settings-button" onClick={() => setChanging((value) => !value)}>{changing ? "Cancel" : "Change…"}</button>
        </Row>
        {changing && (
          <form className="vault-fields is-inset" onSubmit={(event) => { event.preventDefault(); void run(async () => { await vaultChangePassword(change.current, change.next); setChange({ current: "", next: "", confirm: "" }); setChanging(false); setMessage("Master password changed."); }); }}>
            <label>Current master password<input type="password" value={change.current} onChange={(event) => setChange((value) => ({ ...value, current: event.target.value }))} autoComplete="current-password" /></label>
            <label>New master password<input type="password" value={change.next} onChange={(event) => setChange((value) => ({ ...value, next: event.target.value }))} autoComplete="new-password" /></label>
            <Strength password={change.next} />
            <label>Confirm new password<input type="password" value={change.confirm} onChange={(event) => setChange((value) => ({ ...value, confirm: event.target.value }))} autoComplete="new-password" /></label>
            <div><button type="submit" className="settings-button is-primary" disabled={busy || change.next.length < 8 || change.next !== change.confirm || !change.current}>{busy ? "Changing…" : "Change master password"}</button></div>
          </form>
        )}
        {(error || message) && <div className="settings-row"><span className={error ? "vault-error" : "vault-ok"}>{error ?? message}</span></div>}
      </div>

      <h3 className="vault-heading">Saving and filling</h3>
      <div className="settings-card">
        <Row label="Offer to save passwords" detail="Ask after you sign in to a site. Never in private tabs.">
          <button className={`toggle ${settings.passwordsOffer ? "is-on" : ""}`} role="switch" aria-checked={settings.passwordsOffer} aria-label="Offer to save passwords" onClick={() => onChange({ passwordsOffer: !settings.passwordsOffer })}><i /></button>
        </Row>
        <Row label="Never saved for" detail={never.length ? never.map(host).join(", ") : "No sites yet"}>
          {never.length > 0 && <button className="settings-button" onClick={() => onChange({ passwordsNever: [] })}>Clear list</button>}
        </Row>
        <Row label="Password generator" detail={generated ? <span className="vault-generated">{generated} <em>copied; clears in 30 s</em></span> : "Strong random passwords, also offered on sign-up forms"}>
          <select className="settings-select" aria-label="Generated password length" value={settings.generatorLength} onChange={(event) => onChange({ generatorLength: Number(event.target.value) })}>
            {[16, 20, 24, 32, 48].map((length) => <option key={length} value={length}>{length} characters</option>)}
          </select>
          <button className="settings-button" onClick={() => void vaultGenerate(settings.generatorLength, true).then(setGenerated).catch((reason) => setError(vaultError(reason)))}><KeyRound size={16} /> Generate</button>
        </Row>
      </div>

      <h3 className="vault-heading">Import and export</h3>
      <div className="settings-card">
        <Row label="Import from a CSV file" detail="Exported from Chrome, Edge, Firefox, Bitwarden, 1Password and most others">
          <label className="settings-button file-button">Choose file…<input type="file" accept=".csv,text/csv" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void run(async () => { const counts = await vaultImportCsv(await file.text()); setMessage(`Imported ${counts.added} new, updated ${counts.updated}, skipped ${counts.skipped}.`); });
          }} /></label>
        </Row>
        <Row label="Restore a Sleet backup" detail="A .sleetvault file made with Export backup">
          <label className="settings-button file-button">Choose file…<input type="file" accept=".sleetvault,application/json" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void file.text().then(setBackupFile);
          }} /></label>
        </Row>
        {backupFile && (
          <div className="settings-row"><MasterPrompt action="Restore" onCancel={() => setBackupFile(null)} onSubmit={async (master) => {
            const counts = await vaultImportBackup(backupFile, master);
            setBackupFile(null);
            setMessage(`Restored ${counts.added} new, updated ${counts.updated}, skipped ${counts.skipped}.`);
          }} /></div>
        )}
        <Row label="Export backup" detail="Encrypted file that needs your master password to open. Saved to Downloads.">
          <button className="settings-button" onClick={() => { setExported(null); setExporting("backup"); }}>Export…</button>
        </Row>
        <Row label="Export as CSV" detail={<span className="vault-error-text">Unencrypted: anyone with the file can read every password. Only for moving to another password manager; delete it afterwards.</span>}>
          <button className="settings-button is-danger" onClick={() => { setExported(null); setExporting("csv"); }}>Export…</button>
        </Row>
        {exporting && (
          <div className="settings-row"><MasterPrompt action={exporting === "csv" ? "Export unencrypted" : "Export"} onCancel={() => setExporting(null)} onSubmit={async (master) => {
            const path = exporting === "csv" ? await vaultExportCsv(master) : await vaultExportBackup(master);
            setExporting(null);
            setExported(path);
          }} /></div>
        )}
        {exported && <Row label="Exported" detail={exported}><button className="settings-button" onClick={() => void vaultRevealExport(exported)}>Show in folder</button></Row>}
      </div>
    </>
  );
}

function ResetButton({ onReset }: { onReset: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(false), 5000); return () => window.clearTimeout(timer); }, [armed]);
  return <button className={`settings-button is-danger ${armed ? "is-armed" : ""}`} onClick={() => { if (armed) onReset(); else setArmed(true); }}>{armed ? "Click again: delete every password" : "Delete vault…"}</button>;
}

interface EditState { id: string | null; url: string; username: string; password: string; notes: string }

/** Settings → Passwords → Saved passwords. */
export function PasswordList() {
  const status = useVaultStatus();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [query, setQuery] = useState("");
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; password: string; notes: string } | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => { void vaultList().then(setEntries).catch(() => setEntries([])); };
  useEffect(load, [status?.unlocked, status?.count]);
  // Revealed passwords hide again after 30 seconds.
  useEffect(() => { if (!revealed) return; const timer = window.setTimeout(() => setRevealed(null), 30_000); return () => window.clearTimeout(timer); }, [revealed]);

  // A remembered device unlocks itself when the list loads.
  if (status && !status.unlocked && !status.remembered) return <div className="settings-card"><Row label="Passwords are locked" detail="Go back and unlock them first." /></div>;

  const text = query.trim().toLowerCase();
  const shown = text ? entries.filter((entry) => `${entry.origin} ${entry.username} ${entry.title}`.toLowerCase().includes(text)) : entries;
  const copy = (entry: VaultEntry, field: "username" | "password") => {
    void vaultCopy(entry.id, field).then(() => { setCopied(`${entry.id}:${field}`); window.setTimeout(() => setCopied(null), 2000); }).catch((reason) => setError(vaultError(reason)));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    try {
      const input = { url: editing.url, username: editing.username, password: editing.password || undefined, notes: editing.notes || undefined };
      if (editing.id) await vaultUpdate(editing.id, input); else await vaultAdd(input);
      setEditing(null);
      setError(null);
      load();
    } catch (reason) { setError(vaultError(reason)); }
  };

  const editor = editing && (
    <form className="vault-fields is-inset vault-editor" onSubmit={(event) => void save(event)}>
      <label>Site<input value={editing.url} onChange={(event) => setEditing({ ...editing, url: event.target.value })} placeholder="https://example.com" spellCheck={false} /></label>
      <label>Username<input value={editing.username} onChange={(event) => setEditing({ ...editing, username: event.target.value })} autoComplete="off" /></label>
      <label>{editing.id ? "New password (leave empty to keep)" : "Password"}<input type="password" value={editing.password} onChange={(event) => setEditing({ ...editing, password: event.target.value })} autoComplete="new-password" /></label>
      <label>Notes{editing.id ? " (leave empty to keep)" : ""}<input value={editing.notes} onChange={(event) => setEditing({ ...editing, notes: event.target.value })} autoComplete="off" /></label>
      <div className="vault-actions"><button type="submit" className="settings-button is-primary">Save</button><button type="button" className="settings-button" onClick={() => setEditing(null)}>Cancel</button></div>
    </form>
  );

  return (
    <div className="vault-list">
      <div className="vault-list-tools">
        <label className="settings-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search passwords" aria-label="Search passwords" /></label>
        <button className="settings-button is-primary" onClick={() => setEditing({ id: null, url: "", username: "", password: "", notes: "" })}><Plus size={16} /> Add</button>
      </div>
      {error && <p className="vault-error">{error}</p>}
      {editing && !editing.id && <div className="settings-card">{editor}</div>}
      <div className="settings-card">
        {shown.length === 0 && <Row label={entries.length ? "No matches" : "No saved passwords yet"} detail={entries.length ? undefined : "Sign in to a site and Sleet will offer to save it, or import a CSV."} />}
        {shown.map((entry) => (
          <div className="vault-entry" key={entry.id}>
            <div className="vault-entry-main">
              <SiteIcon url={entry.origin} title={entry.title} className="library-site-icon" />
              <span className="settings-copy"><strong>{entry.title || host(entry.origin)}</strong><small>{entry.username || "(no username)"} · {host(entry.origin)}</small></span>
              <span className="vault-entry-actions">
                <button title="Copy username" aria-label={`Copy username for ${host(entry.origin)}`} onClick={() => copy(entry, "username")}>{copied === `${entry.id}:username` ? "✓" : <Copy size={16} />}</button>
                <button title="Copy password (clears from the clipboard in 30 s)" aria-label={`Copy password for ${host(entry.origin)}`} onClick={() => copy(entry, "password")}>{copied === `${entry.id}:password` ? "✓" : <KeyRound size={16} />}</button>
                <button title="Show password" aria-label={`Show password for ${host(entry.origin)}`} onClick={() => { setRevealed(null); setRevealing(entry.id); }}><Eye size={16} /></button>
                <button title="Edit" aria-label={`Edit ${host(entry.origin)}`} onClick={() => setEditing({ id: entry.id, url: entry.origin, username: entry.username, password: "", notes: "" })}><Pencil size={16} /></button>
                <DeleteEntry onDelete={() => void vaultDelete(entry.id).then(load).catch((reason) => setError(vaultError(reason)))} />
              </span>
            </div>
            {revealing === entry.id && <MasterPrompt action="Show" onCancel={() => setRevealing(null)} onSubmit={async (master) => { const secret = await vaultReveal(entry.id, master); setRevealing(null); setRevealed({ id: entry.id, ...secret }); }} />}
            {revealed?.id === entry.id && (
              <div className="vault-revealed"><code>{revealed.password}</code>{revealed.notes && <small>{revealed.notes}</small>}<button className="link-button" onClick={() => setRevealed(null)}>Hide</button></div>
            )}
            {editing?.id === entry.id && editor}
          </div>
        ))}
      </div>
    </div>
  );
}

function DeleteEntry({ onDelete }: { onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const timer = window.setTimeout(() => setArmed(false), 4000); return () => window.clearTimeout(timer); }, [armed]);
  return <button className={armed ? "is-armed" : ""} title={armed ? "Click again to delete" : "Delete"} aria-label="Delete" onClick={() => { if (armed) onDelete(); else setArmed(true); }}>{armed ? "Delete?" : <Trash2 size={16} />}</button>;
}
