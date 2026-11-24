//! Everyday page commands: stop loading, find in page, print, save as PDF,
//! opening links in other apps, and checking for updates.

use crate::page_scripts;
use serde::Serialize;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

type Result<T> = std::result::Result<T, String>;

fn page(app: &AppHandle, label: &str) -> Result<tauri::Webview> {
    app.get_webview(label).ok_or_else(|| "that tab is closed".to_string())
}

/// Stops the current page load (works in every engine).
#[tauri::command]
pub fn stop_loading(app: AppHandle, label: String) -> Result<()> {
    page(&app, &label)?.eval("window.stop()").map_err(|error| error.to_string())
}

#[derive(Serialize, serde::Deserialize, Default)]
pub struct FindResult {
    count: usize,
    index: i64,
}

/// Runs a script in the page and returns its (string) result.
async fn eval_result(webview: tauri::Webview, script: String) -> Result<String> {
    let (tx, rx) = mpsc::channel::<String>();
    webview
        .eval_with_callback(script, move |result| { let _ = tx.send(result); })
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "the page didn't respond".to_string()))
        .await
        .map_err(|error| error.to_string())?
}

/// Finds `query` in the page; `restart` re-searches, otherwise moves to the next/previous match.
#[tauri::command]
pub async fn find_in_page(app: AppHandle, label: String, query: String, backwards: bool, restart: bool) -> Result<FindResult> {
    let webview = page(&app, &label)?;
    let raw = eval_result(webview, page_scripts::find_script(&query, backwards, restart)).await?;
    // Engines return the script's value JSON-encoded, so the JSON string may be wrapped once more.
    let json = serde_json::from_str::<String>(&raw).unwrap_or(raw);
    Ok(serde_json::from_str(&json).unwrap_or_default())
}

#[tauri::command]
pub fn find_clear(app: AppHandle, label: String) -> Result<()> {
    page(&app, &label)?.eval(page_scripts::FIND_CLEAR_SCRIPT).map_err(|error| error.to_string())
}

/// Opens the engine's print dialog (which also offers Save as PDF).
#[tauri::command]
pub fn print_page(app: AppHandle, label: String) -> Result<()> {
    page(&app, &label)?.eval("window.print()").map_err(|error| error.to_string())
}

fn safe_file_name(title: &str) -> String {
    let cleaned: String = title.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { ' ' }).collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = if trimmed.is_empty() { "page".to_string() } else { trimmed.chars().take(80).collect() };
    name
}

/// Saves the page as a PDF in Downloads (Windows; elsewhere use Print → Save as PDF).
#[tauri::command]
pub async fn save_page_pdf(app: AppHandle, label: String, title: String) -> Result<String> {
    let webview = page(&app, &label)?;
    let dir = app.path().download_dir().map_err(|error| error.to_string())?;
    let mut path = dir.join(format!("{}.pdf", safe_file_name(&title)));
    let mut counter = 2;
    while path.exists() {
        path = dir.join(format!("{} ({counter}).pdf", safe_file_name(&title)));
        counter += 1;
    }
    crate::native::print_to_pdf(&webview, &path).await?;
    Ok(path.display().to_string())
}

/// Schemes that are never handed to other apps: they can run code or reach
/// local files, or have been abused to attack Windows.
const BLOCKED_SCHEMES: &[&str] = &[
    "file", "javascript", "data", "vbscript", "blob", "about", "chrome", "edge", "view-source",
    "ms-msdt", "search-ms", "search", "ms-officecmd", "ms-word", "ms-excel", "ms-powerpoint", "ms-cxh", "ms-cxh-full",
    "ms-appinstaller", "ms-settings", "shell", "res", "mk", "its", "ms-its", "hcp", "jar",
];

pub fn external_allowed(url: &url::Url) -> bool {
    let scheme = url.scheme().to_lowercase();
    !matches!(scheme.as_str(), "http" | "https") && !BLOCKED_SCHEMES.contains(&scheme.as_str())
}

/// Opens a mailto:, tel:, zoom: (etc.) link in the app the system uses for it.
/// The UI asks first; this re-checks the scheme.
#[tauri::command]
pub fn open_external(url: String) -> Result<()> {
    let parsed = url::Url::parse(&url).map_err(|error| error.to_string())?;
    if !external_allowed(&parsed) {
        return Err("Sleet doesn't open that kind of link in other apps".into());
    }
    crate::native::open_url(parsed.as_str())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// False when this build has no update key / download location configured.
    configured: bool,
    current: String,
    available: Option<String>,
    notes: Option<String>,
}

fn updater_configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

/// Registers the updater plugin only when an update key is configured, so
/// builds without one start normally.
pub fn init_updater(app: &tauri::App) {
    if updater_configured(app.handle()) {
        if let Err(error) = app.handle().plugin(tauri_plugin_updater::Builder::new().build()) {
            eprintln!("updater disabled: {error}");
        }
    }
}

/// Checks the configured update location for a newer, signed version.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateInfo> {
    let current = app.package_info().version.to_string();
    if !updater_configured(&app) {
        return Ok(UpdateInfo { configured: false, current, available: None, notes: None });
    }
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|error| error.to_string())?.check().await.map_err(|error| error.to_string())?;
    Ok(UpdateInfo {
        configured: true,
        current,
        available: update.as_ref().map(|update| update.version.clone()),
        notes: update.and_then(|update| update.body),
    })
}

/// Downloads the update, verifies its signature, installs it and restarts.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<()> {
    if !updater_configured(&app) {
        return Err("updates aren't set up for this build".into());
    }
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Sleet is up to date")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|error| error.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str) -> bool {
        external_allowed(&url::Url::parse(url).unwrap())
    }

    #[test]
    fn app_links_are_offered_but_dangerous_schemes_never() {
        for ok in ["mailto:someone@example.com", "tel:+15551234567", "zoommtg://zoom.us/join?confno=1", "msteams:/l/meetup-join/x", "spotify:track:1"] {
            assert!(allowed(ok), "{ok} should be offered");
        }
        for bad in ["https://example.com", "http://example.com", "file:///C:/Windows/system32/calc.exe", "javascript:alert(1)", "data:text/html,hi", "ms-msdt:/id PCWDiagnostic", "search-ms:query=x", "ms-officecmd:{}", "vbscript:x", "MS-MSDT:/id x"] {
            assert!(!allowed(bad), "{bad} must be refused");
        }
    }

    /// Writes the page scripts out so they can be run in a real browser: `SLEET_DUMP=dir cargo test dump`.
    #[test]
    fn dump_page_scripts() {
        let Ok(dir) = std::env::var("SLEET_DUMP") else { return };
        std::fs::write(format!("{dir}/find.js"), crate::page_scripts::find_script("it's \"sleet\"", false, true)).unwrap();
        std::fs::write(format!("{dir}/links.js"), crate::page_scripts::LINK_SCRIPT).unwrap();
    }

    #[test]
    fn pdf_names_are_safe() {
        assert_eq!(safe_file_name("A/B: \"C\" <d>"), "A B C d");
        assert_eq!(safe_file_name("   "), "page");
        assert_eq!(safe_file_name("..\\..\\evil"), ".. .. evil");
    }
}
