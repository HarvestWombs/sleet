//! Default-browser registration (Windows), opening links passed on the
//! command line, and forwarding them to an already running Sleet so links
//! from other apps open as tabs instead of a second window.

use std::{
    io::{BufRead, BufReader, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

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

fn instance_file() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(base).join("com.sleet.browser").join("instance"))
}

/// If Sleet is already running, sends it `urls` and returns true (this
/// process should then exit). The running instance listens on localhost and
/// requires the secret stored next to its port.
pub fn forward_to_running(urls: &[String]) -> bool {
    let Some(file) = instance_file() else { return false };
    let Ok(contents) = std::fs::read_to_string(file) else { return false };
    let mut parts = contents.split_whitespace();
    let (Some(port), Some(secret)) = (parts.next(), parts.next()) else { return false };
    let Ok(port) = port.parse::<u16>() else { return false };
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else { return false };
    let message = serde_json::json!({ "secret": secret, "urls": urls }).to_string();
    stream.write_all(message.as_bytes()).is_ok() && stream.write_all(b"\n").is_ok()
}

/// Accepts links from later launches and opens them in this window.
pub fn listen_for_other_launches(app: AppHandle) {
    let Some(file) = instance_file() else { return };
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else { return };
    let Ok(port) = listener.local_addr().map(|address| address.port()) else { return };
    let secret = format!("{:x}{:x}", std::process::id(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_nanos())
        .unwrap_or_default());
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(&file, format!("{port} {secret}")).is_err() {
        return;
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).is_err() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if message["secret"].as_str() != Some(secret.as_str()) {
                continue;
            }
            let urls: Vec<String> = message["urls"]
                .as_array()
                .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let urls = urls_from_args(urls.into_iter());
            if let Some(window) = app.get_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if !urls.is_empty() {
                let _ = app.emit("sleet-open-urls", urls);
            }
        }
    });
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

    /// Opens Windows' default apps page for Sleet (Windows 11 deep link;
    /// Windows 10 shows the general default apps page).
    pub fn open_settings() -> Result<(), String> {
        std::process::Command::new("explorer")
            .arg("ms-settings:defaultapps?registeredAppUser=Sleet")
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn is_default() -> bool { false }
    pub fn register() -> Result<(), String> { Err("setting the default browser is only supported on Windows for now".into()) }
    pub fn open_settings() -> Result<(), String> { Ok(()) }
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
