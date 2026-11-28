//! Sharp site icons. Engines report the small 16×16 tab icon; most sites also
//! publish larger ones (apple-touch-icon, sized `<link rel=icon>`, SVG, web-app
//! manifests). Sleet reads what the page declares, fetches the best one itself
//! (like any browser fetching favicons: no cookies, never for private tabs) and
//! sends it to the UI as a data URL, so the UI never contacts the site.

use base64::Engine;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Webview};

const MAX_BYTES: u64 = 512 * 1024;
const TIMEOUT: Duration = Duration::from_secs(6);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Sleet";

/// Icons found per origin this session (`None`: the site has no usable large icon).
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lists the icons a page declares (top document only).
const CANDIDATES_SCRIPT: &str = r#"(() => {
  const links = [...document.querySelectorAll('link[rel][href]')]
    .filter((link) => /(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed)(\s|$)/i.test(link.rel))
    .map((link) => ({ href: link.href, rel: link.rel.toLowerCase(), sizes: link.getAttribute('sizes') || '', type: (link.type || '').toLowerCase() }));
  const manifest = document.querySelector('link[rel~="manifest"][href]');
  return JSON.stringify({ links, manifest: manifest ? manifest.href : null });
})()"#;

#[derive(Deserialize)]
struct Declared {
    links: Vec<Candidate>,
    manifest: Option<String>,
}

#[derive(Deserialize, Clone)]
struct Candidate {
    href: String,
    #[serde(default)]
    rel: String,
    #[serde(default)]
    sizes: String,
    #[serde(default)]
    r#type: String,
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    icons: Vec<ManifestIcon>,
}

#[derive(Deserialize)]
struct ManifestIcon {
    src: String,
    #[serde(default)]
    sizes: String,
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    purpose: String,
}

/// Largest edge from a `sizes` attribute ("any" counts as scalable).
fn largest(sizes: &str) -> u32 {
    sizes
        .split_whitespace()
        .map(|size| if size.eq_ignore_ascii_case("any") { 512 } else { size.split(['x', 'X']).next().and_then(|edge| edge.parse().ok()).unwrap_or(0) })
        .max()
        .unwrap_or(0)
}

/// How good a candidate is for a ~64px icon (higher is better; 0 = skip).
fn score(href: &str, rel: &str, sizes: &str, kind: &str) -> u32 {
    let svg = kind.contains("svg") || href.split(['?', '#']).next().is_some_and(|path| path.ends_with(".svg"));
    if svg {
        return 900;
    }
    let edge = largest(sizes);
    let edge = if edge == 0 && rel.contains("apple-touch-icon") { 180 } else { edge };
    match edge {
        0 => 1,             // unknown size: maybe the 16px one
        1..=31 => 0,        // no better than what the engine already gave
        32..=47 => 300 + edge,
        48..=1024 => 600 + edge.min(256),
        _ => 400,           // huge: works, but heavy
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(3)
        .user_agent(USER_AGENT)
        .build()
        .into()
}

fn is_web(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// Image type from the file's first bytes (servers often send the wrong type).
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Some("image/png"); }
    if bytes.starts_with(b"\xff\xd8\xff") { return Some("image/jpeg"); }
    if bytes.starts_with(b"GIF8") { return Some("image/gif"); }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { return Some("image/webp"); }
    if bytes.starts_with(b"\x00\x00\x01\x00") { return Some("image/x-icon"); }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_lowercase();
    if head.trim_start().starts_with("<svg") || (head.trim_start().starts_with("<?xml") && head.contains("<svg")) {
        return Some("image/svg+xml");
    }
    None
}

