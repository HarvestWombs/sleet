//! More than one Sleet window. Every window runs its own copy of the Sleet
//! chrome (its webview carries the window's label) with its own tabs; page
//! webviews belong to the window whose chrome created them and can move to
//! another window with their page intact.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewWindowBuilder, Window};

/// Prefix for windows after the first ("main").
pub const WINDOW_PREFIX: &str = "window-";
const PAGE_PREFIX: &str = "page-";

/// What a new window opens with (its tabs, as the chrome's JSON), waiting
/// until that window's chrome asks for it.
#[derive(Default)]
pub struct WindowStarts(Mutex<HashMap<String, String>>);

/// The window used last, for links opened from other apps.
#[derive(Default)]
pub struct LastFocused(Mutex<Option<String>>);

pub fn remember_focus(window: &Window) {
    if let Some(state) = window.try_state::<LastFocused>() {
        if let Ok(mut last) = state.0.lock() {
            *last = Some(window.label().to_string());
        }
    }
}

/// The window used last that is still open, else any window.
pub fn focused_window(app: &AppHandle) -> Option<Window> {
    let last = app.state::<LastFocused>().0.lock().ok().and_then(|last| last.clone());
    last.and_then(|label| app.get_window(&label))
        .or_else(|| app.get_window("main"))
        .or_else(|| app.windows().into_values().next())
}

fn valid_label(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX)
        && label.len() <= 40
        && label[WINDOW_PREFIX.len()..].chars().all(|c| c.is_ascii_alphanumeric())
}

fn new_label() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    format!("{WINDOW_PREFIX}{:x}", nanos & 0xffff_ffff_ffff)
}

/// Moves page webviews into `window`, hidden until its chrome shows them.
fn move_pages(app: &AppHandle, window: &Window, pages: &[String]) -> Result<(), String> {
    for label in pages.iter().filter(|label| label.starts_with(PAGE_PREFIX)) {
        if let Some(webview) = app.get_webview(label) {
            let _ = webview.hide();
            webview.reparent(window).map_err(|error| error.to_string())?;
        }
    }
    // The moved pages now stack on top; overlays must stay above them.
    crate::raise_overlays(app);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWindowRequest {
    /// Reopen a window saved last time under this label.
    label: Option<String>,
    /// Tabs for the new window (the chrome's own JSON).
    start: Option<String>,
    /// Page webviews moving into the new window with their tabs.
    #[serde(default)]
    move_pages: Vec<String>,
    /// Top-left corner on screen in physical pixels, e.g. where a tab was dropped.
    position: Option<(f64, f64)>,
}

/// Opens another Sleet window, the same size as the one asking, a little
/// down and to the right of it (or where a dragged tab was dropped).
#[tauri::command]
pub async fn open_window(app: AppHandle, caller: Webview, request: OpenWindowRequest) -> Result<String, String> {
    let label = request.label.filter(|label| valid_label(label)).unwrap_or_else(new_label);
    if let Some(existing) = app.get_window(&label) {
        let _ = existing.set_focus();
        return Ok(label);
    }
    if let Some(start) = request.start {
        app.state::<WindowStarts>().0.lock().map_err(|error| error.to_string())?.insert(label.clone(), start);
    }

    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "the window settings are missing".to_string())?;
    config.label = label.clone();
    config.center = false;

    let source = caller.window();
    let scale = source.scale_factor().unwrap_or(1.0);
    let origin = source.outer_position().map(|p| p.to_logical::<f64>(scale)).unwrap_or(LogicalPosition::new(80.0, 80.0));
    let size = source.inner_size().map(|s| s.to_logical::<f64>(scale)).unwrap_or(LogicalSize::new(config.width, config.height));
    let (x, y) = request
        .position
        .map(|(x, y)| (x / scale, y / scale))
        .unwrap_or((origin.x + 32.0, origin.y + 32.0));

    let window = WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|error| error.to_string())?
        .position(x, y)
        .inner_size(size.width, size.height)
        .focused(true)
        .build()
        .map_err(|error| error.to_string())?;
    move_pages(&app, &window.as_ref().window(), &request.move_pages)?;
    let _ = app.emit("sleet-windows-changed", ());
    Ok(label)
}

/// The tabs a new window was opened with (asked once, by its chrome).
#[tauri::command]
pub fn take_window_start(app: AppHandle, caller: Webview) -> Option<String> {
    app.state::<WindowStarts>().0.lock().ok()?.remove(caller.window().label())
}

/// Moves tabs (and their pages) into another open window.
#[tauri::command]
pub fn move_tabs_to_window(app: AppHandle, window: String, tabs: String, pages: Vec<String>) -> Result<(), String> {
    let target = app.get_window(&window).ok_or_else(|| "that window was closed".to_string())?;
    move_pages(&app, &target, &pages)?;
    let _ = app.emit("sleet-adopt-tabs", serde_json::json!({ "window": window, "tabs": tabs }));
    let _ = target.unminimize();
    let _ = target.set_focus();
    Ok(())
}

#[derive(Serialize)]
pub struct WindowInfo {
    label: String,
    title: String,
}

/// Open Sleet windows, for "Move to window".
#[tauri::command]
pub fn list_windows(app: AppHandle) -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = app
        .windows()
        .into_values()
        .filter(|window| window.label() == "main" || window.label().starts_with(WINDOW_PREFIX))
        .map(|window| WindowInfo { label: window.label().to_string(), title: window.title().unwrap_or_default() })
        .collect();
    windows.sort_by(|a, b| (a.label != "main", &a.label).cmp(&(b.label != "main", &b.label)));
    windows
}

/// The other Sleet window under a screen point (physical pixels), where a
/// dragged tab was dropped. `None` means empty space: open a new window.
#[tauri::command]
pub fn window_at(app: AppHandle, caller: Webview, x: f64, y: f64) -> Option<String> {
    let own = caller.window();
    app.windows()
        .into_values()
        .filter(|window| window.label() != own.label() && (window.label() == "main" || window.label().starts_with(WINDOW_PREFIX)))
        .filter(|window| window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false))
        .find(|window| {
            let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else { return false };
            x >= position.x as f64 && y >= position.y as f64 && x < position.x as f64 + size.width as f64 && y < position.y as f64 + size.height as f64
        })
        .map(|window| window.label().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_labels() {
        assert!(valid_label("window-1a2b"));
        assert!(!valid_label("main"));
        assert!(!valid_label("window-../x"));
        assert!(!valid_label("page-123"));
        assert!(valid_label(&new_label()));
    }
}
