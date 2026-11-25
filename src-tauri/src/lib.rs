mod bookmark_import;
mod browsing;
mod page_scripts;
mod default_browser;
mod favicons;
mod native;
mod page_hooks;
mod password_bridge;
mod privacy;
mod store;
mod vault;
mod vault_commands;
mod windows;

use serde::Serialize;
use std::{path::PathBuf, sync::Mutex};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
};
use url::Url;

const PAGE_PREFIX: &str = "page-";
const OVERLAY_PREFIX: &str = "overlay-";

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Position and size as one change. Setting them separately makes wry read the
/// other half back from the window, and after a page moved to another window
/// (reparent) it measures against the old one, shifting the page by the gap
/// between the two windows.
fn view_rect(bounds: ViewBounds) -> tauri::Rect {
    tauri::Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
    }
}

#[derive(Clone, Serialize)]
struct NavigationPayload {
    label: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct TitlePayload {
    label: String,
    title: String,
}

#[derive(Clone, Serialize)]
struct DownloadPayload {
    label: String,
    url: String,
    path: Option<String>,
    success: Option<bool>,
    phase: &'static str,
}

/// Folder chosen in Settings for new downloads. `None` keeps the engine default.
#[derive(Default)]
struct DownloadDir(Mutex<Option<PathBuf>>);

#[tauri::command]
async fn create_browser_view(
    app: AppHandle,
    caller: tauri::Webview,
    label: String,
    url: String,
    bounds: ViewBounds,
    zoom: Option<f64>,
    user_agent: Option<String>,
    private: Option<bool>,
) -> Result<(), String> {
    if app.get_webview(&label).is_some() {
        return Ok(());
    }

    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    // The page goes in the window whose Sleet chrome asked for it.
    let window = caller.window();

    let navigation_app = app.clone();
    let title_app = app.clone();
    let download_app = app.clone();
    let popup_app = app.clone();
    let command_app = app.clone();
    let label_for_navigation = label.clone();
    let label_for_title = label.clone();
    let label_for_download = label.clone();
    let upgrade_label = label.clone();
    let popup_label = label.clone();

    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .initialization_script(
            r#"
              (() => {
                const send = (command) => { window.location.href = `sleet-command://${command}`; };
                let altDigits = false;
                document.addEventListener('keydown', (event) => {
                  if (event.altKey && !event.ctrlKey && !event.metaKey) {
                    const nav = { ArrowLeft: 'back', ArrowRight: 'forward' }[event.key];
                    const digit = /^[0-9]$/.test(event.key) ? event.key : null;
                    if (nav || digit) {
                      event.preventDefault();
                      event.stopImmediatePropagation();
                      if (digit) altDigits = true;
                      send(nav ?? `tab-digit-${digit}`);
                      return;
                    }
                  }
                  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
                  const fkey = plain && { F5: 'reload', F11: 'fullscreen', F3: event.shiftKey ? 'find-previous' : 'find-next' }[event.key];
                  if (fkey) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    send(fkey);
                    return;
                  }
                  if (plain && event.key === 'Escape' && document.readyState !== 'complete') { send('stop'); return; }
                  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
                  const commands = {
                    k: 'palette', l: 'address', t: 'new-tab', n: 'new-window', w: 'close-tab',
                    y: 'history', j: 'downloads', ',': 'settings',
                    '=': 'zoom-in', '+': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset', d: 'bookmark',
                    f: 'find', g: 'find-next', p: 'print', r: 'reload',
                    tab: 'next-tab', pagedown: 'next-tab', pageup: 'previous-tab'
                  };
                  const shifted = { n: 'new-private-tab', w: 'reopen-tab', t: 'reopen-tab', s: 'toggle-sidebar', tab: 'previous-tab', g: 'find-previous', delete: 'clear-data', r: 'reload' };
                  const key = event.key.toLowerCase();
                  const digit = !event.shiftKey && /^[1-9]$/.test(event.key) ? `tab-index-${event.key}` : null;
                  const command = digit ?? (event.shiftKey && shifted[key] ? shifted[key] : commands[key]);
                  if (!command) return;
                  event.preventDefault();
                  event.stopImmediatePropagation();
                  send(command);
                }, true);
                document.addEventListener('keyup', (event) => {
                  if (event.key === 'Alt' && altDigits) {
                    altDigits = false;
                    event.preventDefault();
                    send('tab-commit');
                  }
                }, true);
                let lastWheel = 0;
                window.addEventListener('wheel', (event) => {
                  if (!event.ctrlKey) return;
                  event.preventDefault();
                  const now = Date.now();
                  if (now - lastWheel < 80) return;
                  lastWheel = now;
                  send(event.deltaY < 0 ? 'zoom-in' : 'zoom-out');
                }, { capture: true, passive: false });
              })();
            "#,
        )
        .initialization_script(password_bridge::PAGE_SCRIPT)
        .initialization_script(page_scripts::LINK_SCRIPT)
        .on_navigation(move |url| {
            if url.scheme() == "sleet-command" {
                match url.host_str() {
                    Some(kind @ ("background-tab" | "foreground-tab")) => {
                        let target = url
                            .query_pairs()
                            .find(|(key, _)| key == "u")
                            .and_then(|(_, value)| Url::parse(&value).ok())
                            .filter(|target| matches!(target.scheme(), "http" | "https"));
                        if let Some(target) = target {
                            let _ = command_app.emit(
                                "sleet-open-link",
                                serde_json::json!({ "label": upgrade_label, "url": target.as_str(), "background": kind == "background-tab" }),
                            );
                        }
                    }
                    Some(kind @ ("fullscreen-enter" | "fullscreen-exit")) => {
                        let _ = command_app.emit(
                            "sleet-fullscreen",
                            serde_json::json!({ "label": upgrade_label, "fullscreen": kind == "fullscreen-enter" }),
                        );
                    }
                    Some(command) => {
                        let _ = command_app.emit("sleet-command", serde_json::json!({ "label": upgrade_label, "command": command }));
                    }
                    None => {}
                }
                return false;
            }
            // mailto:, tel:, zoommtg: ... are offered to other apps after the user agrees.
            if !matches!(url.scheme(), "http" | "https") {
                if browsing::external_allowed(url) {
                    let _ = command_app.emit(
                        "sleet-external-link",
                        serde_json::json!({ "label": upgrade_label, "url": url.as_str() }),
                    );
                }
                return false;
            }
            // HTTPS-only: load the https address instead.
            if let Some(secure) = privacy::https_upgrade(url) {
                let app = command_app.clone();
                let label = upgrade_label.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(webview) = app.get_webview(&label) {
                        let _ = webview.navigate(secure);
                    }
                });
                return false;
            }
            matches!(url.scheme(), "http" | "https")
        })
        .on_page_load(move |webview, payload| {
            let _ = navigation_app.emit(
                "sleet-loading",
                serde_json::json!({ "label": label_for_navigation, "loading": matches!(payload.event(), PageLoadEvent::Started) }),
            );
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = navigation_app.emit(
                    "sleet-navigation",
                    NavigationPayload {
                        label: label_for_navigation.clone(),
                        url: payload.url().to_string(),
                    },
                );
                // A sharp, large site icon to replace the engine's 16px one.
                favicons::refresh(navigation_app.clone(), webview.clone(), label_for_navigation.clone());
            }
        })
        .on_document_title_changed(move |_webview, title| {
            let _ = title_app.emit(
                "sleet-title",
                TitlePayload {
                    label: label_for_title.clone(),
                    title,
                },
            );
        })
        .on_new_window(move |url, _features| {
            // On Windows the popup blocker (privacy.rs) decides and opens the tab.
            #[cfg(not(target_os = "windows"))]
            let _ = popup_app.emit("sleet-new-tab", serde_json::json!({ "label": popup_label, "url": url.as_str() }));
            #[cfg(target_os = "windows")]
            let _ = (&popup_app, &popup_label, url);
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let folder = download_app
                        .state::<DownloadDir>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|dir| dir.clone());
                    if let (Some(folder), Some(name)) = (folder, destination.file_name()) {
                        if folder.is_absolute() && folder.is_dir() {
                            *destination = folder.join(name);
                        }
                    }
                    // "Ask where to save each file". On Windows the engine waits for
                    // the dialog without blocking (see native::watch_downloads).
                    #[cfg(not(target_os = "windows"))]
                    if native::ASK_WHERE.load(std::sync::atomic::Ordering::Relaxed) {
                        match native::ask_save_path(destination) {
                            Some(chosen) => *destination = chosen,
                            None => return false,
                        }
                    }
                    let _ = download_app.emit(
                        "sleet-download",
                        DownloadPayload {
                            label: label_for_download.clone(),
                            url: url.to_string(),
                            path: Some(destination.to_string_lossy().into_owned()),
                            success: None,
                            phase: "requested",
                        },
                    );
                }
                // On Windows Sleet tracks how downloads end itself (native::watch_downloads):
                // the engine reports a pause as "finished, failed", which would end it here.
                #[cfg(not(target_os = "windows"))]
                DownloadEvent::Finished { url, path, success } => {
                    let _ = download_app.emit(
                        "sleet-download",
                        DownloadPayload {
                            label: label_for_download.clone(),
                            url: url.to_string(),
                            path: path.map(|value| value.to_string_lossy().into_owned()),
                            success: Some(success),
                            phase: "finished",
                        },
                    );
                }
                _ => {}
            }
            true
        })
        .position(LogicalPosition::new(bounds.x, bounds.y))
        .size(LogicalSize::new(bounds.width, bounds.height));

    if let Some(agent) = user_agent.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        builder = builder.user_agent(agent);
    }
    if private.unwrap_or(false) {
        // InPrivate: cookies and storage live only while private tabs are open.
        builder = builder.incognito(true);
        privacy::mark_private(&label);
    }

    let webview = window
        .add_child(builder)
        .map_err(|error| error.to_string())?;

    if let Some(zoom) = zoom.filter(|value| (*value - 1.0).abs() > f64::EPSILON) {
        let _ = webview.set_zoom(zoom);
    }
    native::watch_downloads(&webview, app.clone(), label.clone());
    privacy::attach(&webview, app.clone(), label.clone());
    page_hooks::attach(&webview, app.clone(), label);
    raise_overlays(&app);

    Ok(())
}

