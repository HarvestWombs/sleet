//! Default-browser registration (Windows) and opening links passed on the
//! command line. A link clicked in another app starts `sleet.exe <link>`; when
//! Sleet is already running, the single-instance plugin (see lib.rs) hands the
//! link to it and the new process exits, so the link opens as a tab.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Links Sleet was started with, handed to the UI once it is ready.
#[derive(Default)]
pub struct LaunchUrls(pub Mutex<Vec<String>>);

/// http(s) links from command-line arguments (how Windows passes a clicked link).
pub fn urls_from_args(args: impl Iterator<Item = String>) -> Vec<String> {
    args.filter(|arg| {
        url::Url::parse(arg)
            .map(|url| matches!(url.scheme(), "http" | "https"))
            .unwrap_or(false)
    })
    .collect()
}

/// Another launch of Sleet (a link clicked in another app) passed its command
/// line here: bring Sleet forward and open its links in the window used last.
pub fn open_from_other_launch(app: &AppHandle, argv: Vec<String>) {
    let urls = urls_from_args(argv.into_iter().skip(1));
    let Some(window) = crate::windows::focused_window(app) else { return };
    let _ = window.unminimize();
    let _ = window.set_focus();
    if !urls.is_empty() {
        let _ = app.emit("sleet-open-urls", serde_json::json!({ "window": window.label(), "urls": urls }));
    }
}

/// Removes the hand-off file older versions used (`<app data>/instance`).
pub fn remove_old_instance_file() {
    if let Some(base) = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME")) {
        let _ = std::fs::remove_file(std::path::PathBuf::from(base).join("com.sleet.browser").join("instance"));
    }
}

/// Installed Sleet keeps link registration pointing at itself: after an
/// update or a move, or when a development build registered itself, links
/// would otherwise start a different `sleet.exe`. (Release builds only.)
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn repair_registration() {
    imp::repair();
}

#[cfg(target_os = "windows")]
mod imp {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    const PROG_ID: &str = "SleetURL";
    const CLIENT: &str = r"Software\Clients\StartMenuInternet\Sleet";

    /// True when Windows sends https links to Sleet.
    pub fn is_default() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice")
            .and_then(|key| key.get_value::<String, _>("ProgId"))
            .map(|prog_id| prog_id == PROG_ID)
            .unwrap_or(false)
    }

    /// Registers Sleet as a browser for this user (no admin needed). Windows
    /// then lists it under default apps; the user picks it there.
    pub fn register() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let exe = exe.display().to_string();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let err = |error: std::io::Error| error.to_string();

        // Entries written under the old name (before the rename to Sleet).
        let _ = hkcu.delete_subkey_all(r"Software\Classes\HorizonURL");
        let _ = hkcu.delete_subkey_all(r"Software\Clients\StartMenuInternet\Horizon");
        if let Ok(registered) = hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", winreg::enums::KEY_SET_VALUE) {
            let _ = registered.delete_value("Horizon");
        }

        let (prog, _) = hkcu.create_subkey(format!(r"Software\Classes\{PROG_ID}")).map_err(err)?;
        prog.set_value("", &"Sleet URL").map_err(err)?;
        prog.set_value("FriendlyTypeName", &"Sleet URL").map_err(err)?;
        let (icon, _) = prog.create_subkey("DefaultIcon").map_err(err)?;
        icon.set_value("", &format!("\"{exe}\",0")).map_err(err)?;
        let (command, _) = prog.create_subkey(r"shell\open\command").map_err(err)?;
        command.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(err)?;

        let (client, _) = hkcu.create_subkey(CLIENT).map_err(err)?;
        client.set_value("", &"Sleet").map_err(err)?;
        let (client_icon, _) = client.create_subkey("DefaultIcon").map_err(err)?;
        client_icon.set_value("", &format!("\"{exe}\",0")).map_err(err)?;
        let (client_command, _) = client.create_subkey(r"shell\open\command").map_err(err)?;
        client_command.set_value("", &format!("\"{exe}\"")).map_err(err)?;
        let (capabilities, _) = client.create_subkey("Capabilities").map_err(err)?;
        capabilities.set_value("ApplicationName", &"Sleet").map_err(err)?;
        capabilities.set_value("ApplicationDescription", &"A focused, lightweight browser").map_err(err)?;
        capabilities.set_value("ApplicationIcon", &format!("\"{exe}\",0")).map_err(err)?;
        let (urls, _) = capabilities.create_subkey("URLAssociations").map_err(err)?;
        urls.set_value("http", &PROG_ID).map_err(err)?;
        urls.set_value("https", &PROG_ID).map_err(err)?;

        let (registered, _) = hkcu.create_subkey(r"Software\RegisteredApplications").map_err(err)?;
        registered.set_value("Sleet", &format!(r"{CLIENT}\Capabilities")).map_err(err)?;
        Ok(())
    }

    /// Re-registers when Sleet is registered for links but under another program path.
    #[cfg_attr(debug_assertions, allow(dead_code))]
    pub fn repair() {
        let Ok(exe) = std::env::current_exe() else { return };
        let expected = format!("\"{}\" \"%1\"", exe.display());
        let registered = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(format!(r"Software\Classes\{PROG_ID}\shell\open\command"))
            .and_then(|key| key.get_value::<String, _>(""));
        if let Ok(command) = registered {
            if !command.eq_ignore_ascii_case(&expected) {
                let _ = register();
            }
        }
    }

    /// Opens Windows' default apps page for Sleet (Windows 11 deep link;
    /// Windows 10 shows the general default apps page).
    pub fn open_settings() -> Result<(), String> {
        // Windows 10 doesn't understand the per-app query: handed to `explorer`
        // it opened File Explorer instead of Settings. Windows 11 is build 22000+.
        let build: u32 = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
            .ok()
            .and_then(|build| build.trim().parse().ok())
            .unwrap_or(0);
        let page = if build >= 22000 { "ms-settings:defaultapps?registeredAppUser=Sleet" } else { "ms-settings:defaultapps" };
        // The URL handler opens ms-settings: links in Settings (no shell involved).
        crate::native::open_url(page)
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn is_default() -> bool { false }
    pub fn register() -> Result<(), String> { Err("setting the default browser is only supported on Windows for now".into()) }
    pub fn open_settings() -> Result<(), String> { Ok(()) }
    #[cfg_attr(debug_assertions, allow(dead_code))]
    pub fn repair() {}
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBrowserStatus {
    pub supported: bool,
    pub is_default: bool,
}

#[tauri::command]
pub fn default_browser_status() -> DefaultBrowserStatus {
    DefaultBrowserStatus { supported: cfg!(target_os = "windows"), is_default: imp::is_default() }
}

/// Registers Sleet and opens Windows' default apps page to finish there.
#[tauri::command]
pub fn make_default_browser() -> Result<(), String> {
    imp::register()?;
    imp::open_settings()
}

/// Links Sleet was launched with (taken once).
#[tauri::command]
pub fn take_launch_urls(state: tauri::State<'_, LaunchUrls>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap_or_else(|poison| poison.into_inner()))
}
