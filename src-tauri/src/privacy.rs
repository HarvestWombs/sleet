//! Security and privacy hooks for page webviews: popup blocking, site
//! permissions, certificate errors, HTTPS-only upgrades, tracking prevention
//! and clearing browsing data. WebView2-only; other platforms keep defaults.

use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Webview};
use url::Url;

static HTTPS_ONLY: AtomicBool = AtomicBool::new(false);
static BLOCK_POPUPS: AtomicBool = AtomicBool::new(true);
/// 0 none, 1 basic, 2 balanced, 3 strict.
static TRACKING_LEVEL: AtomicU8 = AtomicU8::new(2);
/// Hosts the user chose to load over plain http this session (HTTPS-only).
static HTTP_ALLOWED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// https:// addresses Sleet upgraded from http, to spot failed upgrades.
static UPGRADED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Hosts the user chose to open despite a certificate error this session.
static CERT_ALLOWED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Labels of private (InPrivate) page webviews.
static PRIVATE: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with_set<T>(set: &Mutex<Option<HashSet<String>>>, run: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut guard = set.lock().unwrap_or_else(|poison| poison.into_inner());
    run(guard.get_or_insert_with(HashSet::new))
}

pub fn mark_private(label: &str) {
    with_set(&PRIVATE, |set| set.insert(label.to_string()));
}

pub fn forget_view(label: &str) {
    with_set(&PRIVATE, |set| set.remove(label));
}

pub fn is_private(label: &str) -> bool {
    with_set(&PRIVATE, |set| set.contains(label))
}

fn is_local(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost")
}

/// `scheme://host[:port]` for a page address.
pub fn origin_of(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    })
}