fn fetch_image(agent: &ureq::Agent, url: &str) -> Option<String> {
    if !is_web(url) {
        return None;
    }
    let mut response = agent.get(url).header("Accept", "image/svg+xml,image/png,image/*;q=0.8").call().ok()?;
    let bytes = response.body_mut().with_config().limit(MAX_BYTES).read_to_vec().ok()?;
    let mime = sniff(&bytes)?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

fn manifest_candidates(agent: &ureq::Agent, manifest_url: &str) -> Vec<(u32, String)> {
    let Ok(base) = url::Url::parse(manifest_url) else { return Vec::new() };
    if !is_web(manifest_url) {
        return Vec::new();
    }
    let Some(manifest) = agent
        .get(manifest_url)
        .call()
        .ok()
        .and_then(|mut response| response.body_mut().with_config().limit(MAX_BYTES).read_to_vec().ok())
        .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
    else {
        return Vec::new();
    };
    manifest
        .icons
        .into_iter()
        // "monochrome" icons are single-color masks; "maskable" ones have extra padding.
        .filter(|icon| !icon.purpose.contains("monochrome"))
        .filter_map(|icon| {
            let href = base.join(&icon.src).ok()?.to_string();
            let mut points = score(&href, "", &icon.sizes, &icon.r#type);
            if icon.purpose.contains("maskable") && !icon.purpose.contains("any") {
                points = points.saturating_sub(200);
            }
            (points > 0).then_some((points, href))
        })
        .collect()
}

/// Finds and downloads the best large icon for the page's site.
fn find_best(origin: &str, declared: Declared) -> Option<String> {
    let agent = agent();
    let mut ranked: Vec<(u32, String)> = declared
        .links
        .iter()
        .filter_map(|link| {
            let points = score(&link.href, &link.rel, &link.sizes, &link.r#type);
            (points > 0).then(|| (points, link.href.clone()))
        })
        .collect();
    if let Some(manifest) = &declared.manifest {
        ranked.extend(manifest_candidates(&agent, manifest));
    }
    // Many sites serve this without declaring it.
    ranked.push((480, format!("{origin}/apple-touch-icon.png")));
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    ranked.dedup_by(|a, b| a.1 == b.1);
    ranked.into_iter().take(4).find_map(|(_, href)| fetch_image(&agent, &href))
}

/// The value of `name="…"` (or single-quoted, or bare) in one HTML tag.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let at = from + found;
        from = at + name.len();
        // A whole attribute name: preceded by whitespace, followed by `=`.
        if !lower[..at].ends_with(|c: char| c.is_ascii_whitespace()) {
            continue;
        }
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim_start();
        let value = match rest.chars().next() {
            Some(quote @ ('"' | '\'')) => rest[1..].split(quote).next().unwrap_or(""),
            _ => rest.split(|c: char| c.is_ascii_whitespace() || c == '>').next().unwrap_or(""),
        };
        return Some(value.replace("&amp;", "&"));
    }
    None
}

/// The icons a page's HTML declares, like CANDIDATES_SCRIPT does in a live page.
fn declared_in_html(html: &str, base: &url::Url) -> Declared {
    let mut links = Vec::new();
    let mut manifest = None;
    let lower = html.to_ascii_lowercase();
    let head_end = lower.find("</head>").unwrap_or(lower.len());
    let mut from = 0;
    while let Some(found) = lower[from..head_end].find("<link") {
        let start = from + found;
        let end = lower[start..head_end].find('>').map_or(head_end, |offset| start + offset);
        let tag = &html[start..end];
        from = end;
        let (Some(rel), Some(href)) = (attribute(tag, "rel"), attribute(tag, "href")) else { continue };
        let rel = rel.to_ascii_lowercase();
        let Ok(href) = base.join(&href) else { continue };
        if rel.split_whitespace().any(|part| part == "manifest") {
            manifest = Some(href.to_string());
        } else if rel.split_whitespace().any(|part| matches!(part, "icon" | "apple-touch-icon" | "apple-touch-icon-precomposed")) {
            links.push(Candidate {
                href: href.to_string(),
                rel,
                sizes: attribute(tag, "sizes").unwrap_or_default(),
                r#type: attribute(tag, "type").unwrap_or_default().to_ascii_lowercase(),
            });
        }
    }
    Declared { links, manifest }
}

/// An icon for a site that isn't open (bookmarks on the Home page): reads the
/// site's home page for declared icons, then tries the usual addresses. Like
/// any favicon request: no cookies; only the bookmarked site is contacted.
#[tauri::command]
pub async fn site_icon(url: String) -> Option<String> {
    let parsed = url::Url::parse(&url).ok().filter(|url| matches!(url.scheme(), "http" | "https"))?;
    let origin = crate::vault::origin_of(parsed.as_str())?;
    if let Some(found) = cache().lock().ok()?.get(&origin) {
        return found.clone();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = agent();
        let home = url::Url::parse(&format!("{origin}/")).ok()?;
        let declared = agent
            .get(home.as_str())
            .header("Accept", "text/html")
            .call()
            .ok()
            .and_then(|mut response| response.body_mut().with_config().limit(MAX_BYTES).read_to_vec().ok())
            .map(|bytes| declared_in_html(&String::from_utf8_lossy(&bytes), &home))
            .unwrap_or(Declared { links: Vec::new(), manifest: None });
        let icon = find_best(&origin, declared).or_else(|| fetch_image(&agent, &format!("{origin}/favicon.ico")));
        if let Ok(mut cache) = cache().lock() {
            cache.insert(origin, icon.clone());
        }
        icon
    })
    .await
    .ok()
    .flatten()
}