#[tauri::command]
fn close_browser_view(app: AppHandle, label: String) -> Result<(), String> {
    privacy::forget_view(&label);
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn navigate_browser_view(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| error.to_string())?;
    app.get_webview(&label)
        .ok_or_else(|| format!("webview {label} was not found"))?
        .navigate(parsed)
        .map_err(|error| error.to_string())
}

/// Shows the active page and hides the rest. Focus only moves when asked, so
/// background updates (titles, navigation) never steal focus from the chrome.
/// `also_visible`: other pages docked beside the active one stay shown.
#[tauri::command]
fn activate_browser_view(
    app: AppHandle,
    active_label: Option<String>,
    labels: Vec<String>,
    focus: Option<bool>,
    also_visible: Option<Vec<String>>,
) -> Result<(), String> {
    let also_visible = also_visible.unwrap_or_default();
    for label in labels {
        if let Some(webview) = app.get_webview(&label) {
            if active_label.as_deref() == Some(label.as_str()) {
                page_hooks::set_low_memory(&webview, false);
                webview.show().map_err(|error| error.to_string())?;
                if focus.unwrap_or(false) {
                    webview.set_focus().map_err(|error| error.to_string())?;
                }
            } else if active_label.is_some() && also_visible.contains(&label) {
                page_hooks::set_low_memory(&webview, false);
                webview.show().map_err(|error| error.to_string())?;
            } else {
                webview.hide().map_err(|error| error.to_string())?;
                // Out of sight: let the engine trim this page's memory.
                page_hooks::set_low_memory(&webview, true);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn resize_browser_view(app: AppHandle, label: String, bounds: ViewBounds) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_bounds(view_rect(bounds))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn browser_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview {label} was not found"))?;
    match action.as_str() {
        "reload" => webview.reload(),
        "devtools" => {
            webview.open_devtools();
            Ok(())
        }
        _ => return Err(format!("unknown browser action: {action}")),
    }
    .map_err(|error| error.to_string())
}

/// Back/forward in the page's own history. `false` means it had nowhere to go
/// (for example a tab reloaded after being unloaded), so Sleet can fall back
/// to the history it saved for that tab.
#[tauri::command]
async fn step_history(app: AppHandle, label: String, back: bool) -> Result<bool, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview {label} was not found"))?;
    page_hooks::step_history(&webview, back).await
}

/// Keeps overlays (hidden ones too) above pages, which are added later and stack on top.
pub(crate) fn raise_overlays(app: &AppHandle) {
    for (label, webview) in app.webviews() {
        if label.starts_with(OVERLAY_PREFIX) {
            page_hooks::raise(&webview);
        }
    }
}

/// Shows an overlay: a small Sleet webview drawn above page webviews, used
/// for UI that must sit on top of page content (palette, toasts). It loads
/// the chrome's own bundle with `?overlay=<kind>`.
#[tauri::command]
async fn overlay_show(
    app: AppHandle,
    caller: tauri::Webview,
    label: String,
    kind: String,
    bounds: ViewBounds,
    focus: bool,
    zoom: Option<f64>,
) -> Result<(), String> {
    if !label.starts_with(OVERLAY_PREFIX) {
        return Err("overlay labels must start with overlay-".into());
    }
    let webview = match app.get_webview(&label) {
        Some(webview) => webview,
        None => {
            // Overlays belong to the window of the chrome that shows them.
            let mut url = caller.url().map_err(|error| error.to_string())?;
            url.set_fragment(None);
            url.set_query(Some(&format!("overlay={kind}")));
            let window = caller.window();
            let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
                .transparent(true)
                .position(LogicalPosition::new(bounds.x, bounds.y))
                .size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)));
            window.add_child(builder).map_err(|error| error.to_string())?
        }
    };
    webview
        .set_bounds(view_rect(bounds))
        .and_then(|_| webview.show())
        .map_err(|error| error.to_string())?;
    if let Some(zoom) = zoom {
        let _ = webview.set_zoom(zoom.clamp(0.5, 2.0));
    }
    page_hooks::raise(&webview);
    if focus {
        webview.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Moves/resizes a visible overlay without showing, raising or focusing it.
#[tauri::command]
fn overlay_place(app: AppHandle, label: String, bounds: ViewBounds) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label).filter(|_| label.starts_with(OVERLAY_PREFIX)) {
        webview
            .set_bounds(view_rect(bounds))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Closes an overlay to free its memory (each is a separate engine process
/// worth ~40 MB). Rarely used overlays are released after a while unused.
#[tauri::command]
fn overlay_release(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label).filter(|_| label.starts_with(OVERLAY_PREFIX)) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn overlay_hide(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label).filter(|_| label.starts_with(OVERLAY_PREFIX)) {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Applies privacy settings: HTTPS-only, popup blocking, tracking prevention.
#[tauri::command]
fn set_privacy_options(app: AppHandle, options: privacy::PrivacyOptions) {
    privacy::set_options(&options);
    for webview in app.webviews().into_values() {
        privacy::apply_tracking_to(&webview);
    }
}

/// HTTPS-only: let this host load over http for the rest of the session.
#[tauri::command]
fn allow_http(host: String) {
    privacy::allow_http(host);
}

/// Opens a host despite its certificate error for the rest of the session.
#[tauri::command]
fn allow_certificate(host: String) {
    privacy::allow_certificate(host);
}

#[tauri::command]
fn resolve_permission(app: AppHandle, request_id: u64, allow: bool, remember: bool) -> Result<(), String> {
    privacy::resolve_permission(&app, request_id, allow, remember)
}

/// Clears cookies / cache / site storage / autofill from the normal profile,
/// optionally only data stored since `since` (Unix seconds).
#[tauri::command]
async fn clear_site_data(app: AppHandle, kinds: Vec<String>, since: Option<f64>) -> Result<(), String> {
    let chrome = chrome_webview(&app)?;
    privacy::clear_data(&chrome, kinds, since).await
}

/// Clears cookies and storage for one site, from the profile of the tab `label`.
#[tauri::command]
fn clear_origin_data(app: AppHandle, label: String, origin: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview {label} was not found"))?;
    privacy::clear_origin(&webview, origin)
}

#[tauri::command]
fn cancel_download(app: AppHandle, id: String) -> Result<(), String> {
    native::cancel_download(&app, id)
}

#[tauri::command]
fn pause_download(app: AppHandle, id: String, pause: bool) -> Result<(), String> {
    native::pause_download(&app, id, pause)
}

/// "Ask where to save each file" (Settings → Downloads).
#[tauri::command]
fn set_download_ask(ask: bool) {
    native::ASK_WHERE.store(ask, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn resolve_download_check(app: AppHandle, check_id: u64, keep: bool) -> Result<(), String> {
    native::resolve_download_check(&app, check_id, keep)
}

#[tauri::command]
fn open_download_panel(app: AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "the tab this download came from is closed".to_string())?;
    page_hooks::open_download_panel(&webview)
}

#[tauri::command]
fn set_view_muted(app: AppHandle, label: String, muted: bool) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview {label} was not found"))?;
    page_hooks::set_muted(&webview, muted)
}

/// JPEG snapshot of a page, shown behind modal UI while the page is hidden.
#[tauri::command]
async fn capture_view(app: AppHandle, label: String) -> Result<tauri::ipc::Response, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview {label} was not found"))?;
    native::capture(&webview).await.map(tauri::ipc::Response::new)
}

pub(crate) fn chrome_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.webviews()
        .into_values()
        .find(|webview| {
            let label = webview.label();
            !label.starts_with(PAGE_PREFIX) && !label.starts_with(OVERLAY_PREFIX)
        })
        .ok_or_else(|| "chrome webview was not found".to_string())
}

#[tauri::command]
fn set_chrome_zoom(caller: tauri::Webview, zoom: f64) -> Result<(), String> {
    caller
        .set_zoom(zoom.clamp(0.5, 2.0))
        .map_err(|error| error.to_string())
}

/// Only paths recorded as downloads can be opened, so the chrome can't be
/// used to launch arbitrary files.
fn recorded_download(store: &store::Store, id: &str) -> Result<PathBuf, String> {
    let path = store
        .download_path(id)?
        .map(PathBuf::from)
        .ok_or_else(|| "this download has no saved file".to_string())?;
    if !path.exists() {
        return Err(format!("{} no longer exists", path.display()));
    }
    Ok(path)
}

#[tauri::command]
fn open_download(store: State<'_, store::Store>, id: String) -> Result<(), String> {
    native::open_path(&recorded_download(&store, &id)?)
}

#[tauri::command]
fn reveal_download(store: State<'_, store::Store>, id: String) -> Result<(), String> {
    native::reveal_path(&recorded_download(&store, &id)?)
}

/// Opens the configured download folder, or the system Downloads folder.
#[tauri::command]
fn open_downloads_folder(app: AppHandle, state: State<'_, DownloadDir>) -> Result<(), String> {
    let configured = state.0.lock().ok().and_then(|dir| dir.clone());
    let folder = match configured {
        Some(folder) => folder,
        None => app.path().download_dir().map_err(|error| error.to_string())?,
    };
    native::open_path(&folder)
}

/// Moves keyboard focus from a page back to the Sleet chrome webview.
#[tauri::command]
fn focus_chrome(app: AppHandle, caller: tauri::Webview) -> Result<(), String> {
    // The chrome webview carries its window's label (overlays ask on its behalf too).
    let window = caller.window();
    app.get_webview(window.label())
        .unwrap_or(caller)
        .set_focus()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_views_zoom(app: AppHandle, labels: Vec<String>, zoom: f64) -> Result<(), String> {
    let zoom = zoom.clamp(0.25, 5.0);
    for label in labels {
        if let Some(webview) = app.get_webview(&label) {
            webview.set_zoom(zoom).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn set_download_dir(state: State<'_, DownloadDir>, path: Option<String>) -> Result<(), String> {
    let folder = path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(folder) = &folder {
        if !folder.is_absolute() || !folder.is_dir() {
            return Err(format!("{} is not an existing folder", folder.display()));
        }
    }
    *state.0.lock().map_err(|error| error.to_string())? = folder;
    Ok(())
}

/// Clears cookies, storage and cache for the shared browsing profile.
#[tauri::command]
fn clear_browsing_data(app: AppHandle) -> Result<(), String> {
    let webview = app
        .webviews()
        .into_values()
        .next()
        .ok_or_else(|| "no webview is available".to_string())?;
    webview
        .clear_all_browsing_data()
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Before the rename, Sleet was "Horizon" (identifier com.horizon.reader). Its
/// data folders (database, WebView2 profile with cookies and logins) move to
/// the new identifier's folders on first launch, before anything opens them.
fn migrate_from_horizon() {
    const OLD: &str = "com.horizon.reader";
    const NEW: &str = "com.sleet.browser";
    for var in ["APPDATA", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(var).map(std::path::PathBuf::from) else { continue };
        let (old, new) = (base.join(OLD), base.join(NEW));
        if old.is_dir() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
        // The database file was called horizon.db.
        for suffix in ["", "-wal", "-shm"] {
            let (old_db, new_db) = (new.join(format!("horizon.db{suffix}")), new.join(format!("sleet.db{suffix}")));
            if old_db.is_file() && !new_db.exists() {
                let _ = std::fs::rename(&old_db, &new_db);
            }
        }
        // Stale single-instance file from the old name.
        let _ = std::fs::remove_file(new.join("instance"));
    }
}

pub fn run() {
    migrate_from_horizon();

    // A link clicked in another app while Sleet is open goes to that window.
    let launch_urls = default_browser::urls_from_args(std::env::args().skip(1));
    if default_browser::forward_to_running(&launch_urls) {
        return;
    }

    tauri::Builder::default()
        .manage(default_browser::LaunchUrls(std::sync::Mutex::new(launch_urls)))
        .runtime(tauri_runtime_wry::Wry::default())
        .manage(DownloadDir::default())
        .manage(windows::WindowStarts::default())
        .manage(windows::LastFocused::default())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Focused(true) => windows::remember_focus(window),
            tauri::WindowEvent::Destroyed => {
                let _ = window.app_handle().emit("sleet-windows-changed", ());
            }
            _ => {}
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = store::Store::open(&dir.join("sleet.db"))?;
            vault::create_tables(&store)?;
            app.manage(store);
            app.manage(vault::Vault::default());
            vault_commands::start_auto_lock(app.handle().clone());
            default_browser::listen_for_other_launches(app.handle().clone());
            browsing::init_updater(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_browser_view,
            close_browser_view,
            navigate_browser_view,
            activate_browser_view,
            resize_browser_view,
            browser_action,
            focus_chrome,
            set_views_zoom,
            set_download_dir,
            clear_browsing_data,
            capture_view,
            set_view_muted,
            open_download_panel,
            cancel_download,
            pause_download,
            set_download_ask,
            windows::open_window,
            windows::take_window_start,
            windows::move_tabs_to_window,
            windows::list_windows,
            windows::window_at,
            set_privacy_options,
            allow_http,
            allow_certificate,
            resolve_permission,
            clear_site_data,
            clear_origin_data,
            store::permissions_list,
            store::kv_all,
            store::kv_set,
            store::kv_set_many,
            store::kv_delete_prefix,
            store::kv_delete,
            vault_commands::vault_status,
            vault_commands::vault_create,
            vault_commands::vault_unlock,
            vault_commands::vault_unlock_device,
            vault_commands::vault_lock,
            vault_commands::vault_change_password,
            vault_commands::vault_set_remember,
            vault_commands::vault_set_auto_lock,
            vault_commands::vault_reset,
            vault_commands::vault_list,
            vault_commands::vault_matches,
            vault_commands::vault_add,
            vault_commands::vault_update,
            vault_commands::vault_delete,
            vault_commands::vault_reveal,
            vault_commands::vault_copy,
            vault_commands::vault_fill,
            vault_commands::vault_fill_generated,
            vault_commands::vault_generate,
            vault_commands::vault_offer_recheck,
            vault_commands::vault_resolve_offer,
            vault_commands::vault_import_csv,
            vault_commands::vault_import_backup,
            vault_commands::vault_export_backup,
            vault_commands::vault_export_csv,
            vault_commands::vault_reveal_export,
            bookmark_import::detect_bookmark_sources,
            bookmark_import::read_bookmark_source,
            default_browser::default_browser_status,
            default_browser::make_default_browser,
            default_browser::take_launch_urls,
            store::permission_set,
            store::permission_delete,
            resolve_download_check,
            step_history,
            overlay_show,
            overlay_hide,
            overlay_release,
            overlay_place,
            set_chrome_zoom,
            open_download,
            reveal_download,
            open_downloads_folder,
            store::history_add,
            store::history_list,
            store::history_clear,
            store::download_put,
            store::downloads_list,
            store::downloads_clear,
            store::import_legacy,
            store::history_delete,
            store::download_delete,
            browsing::stop_loading,
            browsing::find_in_page,
            browsing::find_clear,
            browsing::print_page,
            browsing::save_page_pdf,
            browsing::open_external,
            browsing::check_for_update,
            browsing::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sleet");
}
