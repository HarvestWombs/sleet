import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./browserEngine";

/**
 * Password vault (src-tauri/src/vault.rs). Encryption, filling and copying
 * happen in Rust; this side only sees sites and usernames, plus a password
 * when the user explicitly reveals one.
 */

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  remembered: boolean;
  count: number;
  /** Seconds before another unlock attempt is allowed. */
  retryIn: number;
}

export interface VaultEntry {
  id: string;
  origin: string;
  username: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface EntryInput {
  url?: string;
  username?: string;
  password?: string;
  title?: string;
  notes?: string;
}

export interface LoginOffer {
  pendingId: string;
  origin: string;
  username: string;
  kind: "new" | "update" | "locked";
}

export interface ImportCounts { added: number; updated: number; skipped: number }

const call = <T,>(command: string, args?: Record<string, unknown>) => {
  if (!isTauri()) return Promise.reject(new Error("Passwords need the desktop app"));
  return invoke<T>(command, args);
};

/** Turns "wrong master password" style errors into a sentence. */
export const vaultError = (error: unknown) => {
  const text = String(error).replace(/^Error:\s*/, "");
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".");
};

export const vaultStatus = () => (isTauri() ? invoke<VaultStatus>("vault_status") : Promise.resolve<VaultStatus>({ exists: false, unlocked: false, remembered: false, count: 0, retryIn: 0 }));
export const vaultCreate = (password: string) => call<void>("vault_create", { password });
export const vaultUnlock = (password: string) => call<void>("vault_unlock", { password });
export const vaultUnlockDevice = () => call<void>("vault_unlock_device");
export const vaultLock = () => call<void>("vault_lock");
export const vaultChangePassword = (current: string, next: string) => call<void>("vault_change_password", { current, next });
export const vaultSetRemember = (remember: boolean) => call<void>("vault_set_remember", { remember });
export const vaultSetAutoLock = (minutes: number) => (isTauri() ? invoke<void>("vault_set_auto_lock", { minutes }) : Promise.resolve());
export const vaultReset = () => call<void>("vault_reset");
export const vaultList = () => call<VaultEntry[]>("vault_list");
export const vaultMatches = (url: string) => call<VaultEntry[]>("vault_matches", { url });
export const vaultAdd = (input: EntryInput) => call<VaultEntry>("vault_add", { input });
export const vaultUpdate = (id: string, input: EntryInput) => call<VaultEntry>("vault_update", { id, input });
export const vaultDelete = (id: string) => call<void>("vault_delete", { id });
export const vaultReveal = (id: string, master: string) => call<{ password: string; notes: string }>("vault_reveal", { id, master });
export const vaultCopy = (id: string, field: "username" | "password") => call<void>("vault_copy", { id, field });
export const vaultFill = (tabLabel: string, id: string) => call<void>("vault_fill", { label: tabLabel, id });
export const vaultFillGenerated = (tabLabel: string, length: number, symbols: boolean) => call<LoginOffer | null>("vault_fill_generated", { label: tabLabel, length, symbols });
export const vaultGenerate = (length: number, symbols: boolean) => call<string>("vault_generate", { length, symbols });
export const vaultOfferRecheck = (pendingId: string) => call<LoginOffer>("vault_offer_recheck", { pendingId });
export const vaultResolveOffer = (pendingId: string, discard: boolean) => call<void>("vault_resolve_offer", { pendingId, discard });
export const vaultImportCsv = (text: string) => call<ImportCounts>("vault_import_csv", { text });
export const vaultImportBackup = (text: string, password: string) => call<ImportCounts>("vault_import_backup", { text, password });
export const vaultExportBackup = (master: string) => call<string>("vault_export_backup", { master });
export const vaultExportCsv = (master: string) => call<string>("vault_export_csv", { master });
export const vaultRevealExport = (path: string) => call<void>("vault_reveal_export", { path });

/** Rough strength estimate for the master password field (length and variety). */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!password) return { score: 0, label: "" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  const words = password.trim().split(/\s+/).length;
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (password.length >= 16 || words >= 4) score += 1;
  if (classes >= 3) score += 1;
  if (/^(.)\1+$/.test(password) || /^(password|12345678|qwerty)/i.test(password)) score = 0;
  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  return { score: clamped, label: ["Too weak", "Weak", "Fair", "Good", "Strong"][clamped] };
}