#[derive(Clone, serde::Serialize)]
struct HighResIcon {
    label: String,
    icon: String,
    /// Tells the UI this is the large icon, so the engine's small one never replaces it.
    sharp: bool,
}

fn emit(app: &AppHandle, label: &str, icon: &str) {
    let _ = app.emit("sleet-favicon", HighResIcon { label: label.into(), icon: icon.into(), sharp: true });
}

/// The large icon already found for this origin, if any (used instead of the engine's small one).
pub fn cached(origin: &str) -> Option<String> {
    cache().lock().ok()?.get(origin).cloned().flatten()
}

/// After a page loads: looks up (once per site per session) and sends its best large icon.
pub fn refresh(app: AppHandle, webview: Webview, label: String) {
    if crate::privacy::is_private(&label) {
        return;
    }
    let Some(origin) = webview.url().ok().and_then(|url| crate::vault::origin_of(url.as_str())) else { return };
    {
        let Ok(mut cache) = cache().lock() else { return };
        match cache.get(&origin) {
            Some(Some(icon)) => {
                let icon = icon.clone();
                drop(cache);
                emit(&app, &label, &icon);
                return;
            }
            Some(None) => return,
            None => {
                // Claimed: other loads of this site wait for this lookup.
                cache.insert(origin.clone(), None);
            }
        }
    }
    let (tx, rx) = mpsc::channel::<String>();
    if webview.eval_with_callback(CANDIDATES_SCRIPT, move |result| { let _ = tx.send(result); }).is_err() {
        if let Ok(mut cache) = cache().lock() { cache.remove(&origin); }
        return;
    }
    std::thread::spawn(move || {
        let declared = rx
            .recv_timeout(Duration::from_secs(5))
            .ok()
            // The script's value comes back JSON-encoded, so the JSON string may be wrapped once more.
            .map(|raw| serde_json::from_str::<String>(&raw).unwrap_or(raw))
            .and_then(|json| serde_json::from_str::<Declared>(&json).ok())
            .unwrap_or(Declared { links: Vec::new(), manifest: None });
        let icon = find_best(&origin, declared);
        if let Ok(mut cache) = cache().lock() {
            cache.insert(origin.clone(), icon.clone());
        }
        if let Some(icon) = icon {
            emit(&app, &label, &icon);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_icons_from_html() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/a.css">
            <link rel="icon" type="image/svg+xml" href="/icon.svg">
            <LINK REL='apple-touch-icon' sizes=180x180 href="touch.png?v=1&amp;x=2">
            <link href="/site.webmanifest" rel="manifest">
          </head><body><link rel="icon" href="/ignored.png"></body></html>"#;
        let base = url::Url::parse("https://example.com/").unwrap();
        let declared = declared_in_html(html, &base);
        let hrefs: Vec<_> = declared.links.iter().map(|link| link.href.as_str()).collect();
        assert_eq!(hrefs, ["https://example.com/icon.svg", "https://example.com/touch.png?v=1&x=2"]);
        assert_eq!(declared.links[1].sizes, "180x180");
        assert_eq!(declared.manifest.as_deref(), Some("https://example.com/site.webmanifest"));
    }

    #[test]
    fn prefers_large_and_scalable_icons() {
        assert!(score("https://a.test/icon.svg", "icon", "", "") > score("https://a.test/a.png", "apple-touch-icon", "180x180", ""));
        assert!(score("https://a.test/a.png", "apple-touch-icon", "", "") > score("https://a.test/b.png", "icon", "32x32", ""));
        assert_eq!(score("https://a.test/fav.ico", "icon", "16x16", ""), 0);
        assert_eq!(largest("16x16 32x32 192x192"), 192);
        assert_eq!(largest("any"), 512);
    }

    /// Live check against real sites: `cargo test --lib live_sites -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_sites() {
        let agent = agent();
        for site in ["https://github.com", "https://www.youtube.com", "https://www.wikipedia.org", "https://www.reddit.com", "https://news.ycombinator.com", "https://claude.ai"] {
            let html = agent.get(site).call().ok().and_then(|mut response| response.body_mut().with_config().limit(4 * MAX_BYTES).read_to_string().ok()).unwrap_or_default();
            let base = url::Url::parse(site).unwrap();
            // Rough stand-in for the page script: <link ... rel=...icon... href=...>.
            let tag = regex_lite_links(&html);
            let links = tag.iter().filter_map(|(rel, href, sizes, kind)| Some(Candidate { href: base.join(href).ok()?.to_string(), rel: rel.clone(), sizes: sizes.clone(), r#type: kind.clone() })).collect::<Vec<_>>();
            let manifest = tag_attr_manifest(&html).and_then(|href| base.join(&href).ok()).map(|url| url.to_string());
            let found = find_best(&crate::vault::origin_of(site).unwrap(), Declared { links, manifest });
            let summary = found.as_deref().map(|icon| format!("{} ({} KB)", &icon[..icon.find(';').unwrap_or(20)], icon.len() * 3 / 4 / 1024)).unwrap_or_else(|| "none".into());
            let pixels = found.as_deref().and_then(|icon| icon.split_once(",")).and_then(|(_, data)| base64::engine::general_purpose::STANDARD.decode(data).ok()).filter(|bytes| bytes.starts_with(b"\x89PNG") && bytes.len() > 24).map(|bytes| format!(" {}x{}", u32::from_be_bytes(bytes[16..20].try_into().unwrap()), u32::from_be_bytes(bytes[20..24].try_into().unwrap()))).unwrap_or_default();
            println!("{site}: {summary}{pixels}");
        }
    }

    fn attr(tag: &str, name: &str) -> String {
        let lower = tag.to_lowercase();
        let Some(at) = lower.find(&format!("{name}=")) else { return String::new() };
        let rest = &tag[at + name.len() + 1..];
        let quote = rest.chars().next().unwrap_or(' ');
        if quote == '"' || quote == '\'' { rest[1..].split(quote).next().unwrap_or("").to_string() } else { rest.split([' ', '>']).next().unwrap_or("").to_string() }
    }

    fn regex_lite_links(html: &str) -> Vec<(String, String, String, String)> {
        html.split("<link").skip(1).filter_map(|chunk| {
            let tag = chunk.split('>').next()?;
            let rel = attr(tag, "rel").to_lowercase();
            if !(rel.contains("icon")) || rel.contains("mask") { return None; }
            Some((rel, attr(tag, "href").replace("&amp;", "&"), attr(tag, "sizes"), attr(tag, "type")))
        }).collect()
    }

    fn tag_attr_manifest(html: &str) -> Option<String> {
        html.split("<link").skip(1).filter_map(|chunk| chunk.split('>').next()).find(|tag| attr(tag, "rel").contains("manifest")).map(|tag| attr(tag, "href"))
    }

    #[test]
    fn sniffs_real_image_types() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff(b"  <svg xmlns='http://www.w3.org/2000/svg'></svg>"), Some("image/svg+xml"));
        assert_eq!(sniff(b"<!doctype html><html>"), None);
        assert!(!is_web("file:///C:/x.png") && !is_web("javascript:alert(1)") && is_web("https://a.test/x.png"));
    }
}