/// HTTPS-only: the https address to load instead of `url`, if any.
pub fn https_upgrade(url: &Url) -> Option<Url> {
    if url.scheme() != "http" || !HTTPS_ONLY.load(Ordering::Relaxed) {
        return None;
    }
    let host = url.host_str()?.to_string();
    if is_local(&host) || with_set(&HTTP_ALLOWED, |set| set.contains(&host)) {
        return None;
    }
    let mut secure = url.clone();
    secure.set_scheme("https").ok()?;
    with_set(&UPGRADED, |set| set.insert(secure.to_string()));
    Some(secure)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyOptions {
    pub https_only: bool,
    pub block_popups: bool,
    /// `none`, `basic`, `balanced` or `strict`.
    pub tracking_prevention: String,
}

pub fn set_options(options: &PrivacyOptions) {
    HTTPS_ONLY.store(options.https_only, Ordering::Relaxed);
    BLOCK_POPUPS.store(options.block_popups, Ordering::Relaxed);
    let level = match options.tracking_prevention.as_str() {
        "none" => 0,
        "basic" => 1,
        "strict" => 3,
        _ => 2,
    };
    TRACKING_LEVEL.store(level, Ordering::Relaxed);
}

pub fn allow_http(host: String) {
    with_set(&HTTP_ALLOWED, |set| set.insert(host));
}

pub fn allow_certificate(host: String) {
    with_set(&CERT_ALLOWED, |set| set.insert(host));
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: u64,
    pub label: String,
    pub origin: String,
    pub kind: &'static str,
    pub private: bool,
}

#[derive(Clone, Serialize)]
pub struct PopupBlocked {
    pub label: String,
    pub url: String,
    pub origin: String,
}

#[derive(Clone, Serialize)]
pub struct CertificateError {
    pub label: String,
    pub url: String,
    pub host: String,
    pub problem: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpsFailed {
    pub label: String,
    pub http_url: String,
    pub host: String,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use crate::store::Store;
    use std::{
        cell::RefCell,
        collections::HashMap,
        sync::{atomic::AtomicU64, mpsc},
        time::Duration,
    };
    use tauri::{Emitter, Manager};
    use webview2_com::{
        take_pwstr, CallDevToolsProtocolMethodCompletedHandler, ClearBrowsingDataCompletedHandler,
        GetNonDefaultPermissionSettingsCompletedHandler, SetPermissionStateCompletedHandler,
        Microsoft::Web::WebView2::Win32::*, NavigationCompletedEventHandler,
        NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
        ServerCertificateErrorDetectedEventHandler,
    };
    use windows::Win32::Foundation::E_FAIL;
    use windows_core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR};

    thread_local! {
        static REQUESTS: RefCell<HashMap<u64, (ICoreWebView2PermissionRequestedEventArgs, ICoreWebView2Deferral, String, &'static str, bool)>> = RefCell::new(HashMap::new());
    }
    static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
    /// WebView2's own saved answers are wiped once per launch (Sleet keeps the real list).
    static ENGINE_PERMISSIONS_RESET: std::sync::Once = std::sync::Once::new();

    fn core_of(platform: &tauri::webview::PlatformWebview) -> windows_core::Result<ICoreWebView2> {
        let webview = platform
            .downcast_ref::<tauri_runtime_wry::Webview>()
            .ok_or_else(|| windows_core::Error::from(E_FAIL))?;
        unsafe { webview.controller().CoreWebView2() }
    }

    fn pwstr(read: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>) -> String {
        let mut value = PWSTR::null();
        if read(&mut value).is_ok() { take_pwstr(value) } else { String::new() }
    }

    fn kind_name(kind: COREWEBVIEW2_PERMISSION_KIND) -> &'static str {
        match kind {
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "microphone",
            COREWEBVIEW2_PERMISSION_KIND_CAMERA => "camera",
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "location",
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "notifications",
            COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS => "sensors",
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "clipboard",
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS => "downloads",
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE => "files",
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY => "autoplay",
            COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS => "fonts",
            COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => "midi",
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT => "windows",
            _ => "other",
        }
    }

    fn certificate_problem(status: COREWEBVIEW2_WEB_ERROR_STATUS) -> &'static str {
        match status {
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED => "The site's certificate has expired",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT => "The certificate is for a different site",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => "The site's certificate was revoked",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID => "The site's certificate isn't trusted",
            _ => "There's a problem with the site's certificate",
        }
    }

    fn tracking_level() -> COREWEBVIEW2_TRACKING_PREVENTION_LEVEL {
        match TRACKING_LEVEL.load(Ordering::Relaxed) {
            0 => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
            1 => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BASIC,
            3 => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_STRICT,
            _ => COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BALANCED,
        }
    }

    fn profile_of(core: &ICoreWebView2) -> windows_core::Result<ICoreWebView2Profile> {
        unsafe { core.cast::<ICoreWebView2_13>()?.Profile() }
    }

    fn apply_tracking(core: &ICoreWebView2) {
        if let Ok(profile) = profile_of(core).and_then(|profile| profile.cast::<ICoreWebView2Profile3>()) {
            let _ = unsafe { profile.SetPreferredTrackingPreventionLevel(tracking_level()) };
        }
    }

    fn stored_permission(app: &AppHandle, origin: &str, kind: &str) -> Option<String> {
        app.try_state::<Store>()?.permission(origin, kind).ok().flatten()
    }

    pub fn attach(webview: &Webview, app: AppHandle, label: String) {
        let _ = webview.with_webview(move |platform| {
            let _ = (|| -> windows_core::Result<()> {
                let core = core_of(&platform)?;
                apply_tracking(&core);
                let private = is_private(&label);
                if !private {
                    ENGINE_PERMISSIONS_RESET.call_once(|| reset_engine_permissions(&core, None));
                }

                // Popups: only ones the user clicked for (or allowed per site) open a tab.
                let popup_app = app.clone();
                let popup_label = label.clone();
                let mut token = 0i64;
                let popups = NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let url = pwstr(|value| unsafe { args.Uri(value) });
                    let mut user = BOOL::default();
                    unsafe { args.IsUserInitiated(&mut user)? };
                    let opener = sender.map(|sender| pwstr(|value| unsafe { sender.Source(value) })).unwrap_or_default();
                    let origin = super::origin_of(&opener).unwrap_or_default();
                    let allowed_site = !private && stored_permission(&popup_app, &origin, "popups").as_deref() == Some("allow");
                    if user.as_bool() || allowed_site || !BLOCK_POPUPS.load(Ordering::Relaxed) {
                        let _ = popup_app.emit("sleet-new-tab", url);
                    } else {
                        let _ = popup_app.emit("sleet-popup-blocked", PopupBlocked { label: popup_label.clone(), url, origin });
                    }
                    Ok(())
                }));
                unsafe { core.add_NewWindowRequested(&popups, &mut token)? };

                // Site permissions: remembered answers apply silently; otherwise ask.
                let permission_app = app.clone();
                let permission_label = label.clone();
                let mut token = 0i64;
                let permissions = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    // Sleet's site permissions are the only saved answers;
                    // WebView2 keeping its own copy is what made "Forget" not work.
                    if let Ok(args3) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                        let _ = unsafe { args3.SetSavesInProfile(false) };
                    }
                    let uri = pwstr(|value| unsafe { args.Uri(value) });
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                    unsafe { args.PermissionKind(&mut kind)? };
                    let kind = kind_name(kind);
                    let origin = super::origin_of(&uri).unwrap_or(uri);
                    if !private {
                        match stored_permission(&permission_app, &origin, kind).as_deref() {
                            Some("allow") => return unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) },
                            Some("block") => return unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY) },
                            _ => {}
                        }
                    }
                    let deferral = unsafe { args.GetDeferral()? };
                    let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
                    REQUESTS.with(|requests| requests.borrow_mut().insert(request_id, (args.clone(), deferral, origin.clone(), kind, private)));
                    let _ = permission_app.emit("sleet-permission-request", PermissionRequest {
                        request_id,
                        label: permission_label.clone(),
                        origin,
                        kind,
                        private,
                    });
                    Ok(())
                }));
                unsafe { core.add_PermissionRequested(&permissions, &mut token)? };

                // Certificate errors: report them; proceed only for hosts the user allowed.
                if let Ok(certificates) = core.cast::<ICoreWebView2_14>() {
                    let cert_app = app.clone();
                    let cert_label = label.clone();
                    let mut token = 0i64;
                    let handler = ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let url = pwstr(|value| unsafe { args.RequestUri(value) });
                        let host = Url::parse(&url).ok().and_then(|parsed| parsed.host_str().map(str::to_string)).unwrap_or_default();
                        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                        unsafe { args.ErrorStatus(&mut status)? };
                        let allowed = with_set(&CERT_ALLOWED, |set| set.contains(&host));
                        unsafe {
                            args.SetAction(if allowed {
                                COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW
                            } else {
                                COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_DEFAULT
                            })?;
                        }
                        let _ = cert_app.emit("sleet-cert-error", CertificateError {
                            label: cert_label.clone(),
                            url,
                            host,
                            problem: certificate_problem(status),
                        });
                        Ok(())
                    }));
                    unsafe { certificates.add_ServerCertificateErrorDetected(&handler, &mut token)? };
                }

                // HTTPS-only: when an upgraded address fails, offer plain http.
                let nav_app = app.clone();
                let nav_label = label.clone();
                let mut token = 0i64;
                let completed = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                    let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
                    let url = pwstr(|value| unsafe { sender.Source(value) });
                    let was_upgraded = with_set(&UPGRADED, |set| set.remove(&url));
                    if !was_upgraded {
                        return Ok(());
                    }
                    let mut success = BOOL::default();
                    unsafe { args.IsSuccess(&mut success)? };
                    if success.as_bool() {
                        return Ok(());
                    }
                    if let Ok(mut http) = Url::parse(&url) {
                        let host = http.host_str().unwrap_or_default().to_string();
                        let _ = http.set_scheme("http");
                        let _ = nav_app.emit("sleet-https-failed", HttpsFailed { label: nav_label.clone(), http_url: http.to_string(), host });
                    }
                    Ok(())
                }));
                unsafe { core.add_NavigationCompleted(&completed, &mut token)? };
                Ok(())
            })();
        });
    }

    /// Answers a permission prompt; `remember` saves it for the site (never for private tabs).
    pub fn resolve_permission(app: &AppHandle, request_id: u64, allow: bool, remember: bool) -> Result<(), String> {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let Some((args, deferral, origin, kind, private)) = REQUESTS.with(|requests| requests.borrow_mut().remove(&request_id)) else { return };
            unsafe {
                let _ = args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY });
                let _ = deferral.Complete();
            }
            if remember && !private {
                if let Some(store) = handle.try_state::<Store>() {
                    let _ = store.set_permission(&origin, kind, if allow { "allow" } else { "block" });
                }
            }
        })
        .map_err(|error| error.to_string())
    }

    /// Resets permission answers WebView2 saved in the profile: all of them, or
    /// only one site's (and optionally one kind) when Sleet forgets an answer.
    fn reset_engine_permissions(core: &ICoreWebView2, only: Option<(String, Option<String>)>) {
        let Ok(profile) = profile_of(core).and_then(|profile| profile.cast::<ICoreWebView2Profile4>()) else { return };
        let target = profile.clone();
        let handler = GetNonDefaultPermissionSettingsCompletedHandler::create(Box::new(move |result, settings| {
            let Some(settings) = result.ok().and(settings) else { return Ok(()) };
            let mut count = 0u32;
            unsafe { settings.Count(&mut count)? };
            for index in 0..count {
                let Ok(setting) = (unsafe { settings.GetValueAtIndex(index) }) else { continue };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                let _ = unsafe { setting.PermissionKind(&mut kind) };
                let origin = pwstr(|value| unsafe { setting.PermissionOrigin(value) });
                if let Some((want_origin, want_kind)) = &only {
                    let same_origin = origin.trim_end_matches('/') == want_origin.trim_end_matches('/');
                    let same_kind = want_kind.as_deref().map_or(true, |name| name == kind_name(kind));
                    if !same_origin || !same_kind {
                        continue;
                    }
                }
                let origin_text = HSTRING::from(origin.as_str());
                let done = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
                let _ = unsafe { target.SetPermissionState(kind, PCWSTR(origin_text.as_ptr()), COREWEBVIEW2_PERMISSION_STATE_DEFAULT, &done) };
            }
            Ok(())
        }));
        let _ = unsafe { profile.GetNonDefaultPermissionSettings(&handler) };
    }

    /// Forgets WebView2's saved answer for a site (and kind), so the site asks again.
    pub fn forget_engine_permission(webview: &Webview, origin: String, kind: Option<String>) {
        let _ = webview.with_webview(move |platform| {
            if let Ok(core) = core_of(&platform) {
                reset_engine_permissions(&core, Some((origin, kind)));
            }
        });
    }

    pub fn apply_tracking_to(webview: &Webview) {
        let _ = webview.with_webview(|platform| {
            if let Ok(core) = core_of(&platform) {
                apply_tracking(&core);
            }
        });
    }

    fn kinds_of(names: &[String]) -> COREWEBVIEW2_BROWSING_DATA_KINDS {
        let mut bits = 0;
        for name in names {
            bits |= match name.as_str() {
                "cookies" => COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES.0,
                "cache" => COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0 | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0,
                "storage" => COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE.0,
                "autofill" => COREWEBVIEW2_BROWSING_DATA_KINDS_GENERAL_AUTOFILL.0 | COREWEBVIEW2_BROWSING_DATA_KINDS_PASSWORD_AUTOSAVE.0,
                _ => 0,
            };
        }
        COREWEBVIEW2_BROWSING_DATA_KINDS(bits)
    }

    /// Clears site data of the given kinds from the normal (non-private)
    /// profile, optionally only what was stored after `since` (Unix seconds).
    pub async fn clear_data(webview: &Webview, kinds: Vec<String>, since: Option<f64>) -> Result<(), String> {
        let kinds = kinds_of(&kinds);
        if kinds.0 == 0 {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let fail = tx.clone();
        webview
            .with_webview(move |platform| {
                let started = (|| -> windows_core::Result<()> {
                    let profile: ICoreWebView2Profile2 = profile_of(&core_of(&platform)?)?.cast()?;
                    let done = ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                        let _ = tx.send(result.map_err(|error| error.to_string()));
                        Ok(())
                    }));
                    unsafe {
                        match since {
                            Some(start) => profile.ClearBrowsingDataInTimeRange(kinds, start, f64::MAX, &done),
                            None => profile.ClearBrowsingData(kinds, &done),
                        }
                    }
                })();
                if let Err(error) = started {
                    let _ = fail.send(Err(error.to_string()));
                }
            })
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| Err("clearing timed out".into())))
            .await
            .map_err(|error| error.to_string())?
    }

    /// Clears cookies and storage for one site, in the profile of `webview`
    /// (so a private tab clears its private data).
    pub fn clear_origin(webview: &Webview, origin: String) -> Result<(), String> {
        webview
            .with_webview(move |platform| {
                let _ = (|| -> windows_core::Result<()> {
                    let core = core_of(&platform)?;
                    let method = HSTRING::from("Storage.clearDataForOrigin");
                    let params = HSTRING::from(serde_json::json!({ "origin": origin, "storageTypes": "all" }).to_string());
                    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
                    unsafe { core.CallDevToolsProtocolMethod(PCWSTR(method.as_ptr()), PCWSTR(params.as_ptr()), &done) }
                })();
            })
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::*;

    pub fn attach(_webview: &Webview, _app: AppHandle, _label: String) {}
    pub fn resolve_permission(_app: &AppHandle, _request_id: u64, _allow: bool, _remember: bool) -> Result<(), String> { Ok(()) }
    pub fn apply_tracking_to(_webview: &Webview) {}
    pub fn forget_engine_permission(_webview: &Webview, _origin: String, _kind: Option<String>) {}
    pub async fn clear_data(webview: &Webview, kinds: Vec<String>, _since: Option<f64>) -> Result<(), String> {
        if kinds.is_empty() { return Ok(()); }
        webview.clear_all_browsing_data().map_err(|error| error.to_string())
    }
    pub fn clear_origin(_webview: &Webview, _origin: String) -> Result<(), String> {
        Err("clearing one site is not supported on this platform".into())
    }
}

pub use imp::{apply_tracking_to, attach, clear_data, clear_origin, forget_engine_permission, resolve_permission};
