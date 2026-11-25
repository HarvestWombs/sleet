//! WebView2-specific features Tauri does not expose: page snapshots and
//! download progress. Other platforms get graceful no-ops.

use tauri::{AppHandle, Webview};

/// A download changed state. Keyed by the address it started from, so
/// redirects (GitHub release files, CDNs) still match the entry Sleet created.
#[derive(Clone, serde::Serialize)]
pub struct DownloadState {
    pub label: String,
    pub url: String,
    /// Final: `complete`, `cancelled`, `failed`, or `discarded` (the user
    /// closed the Save as dialog, so the download never started).
    /// Ongoing: `paused` (by the user, or by a network error it can resume
    /// from) and `active` (running again, or saving to a new path).
    pub state: &'static str,
    pub path: Option<String>,
    /// Why it failed or stopped, in plain words.
    pub reason: Option<&'static str>,
}

/// "Ask where to save each file" (Settings → Downloads).
pub static ASK_WHERE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The Save as dialog for a download. `None` when the user closes it.
fn save_dialog(suggested: &std::path::Path) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new().set_title("Save as");
    if let Some(folder) = suggested.parent().filter(|folder| folder.is_dir()) {
        dialog = dialog.set_directory(folder);
    }
    if let Some(name) = suggested.file_name() {
        dialog = dialog.set_file_name(name.to_string_lossy());
    }
    if let Some(extension) = suggested.extension().map(|value| value.to_string_lossy().into_owned()).filter(|value| !value.is_empty()) {
        dialog = dialog.add_filter(format!("{} file", extension.to_uppercase()), &[extension.as_str()]).add_filter("All files", &["*"]);
    }
    dialog
}

/// Asks where to save a download, blocking the caller (used where the engine
/// waits on a synchronous answer). `None` when the user cancels.
#[cfg(not(target_os = "windows"))]
pub fn ask_save_path(suggested: &std::path::Path) -> Option<std::path::PathBuf> {
    save_dialog(suggested).save_file()
}

/// Windows flagged a file type as potentially harmful; Sleet asks the user
/// to keep or delete it, then answers with `resolve_download_check`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCheck {
    pub check_id: u64,
    pub label: String,
    pub path: String,
    pub extension: String,
}

