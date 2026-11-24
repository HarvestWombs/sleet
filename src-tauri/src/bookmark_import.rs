//! Reads bookmarks (and their icons) from other browsers installed for this
//! user: Chromium-based ones (Chrome, Edge, Brave, Vivaldi, Opera, Chromium),
//! Firefox, and Arc (its favorites and pinned tabs). Only files found by
//! detection can be read; the UI asks by source id, never by path.

use base64::Engine;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
pub struct ImportNode {
    pub title: String,
    pub url: Option<String>,
    pub children: Option<Vec<ImportNode>>,
}

/// A top-level group in the source browser. `grid` marks the bookmarks bar /
/// Arc favorites, which map naturally onto Sleet's grid.
#[derive(Debug, Clone, Serialize)]
pub struct ImportRoot {
    pub title: String,
    pub grid: bool,
    pub nodes: Vec<ImportNode>,
}

#[derive(Debug, Serialize)]
pub struct ImportedBookmarks {
    pub roots: Vec<ImportRoot>,
    /// Site icons by host, as PNG data URLs, from the source's favicon store.
    pub icons: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookmarkSource {
    pub id: String,
    pub browser: String,
    pub profile: String,
    pub count: usize,
}

enum Kind {
    Chromium { bookmarks: PathBuf, favicons: PathBuf },
    Firefox { profile: PathBuf },
    Arc { sidebar: PathBuf, favicons: PathBuf },
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

fn link(title: &str, url: &str) -> ImportNode {
    ImportNode { title: title.to_string(), url: Some(url.to_string()), children: None }
}

fn count_links(nodes: &[ImportNode]) -> usize {
    nodes.iter().map(|node| if node.url.is_some() { 1 } else { node.children.as_deref().map(count_links).unwrap_or(0) }).sum()
}

// ---------------------------------------------------------------- Chromium

fn chromium_node(value: &Value) -> Option<ImportNode> {
    let title = value["name"].as_str().unwrap_or_default();
    match value["type"].as_str()? {
        "url" => value["url"].as_str().map(|url| link(title, url)),
        "folder" => Some(ImportNode {
            title: title.to_string(),
            url: None,
            children: Some(value["children"].as_array().map(|items| items.iter().filter_map(chromium_node).collect()).unwrap_or_default()),
        }),
        _ => None,
    }
}

fn read_chromium(bookmarks: &Path) -> Result<Vec<ImportRoot>, String> {
    let text = std::fs::read_to_string(bookmarks).map_err(|error| error.to_string())?;
    let json: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let roots = &json["roots"];
    let named = [("bookmark_bar", "Bookmarks bar", true), ("other", "Other bookmarks", false), ("synced", "Mobile bookmarks", false)];
    Ok(named
        .iter()
        .filter_map(|(key, title, grid)| {
            let nodes: Vec<ImportNode> = roots[*key]["children"].as_array()?.iter().filter_map(chromium_node).collect();
            (!nodes.is_empty()).then(|| ImportRoot { title: title.to_string(), grid: *grid, nodes })
        })
        .collect())
}

/// Profile folders with a Bookmarks file, with their display names from Local State.
fn chromium_profiles(user_data: &Path) -> Vec<(String, PathBuf)> {
    let names: HashMap<String, String> = std::fs::read_to_string(user_data.join("Local State"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|json| json["profile"]["info_cache"].as_object().cloned())
        .map(|cache| cache.iter().map(|(dir, info)| (dir.clone(), info["name"].as_str().unwrap_or(dir).to_string())).collect())
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(user_data) else { return Vec::new() };
    let mut profiles: Vec<(String, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join("Bookmarks").is_file())
        .map(|path| {
            let dir = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
            (names.get(&dir).cloned().unwrap_or(dir), path)
        })
        .collect();
    profiles.sort_by(|a, b| a.0.cmp(&b.0));
    profiles
}

// ---------------------------------------------------------------- Firefox

/// Copies a SQLite database (and its WAL) somewhere we can open it while the
/// browser keeps the original locked.
fn copy_database(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let dir = std::env::temp_dir().join(format!("sleet-import-{}-{}", std::process::id(), path.file_name()?.to_string_lossy()));
    std::fs::create_dir_all(&dir).ok()?;
    let target = dir.join(path.file_name()?);
    std::fs::copy(path, &target).ok()?;
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", path.display()));
        if side.is_file() {
            let _ = std::fs::copy(&side, PathBuf::from(format!("{}{suffix}", target.display())));
        }
    }
    Some((dir, target))
}

fn open_copy(path: &Path) -> Option<(PathBuf, Connection)> {
    let (dir, copy) = copy_database(path)?;
    let connection = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    Some((dir, connection))
}

fn read_firefox(profile: &Path) -> Result<Vec<ImportRoot>, String> {
    let (dir, db) = open_copy(&profile.join("places.sqlite")).ok_or("couldn't open Firefox's bookmarks")?;
    let result = (|| -> rusqlite::Result<Vec<ImportRoot>> {
        let mut statement = db.prepare(
            "SELECT b.id, b.type, b.parent, COALESCE(b.title, ''), p.url, b.guid
             FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position",
        )?;
        let rows: Vec<(i64, i64, i64, String, Option<String>, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut children: HashMap<i64, Vec<usize>> = HashMap::new();
        for (index, row) in rows.iter().enumerate() {
            children.entry(row.2).or_default().push(index);
        }
        fn build(index: usize, rows: &[(i64, i64, i64, String, Option<String>, String)], children: &HashMap<i64, Vec<usize>>) -> Option<ImportNode> {
            let (id, kind, _, title, url, _) = &rows[index];
            match kind {
                1 => url.as_deref().filter(|url| !url.starts_with("place:")).map(|url| link(title, url)),
                2 => Some(ImportNode {
                    title: title.clone(),
                    url: None,
                    children: Some(children.get(id).map(|items| items.iter().filter_map(|&child| build(child, rows, children)).collect()).unwrap_or_default()),
                }),
                _ => None,
            }
        }
        let named = [("toolbar_____", "Bookmarks toolbar", true), ("menu________", "Bookmarks menu", false), ("unfiled_____", "Other bookmarks", false), ("mobile______", "Mobile bookmarks", false)];
        Ok(named
            .iter()
            .filter_map(|(guid, title, grid)| {
                let root = rows.iter().position(|row| row.5 == *guid)?;
                let nodes: Vec<ImportNode> = children.get(&rows[root].0)?.iter().filter_map(|&child| build(child, &rows, &children)).collect();
                (!nodes.is_empty()).then(|| ImportRoot { title: title.to_string(), grid: *grid, nodes })
            })
            .collect())
    })();
    drop(db);
    let _ = std::fs::remove_dir_all(dir);
    result.map_err(|error| error.to_string())
}

fn firefox_profiles() -> Vec<(String, PathBuf)> {
    let Some(base) = env_dir("APPDATA").map(|dir| dir.join(r"Mozilla\Firefox\Profiles")) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join("places.sqlite").is_file())
        .map(|path| {
            let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
            // Folder names look like "abcd1234.default-release".
            (name.split_once('.').map(|(_, rest)| rest).unwrap_or(name).to_string(), path)
        })
        .collect()
}

// ---------------------------------------------------------------- Arc

fn arc_root() -> Option<PathBuf> {
    let packages = env_dir("LOCALAPPDATA")?.join("Packages");
    let package = std::fs::read_dir(packages).ok()?.flatten().map(|entry| entry.path()).find(|path| {
        path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("TheBrowserCompany.Arc"))
    })?;
    Some(package.join(r"LocalCache\Local\Arc"))
}

fn read_arc(sidebar: &Path) -> Result<Vec<ImportRoot>, String> {
    let text = std::fs::read_to_string(sidebar).map_err(|error| error.to_string())?;
    let json: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let containers = json["sidebar"]["containers"].as_array().ok_or("unexpected Arc sidebar format")?;
    let container = containers.iter().find(|container| container.get("items").is_some()).ok_or("unexpected Arc sidebar format")?;
    // Items and spaces are stored as alternating [id, object, id, object, ...].
    let items: HashMap<&str, &Value> = container["items"]
        .as_array()
        .map(|list| list.iter().filter(|item| item.is_object()).filter_map(|item| Some((item["id"].as_str()?, item))).collect())
        .unwrap_or_default();

    fn node(id: &str, items: &HashMap<&str, &Value>) -> Vec<ImportNode> {
        let Some(item) = items.get(id) else { return Vec::new() };
        let data = &item["data"];
        let children = || -> Vec<ImportNode> {
            item["childrenIds"].as_array().map(|ids| ids.iter().filter_map(Value::as_str).flat_map(|child| node(child, items)).collect()).unwrap_or_default()
        };
        if let Some(tab) = data.get("tab") {
            let Some(url) = tab["savedURL"].as_str() else { return Vec::new() };
            let title = item["title"].as_str().filter(|title| !title.is_empty()).or_else(|| tab["savedTitle"].as_str()).unwrap_or(url);
            return vec![link(title, url)];
        }
        if data.get("list").is_some() {
            return vec![ImportNode { title: item["title"].as_str().unwrap_or("Folder").to_string(), url: None, children: Some(children()) }];
        }
        // Item containers (favorites, a space's pinned area) just hold children.
        children()
    }

    let mut roots = Vec::new();
    let favorites: Vec<ImportNode> = container["topAppsContainerIDs"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).flat_map(|id| node(id, &items)).collect())
        .unwrap_or_default();
    if !favorites.is_empty() {
        roots.push(ImportRoot { title: "Arc favorites".into(), grid: true, nodes: favorites });
    }
    for space in container["spaces"].as_array().into_iter().flatten().filter(|space| space.is_object()) {
        let ids: Vec<&str> = space["containerIDs"].as_array().map(|ids| ids.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let pinned = ids.windows(2).find(|pair| pair[0] == "pinned").map(|pair| pair[1]);
        let nodes = pinned.map(|id| node(id, &items)).unwrap_or_default();
        if !nodes.is_empty() {
            let title = space["title"].as_str().filter(|title| !title.is_empty()).unwrap_or("Space");
            roots.push(ImportRoot { title: format!("Arc · {title}"), grid: false, nodes });
        }
    }
    Ok(roots)
}

// ---------------------------------------------------------------- icons

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok()?.host_str().map(|host| host.trim_start_matches("www.").to_string())
}

