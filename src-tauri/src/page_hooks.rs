//! Per-page WebView2 hooks: a browser-style context menu and audio state.
//! Other platforms keep their engine defaults.

use tauri::{AppHandle, Webview};

/// A context menu item Sleet added was chosen. `action` is one of
/// `open-tab`, `open-background-tab`, `open-image-tab`, `search-image`.
#[derive(Clone, serde::Serialize)]
pub struct ContextAction {
    pub label: String,
    pub action: &'static str,
    pub url: String,
}

/// The page's icon as a PNG data URL (`None` when the page has none).
#[derive(Clone, serde::Serialize)]
pub struct FaviconChange {
    pub label: String,
    pub icon: Option<String>,
}

/// The page's address changed, including same-document (pushState) changes.
#[derive(Clone, serde::Serialize)]
pub struct UrlChange {
    pub label: String,
    pub url: String,
}

#[derive(Clone, serde::Serialize)]
pub struct AudioState {
    pub label: String,
    pub playing: bool,
    pub muted: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{AudioState, ContextAction, FaviconChange, UrlChange};
    use base64::Engine;
    use std::{sync::mpsc, time::Duration};
    use tauri::{AppHandle, Emitter, Manager, Webview};
    use webview2_com::{
        take_pwstr, ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler,
        IsDocumentPlayingAudioChangedEventHandler, IsMutedChangedEventHandler,
        SourceChangedEventHandler, FaviconChangedEventHandler, GetFaviconCompletedHandler,
        WebMessageReceivedEventHandler, ProcessFailedEventHandler, HistoryChangedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            ICoreWebView2, ICoreWebView2ContextMenuItem, ICoreWebView2ContextMenuItemCollection,
            ICoreWebView2Environment9, ICoreWebView2_11, ICoreWebView2_15, ICoreWebView2_8, ICoreWebView2_9,
            ICoreWebView2Settings4, ICoreWebView2_19, ICoreWebView2_13, ICoreWebView2Profile6,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
            COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        },
    };
    use windows::Win32::{
        Foundation::{E_FAIL, HWND},
        System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET},
        UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE},
    };
    use windows_core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};

    fn parts(
        platform: &tauri::webview::PlatformWebview,
    ) -> windows_core::Result<(ICoreWebView2, ICoreWebView2Environment9)> {
        let webview = platform
            .downcast_ref::<tauri_runtime_wry::Webview>()
            .ok_or_else(|| windows_core::Error::from(E_FAIL))?;
        let core = unsafe { webview.controller().CoreWebView2()? };
        Ok((core, webview.environment().cast()?))
    }

    unsafe fn read_stream(stream: &IStream) -> windows_core::Result<Vec<u8>> {
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME)?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let mut buffer = vec![0u8; stat.cbSize as usize];
        let mut read = 0u32;
        stream.Read(buffer.as_mut_ptr().cast(), buffer.len() as u32, Some(&mut read)).ok()?;
        buffer.truncate(read as usize);
        Ok(buffer)
    }

    fn item_name(item: &ICoreWebView2ContextMenuItem) -> String {
        let mut name = PWSTR::null();
        if unsafe { item.Name(&mut name) }.is_ok() {
            take_pwstr(name)
        } else {
            String::new()
        }
    }

    fn index_of(items: &ICoreWebView2ContextMenuItemCollection, wanted: &str) -> Option<u32> {
        let mut count = 0u32;
        unsafe { items.Count(&mut count) }.ok()?;
        (0..count).find(|&index| {
            unsafe { items.GetValueAtIndex(index) }
                .map(|item| item_name(&item) == wanted)
                .unwrap_or(false)
        })
    }

    fn remove(items: &ICoreWebView2ContextMenuItemCollection, name: &str) -> Option<u32> {
        let index = index_of(items, name)?;
        unsafe { items.RemoveValueAtIndex(index) }.ok()?;
        Some(index)
    }

    fn make_item(
        environment: &ICoreWebView2Environment9,
        label: &str,
        kind: COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND,
    ) -> windows_core::Result<ICoreWebView2ContextMenuItem> {
        let label = HSTRING::from(label);
        unsafe { environment.CreateContextMenuItem(PCWSTR(label.as_ptr()), None::<&IStream>, kind) }
    }

    /// Inserts a command at `index` that emits `sleet-context` when chosen.
    fn insert_command(
        items: &ICoreWebView2ContextMenuItemCollection,
        environment: &ICoreWebView2Environment9,
        index: u32,
        text: &str,
        action: &'static str,
        url: &str,
        app: &AppHandle,
        label: &str,
    ) -> windows_core::Result<()> {
        let item = make_item(environment, text, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND)?;
        let payload = ContextAction { label: label.to_string(), action, url: url.to_string() };
        let app = app.clone();
        let mut token = 0i64;
        unsafe {
            item.add_CustomItemSelected(
                &CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                    let _ = app.emit("sleet-context", payload.clone());
                    Ok(())
                })),
                &mut token,
            )?;
            items.InsertValueAtIndex(index, &item)
        }
    }

    fn insert_separator(
        items: &ICoreWebView2ContextMenuItemCollection,
        environment: &ICoreWebView2Environment9,
        index: u32,
    ) -> windows_core::Result<()> {
        let item = make_item(environment, "", COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)?;
        unsafe { items.InsertValueAtIndex(index, &item) }
    }

    fn read_uri(read: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> Option<String> {
        let mut value = PWSTR::null();
        read(&mut value).ok()?;
        let text = take_pwstr(value);
        (!text.is_empty()).then_some(text)
    }

    fn emit_audio(app: &AppHandle, label: &str, core: &ICoreWebView2_8) {
        let (mut playing, mut muted) = (BOOL::default(), BOOL::default());
        unsafe {
            let _ = core.IsDocumentPlayingAudio(&mut playing);
            let _ = core.IsMuted(&mut muted);
        }
        let _ = app.emit(
            "sleet-audio",
            AudioState { label: label.to_string(), playing: playing.as_bool(), muted: muted.as_bool() },
        );
    }

    pub fn attach(webview: &Webview, app: AppHandle, label: String) {
        let _ = webview.with_webview(move |platform| {
            let _ = (|| -> windows_core::Result<()> {
                let (core, environment) = parts(&platform)?;

                // Context menu: browser-style link and image items.
                let menu_core: ICoreWebView2_11 = core.cast()?;
                let menu_app = app.clone();
                let menu_label = label.clone();
                let mut token = 0i64;
                let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let items = unsafe { args.MenuItems()? };
                    let target = unsafe { args.ContextMenuTarget()? };
                    let (mut has_link, mut has_source) = (BOOL::default(), BOOL::default());
                    unsafe {
                        target.HasLinkUri(&mut has_link)?;
                        target.HasSourceUri(&mut has_source)?;
                    }
                    for noisy in ["share", "webCapture", "openLinkInNewWindow"] {
                        let _ = remove(&items, noisy);
                    }

                    if has_source.as_bool() {
                        if let Some(source) = read_uri(|value| unsafe { target.SourceUri(value) }) {
                            if let Some(save) = index_of(&items, "saveImageAs") {
                                insert_command(&items, &environment, save, "Open &image in new tab", "open-image-tab", &source, &menu_app, &menu_label)?;
                            }
                            if let Some(copy) = index_of(&items, "copyImageLocation") {
                                insert_command(&items, &environment, copy + 1, "&Search the web for this image", "search-image", &source, &menu_app, &menu_label)?;
                            }
                        }
                    }

                    if has_link.as_bool() {
                        if let Some(link) = read_uri(|value| unsafe { target.LinkUri(value) }) {
                            insert_separator(&items, &environment, 0)?;
                            insert_command(&items, &environment, 0, "Open link in &background tab", "open-background-tab", &link, &menu_app, &menu_label)?;
                            insert_command(&items, &environment, 0, "Open link in new &tab", "open-tab", &link, &menu_app, &menu_label)?;
                        }
                    }
                    Ok(())
                }));
                unsafe { menu_core.add_ContextMenuRequested(&handler, &mut token)? };

                // Address changes, including pushState navigations (YouTube, etc.).
                let url_app = app.clone();
                let url_label = label.clone();
                let mut url_token = 0i64;
                let url_handler = SourceChangedEventHandler::create(Box::new(move |sender, _| {
                    let Some(sender) = sender else { return Ok(()) };
                    let mut source = PWSTR::null();
                    unsafe { sender.Source(&mut source)? };
                    let url = take_pwstr(source);
                    if url.starts_with("http") {
                        let _ = url_app.emit("sleet-url", UrlChange { label: url_label.clone(), url });
                    }
                    Ok(())
                }));
                unsafe { core.add_SourceChanged(&url_handler, &mut url_token)? };

                // Whether the page's own history can go back/forward (greys out the buttons).
                let history_app = app.clone();
                let history_label = label.clone();
                let mut history_token = 0i64;
                let history_handler = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                    let Some(sender) = sender else { return Ok(()) };
                    let (mut back, mut forward) = (BOOL::default(), BOOL::default());
                    unsafe {
                        sender.CanGoBack(&mut back)?;
                        sender.CanGoForward(&mut forward)?;
                    }
                    let _ = history_app.emit("sleet-history", serde_json::json!({ "label": history_label, "back": back.as_bool(), "forward": forward.as_bool() }));
                    Ok(())
                }));
                unsafe { core.add_HistoryChanged(&history_handler, &mut history_token)? };

                // Focus moved into this page (a click in a docked pane makes it the active tab).
                if let Some(wry_webview) = platform.downcast_ref::<tauri_runtime_wry::Webview>() {
                    let focus_app = app.clone();
                    let focus_label = label.clone();
                    let mut focus_token = 0i64;
                    let focus_handler = webview2_com::FocusChangedEventHandler::create(Box::new(move |_, _| {
                        let _ = focus_app.emit("sleet-page-focus", serde_json::json!({ "label": focus_label }));
                        Ok(())
                    }));
                    unsafe { wry_webview.controller().add_GotFocus(&focus_handler, &mut focus_token)? };
                }

                // Favicon: sent as a PNG data URL, so the chrome never fetches it itself.
                if let Ok(icons) = core.cast::<ICoreWebView2_15>() {
                    let icon_app = app.clone();
                    let icon_label = label.clone();
                    let mut icon_token = 0i64;
                    let handler = FaviconChangedEventHandler::create(Box::new(move |sender, _| {
                        let Some(sender) = sender else { return Ok(()) };
                        let Ok(sender) = sender.cast::<ICoreWebView2_15>() else { return Ok(()) };
                        let app = icon_app.clone();
                        let label = icon_label.clone();
                        let done = GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
                            // A large icon already found for this site wins over the engine's 16px one.
                            let sharp = app.get_webview(&label)
                                .and_then(|webview| webview.url().ok())
                                .and_then(|url| crate::vault::origin_of(url.as_str()))
                                .and_then(|origin| crate::favicons::cached(&origin));
                            let icon = sharp.or_else(|| result.ok().and(stream).and_then(|stream| unsafe { read_stream(&stream) }.ok())
                                .filter(|bytes| !bytes.is_empty())
                                .map(|bytes| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))));
                            let _ = app.emit("sleet-favicon", FaviconChange { label, icon });
                            Ok(())
                        }));
                        unsafe { sender.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &done)? };
                        Ok(())
                    }));
                    unsafe { icons.add_FaviconChanged(&handler, &mut icon_token)? };
                }

                // The page's renderer crashed or hung: Sleet shows a "page crashed" screen.
                let crash_app = app.clone();
                let crash_label = label.clone();
                let mut crash_token = 0i64;
                let crash = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    unsafe { args.ProcessFailedKind(&mut kind)? };
                    let kind = match kind {
                        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "crashed",
                        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "unresponsive",
                        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "engine",
                        _ => return Ok(()), // GPU, utility and subframe processes recover on their own.
                    };
                    let _ = crash_app.emit("sleet-page-crashed", serde_json::json!({ "label": crash_label, "kind": kind }));
                    Ok(())
                }));
                unsafe { core.add_ProcessFailed(&crash, &mut crash_token)? };

                // Passwords: Sleet's vault replaces WebView2's own password saving,
                // and login messages from the page script go to password_bridge.
                // Off for the whole profile too: a per-page setting only applies
                // from that page's next navigation, so a login on a tab's first page
                // still got WebView2's prompt. General autofill is off as well, since
                // its suggestion list (usernames typed before) opened on top of Sleet's.
                if let Ok(profile) = core.cast::<ICoreWebView2_13>().and_then(|core| unsafe { core.Profile() }).and_then(|profile| profile.cast::<ICoreWebView2Profile6>()) {
                    let _ = unsafe { profile.SetIsPasswordAutosaveEnabled(false) };
                    let _ = unsafe { profile.SetIsGeneralAutofillEnabled(false) };
                }
                if let Ok(settings) = unsafe { core.Settings() }.and_then(|settings| settings.cast::<ICoreWebView2Settings4>()) {
                    let _ = unsafe { settings.SetIsPasswordAutosaveEnabled(false) };
                    let _ = unsafe { settings.SetIsGeneralAutofillEnabled(false) };
                }
                let bridge_app = app.clone();
                let bridge_label = label.clone();
                let mut bridge_token = 0i64;
                let bridge = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    // The engine reports the sender's real address; the page can't spoof it.
                    let Some(source) = read_uri(|value| unsafe { args.Source(value) }) else { return Ok(()) };
                    let Some(origin) = crate::vault::origin_of(&source) else { return Ok(()) };
                    let mut raw = PWSTR::null();
                    if unsafe { args.TryGetWebMessageAsString(&mut raw) }.is_err() {
                        return Ok(());
                    }
                    let text = zeroize::Zeroizing::new(take_pwstr(raw));
                    if text.starts_with("{\"sleet\"") {
                        crate::password_bridge::handle(&bridge_app, &bridge_label, &origin, &text);
                    }
                    Ok(())
                }));
                unsafe { core.add_WebMessageReceived(&bridge, &mut bridge_token)? };

                // Audio: report playing/muted changes so the tab can show a speaker.
                let audio_core: ICoreWebView2_8 = core.cast()?;
                for kind in 0..2 {
                    let app = app.clone();
                    let label = label.clone();
                    let core = audio_core.clone();
                    let mut token = 0i64;
                    if kind == 0 {
                        let handler = IsDocumentPlayingAudioChangedEventHandler::create(Box::new(move |_, _| {
                            emit_audio(&app, &label, &core);
                            Ok(())
                        }));
                        unsafe { audio_core.add_IsDocumentPlayingAudioChanged(&handler, &mut token)? };
                    } else {
                        let handler = IsMutedChangedEventHandler::create(Box::new(move |_, _| {
                            emit_audio(&app, &label, &core);
                            Ok(())
                        }));
                        unsafe { audio_core.add_IsMutedChanged(&handler, &mut token)? };
                    }
                }
                Ok(())
            })();
        });
    }

    /// Goes back or forward in the page's own history. Resolves to `false`
    /// when there is nowhere to go, so Sleet can use its saved history.
    pub async fn step_history(webview: &Webview, back: bool) -> Result<bool, String> {
        let (tx, rx) = mpsc::channel::<bool>();
        webview
            .with_webview(move |platform| {
                let moved = parts(&platform).and_then(|(core, _)| unsafe {
                    let mut can = BOOL::default();
                    if back { core.CanGoBack(&mut can)?; } else { core.CanGoForward(&mut can)?; }
                    if !can.as_bool() {
                        return Ok(false);
                    }
                    if back { core.GoBack()?; } else { core.GoForward()?; }
                    Ok(true)
                });
                let _ = tx.send(moved.unwrap_or(false));
            })
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)).unwrap_or(false))
            .await
            .map_err(|error| error.to_string())
    }

    /// Moves a webview's host window above its siblings (other pages), so
    /// overlays draw on top of page content.
    pub fn raise(webview: &Webview) {
        let _ = webview.with_webview(|platform| {
            let Some(inner) = platform.downcast_ref::<tauri_runtime_wry::Webview>() else { return };
            let mut host = HWND::default();
            if unsafe { inner.controller().ParentWindow(&mut host) }.is_ok() && !host.is_invalid() {
                let _ = unsafe { SetWindowPos(host, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
            }
        });
    }

    /// Opens WebView2's built-in download panel. Wry hides it for every
    /// download, but SmartScreen asks for "Keep" there, so installers can sit
    /// at 100% until it is shown.
    pub fn open_download_panel(webview: &Webview) -> Result<(), String> {
        webview
            .with_webview(|platform| {
                let _ = parts(&platform)
                    .and_then(|(core, _)| core.cast::<ICoreWebView2_9>())
                    .and_then(|core| unsafe { core.OpenDefaultDownloadDialog() });
            })
            .map_err(|error| error.to_string())
    }

    /// Background tabs ask the engine to use less memory (it trims caches and
    /// may compress or page out memory); the tab in front goes back to normal.
    pub fn set_low_memory(webview: &Webview, low: bool) {
        let _ = webview.with_webview(move |platform| {
            let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
            let _ = parts(&platform)
                .and_then(|(core, _)| core.cast::<ICoreWebView2_19>())
                .and_then(|core| unsafe { core.SetMemoryUsageTargetLevel(level) });
        });
    }

    pub fn set_muted(webview: &Webview, muted: bool) -> Result<(), String> {
        webview
            .with_webview(move |platform| {
                let _ = parts(&platform)
                    .and_then(|(core, _)| core.cast::<ICoreWebView2_8>())
                    .and_then(|core| unsafe { core.SetIsMuted(muted) });
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use tauri::{AppHandle, Webview};

    pub fn attach(_webview: &Webview, _app: AppHandle, _label: String) {}

    pub fn set_muted(_webview: &Webview, _muted: bool) -> Result<(), String> {
        Err("muting tabs is not supported on this platform".into())
    }

    pub async fn step_history(webview: &Webview, back: bool) -> Result<bool, String> {
        let result = if back { webview.go_back() } else { webview.go_forward() };
        Ok(result.is_ok())
    }

    pub fn raise(_webview: &Webview) {}

    pub fn set_low_memory(_webview: &Webview, _low: bool) {}

    pub fn open_download_panel(_webview: &Webview) -> Result<(), String> {
        Err("the download panel is only available on Windows".into())
    }
}

pub fn attach(webview: &Webview, app: AppHandle, label: String) {
    imp::attach(webview, app, label)
}

pub fn set_muted(webview: &Webview, muted: bool) -> Result<(), String> {
    imp::set_muted(webview, muted)
}

pub async fn step_history(webview: &Webview, back: bool) -> Result<bool, String> {
    imp::step_history(webview, back).await
}

pub fn raise(webview: &Webview) {
    imp::raise(webview)
}

pub fn set_low_memory(webview: &Webview, low: bool) {
    imp::set_low_memory(webview, low)
}

pub fn open_download_panel(webview: &Webview) -> Result<(), String> {
    imp::open_download_panel(webview)
}