#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub label: String,
    pub url: String,
    pub received: i64,
    pub total: Option<i64>,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{DownloadCheck, DownloadProgress, DownloadState};
    use std::{
        cell::RefCell,
        collections::HashMap,
        sync::{
            atomic::{AtomicI64, AtomicU64, Ordering},
            mpsc, Arc,
        },
    };
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager, Webview};
    use webview2_com::{
        take_pwstr, BytesReceivedChangedEventHandler, CapturePreviewCompletedHandler,
        DownloadStartingEventHandler, SaveFileSecurityCheckStartingEventHandler,
        StateChangedEventHandler,
        Microsoft::Web::WebView2::Win32::*,
    };
    use windows::Win32::{
        Foundation::{E_FAIL, HGLOBAL},
        System::Com::{
            IStream, StructuredStorage::CreateStreamOnHGlobal, STATFLAG_NONAME, STATSTG,
            STREAM_SEEK_SET,
        },
    };
    use windows_core::{Interface, PWSTR};

    fn controller(
        platform: &tauri::webview::PlatformWebview,
    ) -> windows_core::Result<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller>
    {
        platform
            .downcast_ref::<tauri_runtime_wry::Webview>()
            .map(|webview| webview.controller())
            .ok_or_else(|| E_FAIL.into())
    }

    unsafe fn read_stream(stream: &IStream) -> windows_core::Result<Vec<u8>> {
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME)?;
        stream.Seek(0, STREAM_SEEK_SET, None)?;
        let mut buffer = vec![0u8; stat.cbSize as usize];
        let mut read = 0u32;
        stream
            .Read(buffer.as_mut_ptr().cast(), buffer.len() as u32, Some(&mut read))
            .ok()?;
        buffer.truncate(read as usize);
        Ok(buffer)
    }

    /// JPEG snapshot of what the page currently shows.
    pub async fn capture(webview: &Webview) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        let fail = tx.clone();
        webview
            .with_webview(move |platform| {
                let started = (|| -> windows_core::Result<()> {
                    let core = unsafe { controller(&platform)?.CoreWebView2()? };
                    let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true)? };
                    let reader = stream.clone();
                    let handler = CapturePreviewCompletedHandler::create(Box::new(
                        move |result| {
                            let bytes = result
                                .and_then(|_| unsafe { read_stream(&reader) })
                                .map_err(|error| error.to_string());
                            let _ = tx.send(bytes);
                            Ok(())
                        },
                    ));
                    unsafe {
                        core.CapturePreview(
                            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
                            &stream,
                            &handler,
                        )
                    }
                })();
                if let Err(error) = started {
                    let _ = fail.send(Err(error.to_string()));
                }
            })
            .map_err(|error| error.to_string())?;

        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(3))
                .map_err(|_| "capture timed out".to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }

    /// Saves the page as a PDF file (default print settings).
    pub async fn print_to_pdf(webview: &Webview, path: &std::path::Path) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<Result<(), String>>();
        let fail = tx.clone();
        let target = windows_core::HSTRING::from(path.as_os_str());
        webview
            .with_webview(move |platform| {
                let started = (|| -> windows_core::Result<()> {
                    let core: ICoreWebView2_7 = unsafe { controller(&platform)?.CoreWebView2()? }.cast()?;
                    let handler = webview2_com::PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                        let _ = tx.send(match result {
                            Ok(()) if ok => Ok(()),
                            Ok(()) => Err("the page couldn't be saved as a PDF".to_string()),
                            Err(error) => Err(error.to_string()),
                        });
                        Ok(())
                    }));
                    unsafe { core.PrintToPdf(windows_core::PCWSTR(target.as_ptr()), None, &handler) }
                })();
                if let Err(error) = started {
                    let _ = fail.send(Err(error.to_string()));
                }
            })
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "saving the PDF timed out".to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }

    thread_local! {
        /// Running downloads by `label:start-url`. WebView2 objects live on the
        /// UI thread, so commands reach them through `run_on_main_thread`.
        static OPERATIONS: RefCell<HashMap<String, ICoreWebView2DownloadOperation>> = RefCell::new(HashMap::new());
        /// Security checks waiting for the user's keep/delete answer.
        static CHECKS: RefCell<HashMap<u64, (ICoreWebView2SaveFileSecurityCheckStartingEventArgs, ICoreWebView2Deferral)>> = RefCell::new(HashMap::new());
        /// Downloads held while the Save as dialog is open.
        static SAVES: RefCell<HashMap<u64, (ICoreWebView2DownloadStartingEventArgs, ICoreWebView2Deferral)>> = RefCell::new(HashMap::new());
    }
    static NEXT_CHECK: AtomicU64 = AtomicU64::new(1);

    /// Holds a starting download (WebView2 deferral) while the Save as dialog
    /// is open on another thread, then saves where the user chose or drops it.
    /// The engine's own handler has already applied the download folder.
    fn ask_where(app: &AppHandle, label: &str, url: &str, args: &ICoreWebView2DownloadStartingEventArgs) -> windows_core::Result<()> {
        let suggested = {
            let mut path = PWSTR::null();
            unsafe { args.ResultFilePath(&mut path)? };
            std::path::PathBuf::from(take_pwstr(path))
        };
        let deferral = unsafe { args.GetDeferral()? };
        let id = NEXT_CHECK.fetch_add(1, Ordering::Relaxed);
        SAVES.with(|saves| saves.borrow_mut().insert(id, (args.clone(), deferral)));
        let mut dialog = super::save_dialog(&suggested);
        if let Some(window) = app.get_webview(label).map(|webview| webview.window()) {
            dialog = dialog.set_parent(&window);
        }
        let (app, label, url) = (app.clone(), label.to_string(), url.to_string());
        std::thread::spawn(move || {
            let chosen = dialog.save_file();
            let main = app.clone();
            let _ = main.run_on_main_thread(move || {
                let Some((args, deferral)) = SAVES.with(|saves| saves.borrow_mut().remove(&id)) else { return };
                let state = match &chosen {
                    Some(path) => {
                        let target = windows_core::HSTRING::from(path.as_os_str());
                        let _ = unsafe { args.SetResultFilePath(windows_core::PCWSTR(target.as_ptr())) };
                        "active"
                    }
                    None => {
                        let _ = unsafe { args.SetCancel(true) };
                        "discarded"
                    }
                };
                let _ = unsafe { deferral.Complete() };
                let _ = app.emit("sleet-download-state", DownloadState {
                    label,
                    url,
                    state,
                    path: chosen.map(|path| path.to_string_lossy().into_owned()),
                    reason: None,
                });
            });
        });
        Ok(())
    }

    fn reason_text(reason: COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON) -> &'static str {
        match reason {
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_SECURITY_CHECK_FAILED
            | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_MALICIOUS
            | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED_BY_POLICY => "Blocked by Windows security",
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE => "Not enough disk space",
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_ACCESS_DENIED => "No permission to save there",
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NAME_TOO_LONG => "File name too long",
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED
            | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_FAILED
            | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT
            | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_SERVER_DOWN => "Network error",
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FORBIDDEN
            | COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_UNAUTHORIZED => "The site refused the download",
            COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN => "Interrupted when Sleet closed",
            _ => "Download failed",
        }
    }

    /// Tracks every download in a page: progress, how it ends, cancel support,
    /// and the "this file type can harm your device" check.
    pub fn watch_downloads(webview: &Webview, app: AppHandle, label: String) {
        let _ = webview.with_webview(move |platform| {
            let _ = (|| -> windows_core::Result<()> {
                let core = unsafe { controller(&platform)?.CoreWebView2()? };
                let downloads: ICoreWebView2_4 = core.cast()?;
                let start_app = app.clone();
                let start_label = label.clone();
                let mut token = 0i64;
                let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let operation = unsafe { args.DownloadOperation()? };
                    let url = {
                        let mut uri = PWSTR::null();
                        unsafe { operation.Uri(&mut uri)? };
                        take_pwstr(uri)
                    };
                    let key = format!("{start_label}:{url}");
                    OPERATIONS.with(|ops| ops.borrow_mut().insert(key.clone(), operation.clone()));
                    if super::ASK_WHERE.load(Ordering::Relaxed) {
                        let _ = ask_where(&start_app, &start_label, &url, &args);
                    }

                    // Progress, at most once per percent (or per MiB when the size is unknown).
                    let app = start_app.clone();
                    let label = start_label.clone();
                    let progress_url = url.clone();
                    let last = Arc::new(AtomicI64::new(-1));
                    let mut progress_token = 0i64;
                    let progress = BytesReceivedChangedEventHandler::create(Box::new(move |operation, _| {
                        let Some(operation) = operation else { return Ok(()) };
                        let (mut received, mut total) = (0i64, 0i64);
                        unsafe {
                            operation.BytesReceived(&mut received)?;
                            operation.TotalBytesToReceive(&mut total)?;
                        }
                        let step = if total > 0 { received * 100 / total } else { received >> 20 };
                        if last.swap(step, Ordering::Relaxed) != step {
                            let _ = app.emit("sleet-download-progress", DownloadProgress {
                                label: label.clone(),
                                url: progress_url.clone(),
                                received,
                                total: (total > 0).then_some(total),
                            });
                        }
                        Ok(())
                    }));
                    unsafe { operation.add_BytesReceivedChanged(&progress, &mut progress_token)? };

                    // End state, reported under the start address.
                    let app = start_app.clone();
                    let label = start_label.clone();
                    let mut state_token = 0i64;
                    let state = StateChangedEventHandler::create(Box::new(move |operation, _| {
                        let Some(operation) = operation else { return Ok(()) };
                        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                        unsafe { operation.State(&mut state)? };
                        let report = |state: &'static str, reason: Option<&'static str>| {
                            let _ = app.emit("sleet-download-state", DownloadState { label: label.clone(), url: url.clone(), state, path: None, reason });
                        };
                        if state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                            // Running again after a pause.
                            report("active", None);
                            return Ok(());
                        }
                        if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                            // Paused by the user, or stopped by an error it can pick up
                            // from: keep the operation so Resume can continue it.
                            let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                            let _ = unsafe { operation.InterruptReason(&mut reason) };
                            let mut can_resume = windows_core::BOOL::default();
                            let _ = unsafe { operation.CanResume(&mut can_resume) };
                            if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_PAUSED {
                                report("paused", None);
                                return Ok(());
                            }
                            if can_resume.as_bool() && reason != COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED && reason != COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN {
                                report("paused", Some(reason_text(reason)));
                                return Ok(());
                            }
                        }
                        OPERATIONS.with(|ops| ops.borrow_mut().remove(&key));
                        let path = {
                            let mut path = PWSTR::null();
                            unsafe { operation.ResultFilePath(&mut path) }.ok().map(|_| take_pwstr(path)).filter(|p| !p.is_empty())
                        };
                        let (state, reason) = if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                            ("complete", None)
                        } else {
                            let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                            let _ = unsafe { operation.InterruptReason(&mut reason) };
                            if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
                                ("cancelled", None)
                            } else {
                                ("failed", Some(reason_text(reason)))
                            }
                        };
                        let _ = app.emit("sleet-download-state", DownloadState {
                            label: label.clone(),
                            url: url.clone(),
                            state,
                            path,
                            reason,
                        });
                        Ok(())
                    }));
                    unsafe { operation.add_StateChanged(&state, &mut state_token)? };
                    Ok(())
                }));
                unsafe { downloads.add_DownloadStarting(&handler, &mut token)? };

                // "This type of file can harm your device": wry hides the panel
                // where WebView2 would ask, so Sleet asks instead.
                if let Ok(checks) = core.cast::<ICoreWebView2_26>() {
                    let app = app.clone();
                    let label = label.clone();
                    let mut check_token = 0i64;
                    let handler = SaveFileSecurityCheckStartingEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let deferral = unsafe { args.GetDeferral()? };
                        let read = |get: &dyn Fn(*mut PWSTR) -> windows_core::Result<()>| {
                            let mut value = PWSTR::null();
                            get(&mut value).ok().map(|_| take_pwstr(value)).unwrap_or_default()
                        };
                        let path = read(&|value| unsafe { args.FilePath(value) });
                        let extension = read(&|value| unsafe { args.FileExtension(value) });
                        let check_id = NEXT_CHECK.fetch_add(1, Ordering::Relaxed);
                        CHECKS.with(|checks| checks.borrow_mut().insert(check_id, (args.clone(), deferral)));
                        let _ = app.emit("sleet-download-check", DownloadCheck { check_id, label: label.clone(), path, extension });
                        Ok(())
                    }));
                    unsafe { checks.add_SaveFileSecurityCheckStarting(&handler, &mut check_token)? };
                }
                Ok(())
            })();
        });
    }

    pub fn cancel_download(app: &AppHandle, id: String) -> Result<(), String> {
        app.run_on_main_thread(move || {
            OPERATIONS.with(|ops| {
                if let Some(operation) = ops.borrow().get(&id) {
                    let _ = unsafe { operation.Cancel() };
                }
            });
        })
        .map_err(|error| error.to_string())
    }

    /// Pauses (`true`) or resumes (`false`) a running download.
    pub fn pause_download(app: &AppHandle, id: String, pause: bool) -> Result<(), String> {
        app.run_on_main_thread(move || {
            OPERATIONS.with(|ops| {
                if let Some(operation) = ops.borrow().get(&id) {
                    let _ = unsafe { if pause { operation.Pause() } else { operation.Resume() } };
                }
            });
        })
        .map_err(|error| error.to_string())
    }

    /// Answers a security check: keep the file (skip Windows' warning for this
    /// one file only) or delete it.
    pub fn resolve_download_check(app: &AppHandle, check_id: u64, keep: bool) -> Result<(), String> {
        app.run_on_main_thread(move || {
            if let Some((args, deferral)) = CHECKS.with(|checks| checks.borrow_mut().remove(&check_id)) {
                unsafe {
                    let _ = if keep { args.SetSuppressDefaultPolicy(true) } else { args.SetCancelSave(true) };
                    let _ = deferral.Complete();
                }
            }
        })
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use tauri::{AppHandle, Webview};

    pub async fn capture(_webview: &Webview) -> Result<Vec<u8>, String> {
        Err("page capture is not supported on this platform".into())
    }

    pub fn watch_downloads(_webview: &Webview, _app: AppHandle, _label: String) {}

    pub fn cancel_download(_app: &AppHandle, _id: String) -> Result<(), String> {
        Err("cancelling downloads is not supported on this platform".into())
    }

    pub fn pause_download(_app: &AppHandle, _id: String, _pause: bool) -> Result<(), String> {
        Err("pausing downloads is not supported on this platform yet".into())
    }

    pub fn resolve_download_check(_app: &AppHandle, _check_id: u64, _keep: bool) -> Result<(), String> {
        Ok(())
    }

    pub async fn print_to_pdf(webview: &Webview, _path: &std::path::Path) -> Result<(), String> {
        // WebKit has no direct PDF export here; its print dialog offers Save as PDF.
        webview.eval("window.print()").map_err(|error| error.to_string())?;
        Err("print-dialog".into())
    }
}