fn collect_hosts(nodes: &[ImportNode], hosts: &mut std::collections::HashSet<String>) {
    for node in nodes {
        if let Some(host) = node.url.as_deref().and_then(host_of) {
            hosts.insert(host);
        }
        if let Some(children) = &node.children {
            collect_hosts(children, hosts);
        }
    }
}

fn png_data_url(bytes: &[u8]) -> Option<String> {
    (bytes.len() > 8 && bytes.starts_with(b"\x89PNG")).then(|| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Picks one icon per host (closest to 32px) from rows of (page url, png, width).
fn pick_icons(rows: impl Iterator<Item = (String, Vec<u8>, i64)>, wanted: &std::collections::HashSet<String>) -> HashMap<String, String> {
    let mut best: HashMap<String, (i64, String)> = HashMap::new();
    for (page, data, width) in rows {
        let Some(host) = host_of(&page).filter(|host| wanted.contains(host)) else { continue };
        let Some(icon) = png_data_url(&data) else { continue };
        let score = (width - 32).abs();
        if best.get(&host).is_none_or(|(old, _)| score < *old) {
            best.insert(host, (score, icon));
        }
    }
    best.into_iter().map(|(host, (_, icon))| (host, icon)).collect()
}

fn chromium_icons(favicons: &Path, wanted: &std::collections::HashSet<String>) -> HashMap<String, String> {
    let Some((dir, db)) = open_copy(favicons) else { return HashMap::new() };
    let icons = (|| -> rusqlite::Result<HashMap<String, String>> {
        let mut statement = db.prepare(
            "SELECT m.page_url, b.image_data, b.width FROM icon_mapping m
             JOIN favicon_bitmaps b ON b.icon_id = m.icon_id WHERE b.width BETWEEN 16 AND 64",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, i64>(2)?)))?;
        Ok(pick_icons(rows.flatten(), wanted))
    })()
    .unwrap_or_default();
    drop(db);
    let _ = std::fs::remove_dir_all(dir);
    icons
}

fn firefox_icons(profile: &Path, wanted: &std::collections::HashSet<String>) -> HashMap<String, String> {
    let Some((dir, db)) = open_copy(&profile.join("favicons.sqlite")) else { return HashMap::new() };
    let icons = (|| -> rusqlite::Result<HashMap<String, String>> {
        let mut statement = db.prepare(
            "SELECT p.page_url, i.data, i.width FROM moz_pages_w_icons p
             JOIN moz_icons_to_pages ip ON ip.page_id = p.id JOIN moz_icons i ON i.id = ip.icon_id
             WHERE i.width BETWEEN 16 AND 64",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, i64>(2)?)))?;
        Ok(pick_icons(rows.flatten(), wanted))
    })()
    .unwrap_or_default();
    drop(db);
    let _ = std::fs::remove_dir_all(dir);
    icons
}

// ---------------------------------------------------------------- detection

fn all_sources() -> Vec<(BookmarkSource, Kind)> {
    let mut sources = Vec::new();
    let local = env_dir("LOCALAPPDATA");
    let roaming = env_dir("APPDATA");
    let chromium: [(&str, Option<PathBuf>, bool); 7] = [
        ("Chrome", local.as_ref().map(|dir| dir.join(r"Google\Chrome\User Data")), true),
        ("Edge", local.as_ref().map(|dir| dir.join(r"Microsoft\Edge\User Data")), true),
        ("Brave", local.as_ref().map(|dir| dir.join(r"BraveSoftware\Brave-Browser\User Data")), true),
        ("Vivaldi", local.as_ref().map(|dir| dir.join(r"Vivaldi\User Data")), true),
        ("Chromium", local.as_ref().map(|dir| dir.join(r"Chromium\User Data")), true),
        ("Opera", roaming.as_ref().map(|dir| dir.join(r"Opera Software\Opera Stable")), false),
        ("Opera GX", roaming.as_ref().map(|dir| dir.join(r"Opera Software\Opera GX Stable")), false),
    ];
    for (browser, dir, multi_profile) in chromium {
        let Some(dir) = dir.filter(|dir| dir.is_dir()) else { continue };
        let profiles = if multi_profile { chromium_profiles(&dir) } else if dir.join("Bookmarks").is_file() { vec![("Default".to_string(), dir.clone())] } else { Vec::new() };
        for (profile, path) in profiles {
            let bookmarks = path.join("Bookmarks");
            let count = read_chromium(&bookmarks).map(|roots| roots.iter().map(|root| count_links(&root.nodes)).sum()).unwrap_or(0);
            let id = format!("{}:{}", browser.to_lowercase().replace(' ', "-"), path.file_name().and_then(|name| name.to_str()).unwrap_or_default());
            sources.push((BookmarkSource { id, browser: browser.into(), profile, count }, Kind::Chromium { bookmarks, favicons: path.join("Favicons") }));
        }
    }
    for (profile, path) in firefox_profiles() {
        let count = read_firefox(&path).map(|roots| roots.iter().map(|root| count_links(&root.nodes)).sum()).unwrap_or(0);
        let id = format!("firefox:{}", path.file_name().and_then(|name| name.to_str()).unwrap_or_default());
        sources.push((BookmarkSource { id, browser: "Firefox".into(), profile, count }, Kind::Firefox { profile: path }));
    }
    if let Some(arc) = arc_root() {
        let sidebar = arc.join("StorableSidebar.json");
        if sidebar.is_file() {
            let count = read_arc(&sidebar).map(|roots| roots.iter().map(|root| count_links(&root.nodes)).sum()).unwrap_or(0);
            sources.push((
                BookmarkSource { id: "arc".into(), browser: "Arc".into(), profile: "Favorites and pinned tabs".into(), count },
                Kind::Arc { sidebar, favicons: arc.join(r"User Data\Default\Favicons") },
            ));
        }
    }
    sources
}

/// Browsers installed for this user that have bookmarks to import.
#[tauri::command]
pub async fn detect_bookmark_sources() -> Vec<BookmarkSource> {
    tauri::async_runtime::spawn_blocking(|| all_sources().into_iter().map(|(source, _)| source).collect())
        .await
        .unwrap_or_default()
}

/// Reads one detected source's bookmarks and site icons.
#[tauri::command]
pub async fn read_bookmark_source(id: String) -> Result<ImportedBookmarks, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, kind) = all_sources().into_iter().find(|(source, _)| source.id == id).ok_or("that browser's bookmarks weren't found")?;
        let (roots, icon_source) = match &kind {
            Kind::Chromium { bookmarks, favicons } => (read_chromium(bookmarks)?, Some((true, favicons.clone()))),
            Kind::Firefox { profile } => (read_firefox(profile)?, Some((false, profile.clone()))),
            Kind::Arc { sidebar, favicons } => (read_arc(sidebar)?, favicons.is_file().then(|| (true, favicons.clone()))),
        };
        let mut wanted = std::collections::HashSet::new();
        for root in &roots {
            collect_hosts(&root.nodes, &mut wanted);
        }
        let icons = match icon_source {
            Some((true, path)) if path.is_file() => chromium_icons(&path, &wanted),
            Some((false, path)) => firefox_icons(&path, &wanted),
            _ => HashMap::new(),
        };
        Ok(ImportedBookmarks { roots, icons })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against whatever browsers are installed; prints counts only.
    #[test]
    fn reads_installed_browsers() {
        for (source, kind) in all_sources() {
            let roots = match &kind {
                Kind::Chromium { bookmarks, .. } => read_chromium(bookmarks),
                Kind::Firefox { profile } => read_firefox(profile),
                Kind::Arc { sidebar, .. } => read_arc(sidebar),
            }
            .expect("source should parse");
            let mut wanted = std::collections::HashSet::new();
            roots.iter().for_each(|root| collect_hosts(&root.nodes, &mut wanted));
            let icons = match &kind {
                Kind::Chromium { favicons, .. } | Kind::Arc { favicons, .. } if favicons.is_file() => chromium_icons(favicons, &wanted).len(),
                Kind::Firefox { profile } => firefox_icons(profile, &wanted).len(),
                _ => 0,
            };
            let groups: Vec<String> = roots.iter().map(|root| format!("{}{} links", if root.grid { "grid:" } else { "" }, count_links(&root.nodes))).collect();
            println!("{} [{}] {} bookmarks, {} hosts, {} icons, groups {:?}", source.browser, source.id.split(':').next().unwrap_or_default(), source.count, wanted.len(), icons, groups);
        }
    }
}
