//! Tauri commands for the password vault (see vault.rs for the security design).
//! Expensive key derivation runs off the main thread. Passwords only leave
//! Rust for an explicit reveal; filling and copying happen here.

use crate::store::Store;
use crate::vault::{self, EntryInput, EntryMeta, LoginOffer, Vault, VaultStatus};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;

const CLIPBOARD_CLEAR_SECS: u64 = 30;

fn changed(app: &AppHandle) {
    let _ = app.emit("sleet-vault-changed", ());
}

/// Runs vault work that derives keys (slow by design) on a worker thread.
async fn blocking<T: Send + 'static>(app: AppHandle, run: impl FnOnce(&Vault, &Store) -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault = app.state::<Vault>();
        let store = app.state::<Store>();
        run(&vault, &store)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Locks the vault when idle (checked every 20 seconds) and expires stale save offers.
pub fn start_auto_lock(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(20));
        if app.state::<Vault>().lock_if_idle() {
            changed(&app);
        }
    });
}

#[tauri::command]
pub fn vault_status(vault: State<'_, Vault>, store: State<'_, Store>) -> Result<VaultStatus> {
    vault.status(&store)
}

#[tauri::command]
pub async fn vault_create(app: AppHandle, password: Zeroizing<String>) -> Result<()> {
    let handle = app.clone();
    blocking(app, move |vault, store| vault.create(store, &password)).await?;
    changed(&handle);
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(app: AppHandle, password: Zeroizing<String>) -> Result<()> {
    let handle = app.clone();
    blocking(app, move |vault, store| vault.unlock(store, &password)).await?;
    changed(&handle);
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock_device(app: AppHandle) -> Result<()> {
    let handle = app.clone();
    blocking(app, |vault, store| vault.unlock_with_device(store)).await?;
    changed(&handle);
    Ok(())
}

#[tauri::command]
pub fn vault_lock(app: AppHandle, vault: State<'_, Vault>) {
    vault.lock();
    changed(&app);
}

#[tauri::command]
pub async fn vault_change_password(app: AppHandle, current: Zeroizing<String>, next: Zeroizing<String>) -> Result<()> {
    blocking(app, move |vault, store| vault.change_password(store, &current, &next)).await
}

#[tauri::command]
pub async fn vault_set_remember(app: AppHandle, remember: bool) -> Result<()> {
    let handle = app.clone();
    blocking(app, move |vault, store| vault.set_remember(store, remember)).await?;
    changed(&handle);
    Ok(())
}

#[tauri::command]
pub fn vault_set_auto_lock(vault: State<'_, Vault>, minutes: u64) {
    vault.set_auto_lock(minutes);
}

/// Deletes every saved password (forgotten master password).
#[tauri::command]
pub fn vault_reset(app: AppHandle, vault: State<'_, Vault>, store: State<'_, Store>) -> Result<()> {
    vault.reset(&store)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn vault_list(vault: State<'_, Vault>) -> Result<Vec<EntryMeta>> {
    vault.list()
}

/// Logins saved for the exact origin of `url`.
#[tauri::command]
pub fn vault_matches(vault: State<'_, Vault>, url: String) -> Result<Vec<EntryMeta>> {
    match vault::origin_of(&url) {
        Some(origin) => vault.matches(&origin),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn vault_add(app: AppHandle, vault: State<'_, Vault>, store: State<'_, Store>, input: EntryInput) -> Result<EntryMeta> {
    let meta = vault.add(&store, &input)?;
    changed(&app);
    Ok(meta)
}

#[tauri::command]
pub fn vault_update(app: AppHandle, vault: State<'_, Vault>, store: State<'_, Store>, id: String, input: EntryInput) -> Result<EntryMeta> {
    let meta = vault.update(&store, &id, &input)?;
    changed(&app);
    Ok(meta)
}

#[tauri::command]
pub fn vault_delete(app: AppHandle, vault: State<'_, Vault>, store: State<'_, Store>, id: String) -> Result<()> {
    vault.delete(&store, &id)?;
    changed(&app);
    Ok(())
}

#[derive(Serialize)]
pub struct Revealed {
    password: Zeroizing<String>,
    notes: Zeroizing<String>,
}

/// Shows a password after re-entering the master password.
#[tauri::command]
pub async fn vault_reveal(app: AppHandle, id: String, master: Zeroizing<String>) -> Result<Revealed> {
    blocking(app, move |vault, store| {
        let (password, notes) = vault.reveal(store, &id, &master)?;
        Ok(Revealed { password: Zeroizing::new(password), notes: Zeroizing::new(notes) })
    })
    .await
}

/// Puts text on the clipboard and clears it after 30 seconds if it's still there.
fn copy_then_clear(text: Zeroizing<String>) -> Result<()> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard.set_text(text.as_str()).map_err(|error| error.to_string())?;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(CLIPBOARD_CLEAR_SECS));
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            if clipboard.get_text().map(|current| Zeroizing::new(current).as_str() == text.as_str()).unwrap_or(false) {
                let _ = clipboard.clear();
            }
        }
    });
    Ok(())
}

/// Copies a login's username or password without sending it to the UI.
#[tauri::command]
pub fn vault_copy(vault: State<'_, Vault>, store: State<'_, Store>, id: String, field: String) -> Result<()> {
    let (meta, password) = vault.credentials(&store, &id)?;
    let text = if field == "username" { Zeroizing::new(meta.username.clone()) } else { password };
    copy_then_clear(text)
}