pub async fn print_to_pdf(webview: &Webview, path: &std::path::Path) -> Result<(), String> {
    imp::print_to_pdf(webview, path).await
}

/// Opens a link (mailto:, tel:, zoommtg: ...) in the app registered for it.
/// The caller has already checked the scheme.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        // rundll32's URL handler hands the link to its registered app without a shell.
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(url);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

pub async fn capture(webview: &Webview) -> Result<Vec<u8>, String> {
    imp::capture(webview).await
}

pub fn watch_downloads(webview: &Webview, app: AppHandle, label: String) {
    imp::watch_downloads(webview, app, label)
}

pub fn cancel_download(app: &AppHandle, id: String) -> Result<(), String> {
    imp::cancel_download(app, id)
}

pub fn resolve_download_check(app: &AppHandle, check_id: u64, keep: bool) -> Result<(), String> {
    imp::resolve_download_check(app, check_id, keep)
}

pub fn pause_download(app: &AppHandle, id: String, pause: bool) -> Result<(), String> {
    imp::pause_download(app, id, pause)
}

/// Opens a file with its default application.
pub fn open_path(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(path);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(path);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path);
        command
    };
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}

/// Opens the containing folder with the file selected where the platform supports it.
pub fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("explorer");
        command.raw_arg(format!("/select,\"{}\"", path.display()));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg("-R").arg(path);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path.parent().unwrap_or(path));
        command
    };
    command.spawn().map(|_| ()).map_err(|error| error.to_string())
}