/// The page's current origin, read from the engine (not from the UI).
fn page_origin(app: &AppHandle, label: &str) -> Result<(tauri::Webview, String)> {
    let webview = app.get_webview(label).ok_or("that tab is closed")?;
    let url = webview.url().map_err(|error| error.to_string())?;
    let origin = vault::origin_of(url.as_str()).ok_or("this page can't use saved passwords")?;
    Ok((webview, origin))
}

fn fill_script(username: Option<&str>, password: &str, new_password: bool) -> Result<String> {
    let username = serde_json::to_string(&username).map_err(|error| error.to_string())?;
    let password = Zeroizing::new(serde_json::to_string(password).map_err(|error| error.to_string())?);
    Ok(format!("window.__sleetFill && window.__sleetFill({username}, {}, {new_password});", password.as_str()))
}

/// Fills a saved login into the page, only if the page is on the login's exact origin.
#[tauri::command]
pub fn vault_fill(app: AppHandle, vault: State<'_, Vault>, store: State<'_, Store>, label: String, id: String) -> Result<()> {
    let (webview, origin) = page_origin(&app, &label)?;
    let (meta, password) = vault.credentials(&store, &id)?;
    if meta.origin != origin {
        return Err("that login is for a different site".into());
    }
    let script = Zeroizing::new(fill_script(Some(&meta.username), &password, false)?);
    webview.eval(script.as_str()).map_err(|error| error.to_string())
}

/// Fills a new strong password into a sign-up or change-password form and
/// offers to save it.
#[tauri::command]
pub fn vault_fill_generated(app: AppHandle, vault: State<'_, Vault>, label: String, length: usize, symbols: bool) -> Result<Option<LoginOffer>> {
    let (webview, origin) = page_origin(&app, &label)?;
    let password = vault::generate_password(length, symbols);
    let script = Zeroizing::new(fill_script(None, &password, true)?);
    webview.eval(script.as_str()).map_err(|error| error.to_string())?;
    Ok(vault.offer(&origin, "", &password))
}

/// A strong password for the user to copy (shown in Settings).
#[tauri::command]
pub fn vault_generate(length: usize, symbols: bool) -> Result<Zeroizing<String>> {
    let password = vault::generate_password(length, symbols);
    copy_then_clear(password.clone())?;
    Ok(password)
}

#[tauri::command]
pub fn vault_offer_recheck(vault: State<'_, Vault>, pending_id: String) -> Result<LoginOffer> {
    vault.recheck_offer(&pending_id)
}

#[tauri::command]
pub fn vault_resolve_offer(app: AppHandle, vault: State<'_, Vault>, store: State<'_, Store>, pending_id: String, discard: bool) -> Result<()> {
    vault.resolve_offer(&store, &pending_id, discard)?;
    if !discard {
        changed(&app);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ImportCounts {
    added: usize,
    updated: usize,
    skipped: usize,
}

#[tauri::command]
pub async fn vault_import_csv(app: AppHandle, text: Zeroizing<String>) -> Result<ImportCounts> {
    let handle = app.clone();
    let (added, updated, skipped) = blocking(app, move |vault, store| vault.add_many(store, vault::parse_password_csv(&text)?)).await?;
    changed(&handle);
    Ok(ImportCounts { added, updated, skipped })
}

#[tauri::command]
pub async fn vault_import_backup(app: AppHandle, text: String, password: Zeroizing<String>) -> Result<ImportCounts> {
    let handle = app.clone();
    let (added, updated, skipped) = blocking(app, move |vault, store| vault.import_backup(store, &text, &password)).await?;
    changed(&handle);
    Ok(ImportCounts { added, updated, skipped })
}

fn export_path(app: &AppHandle, extension: &str) -> Result<std::path::PathBuf> {
    let dir = app.path().download_dir().map_err(|error| error.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or_default();
    Ok(dir.join(format!("sleet-passwords-{stamp}.{extension}")))
}

/// Writes an encrypted backup (needs the master password to read) to Downloads.
#[tauri::command]
pub async fn vault_export_backup(app: AppHandle, master: Zeroizing<String>) -> Result<String> {
    let path = export_path(&app, "sleetvault")?;
    let backup = blocking(app, move |vault, store| vault.export_backup(store, &master)).await?;
    std::fs::write(&path, backup).map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
}

/// Writes an UNENCRYPTED CSV (for moving to another manager) to Downloads.
#[tauri::command]
pub async fn vault_export_csv(app: AppHandle, master: Zeroizing<String>) -> Result<String> {
    let path = export_path(&app, "csv")?;
    let csv = blocking(app, move |vault, store| vault.export_csv(store, &master)).await?;
    std::fs::write(&path, csv.as_bytes()).map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
}

/// Opens the folder holding an export, with the file selected.
#[tauri::command]
pub fn vault_reveal_export(app: AppHandle, path: String) -> Result<()> {
    // Only files Sleet itself wrote to Downloads.
    let dir = app.path().download_dir().map_err(|error| error.to_string())?;
    let file = std::path::PathBuf::from(&path);
    let name_ok = file.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("sleet-passwords-"));
    if file.parent() != Some(dir.as_path()) || !name_ok {
        return Err("not a Sleet export".into());
    }
    crate::native::reveal_path(&file)
}
