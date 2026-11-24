//! SQLite store for history and downloads. Settings stay in the chrome's
//! localStorage; this holds the lists that grow without bound.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};
use tauri::State;

pub struct Store(Mutex<Connection>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub title: String,
    pub url: String,
    pub visited_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub path: Option<String>,
    pub status: String,
    pub started_at: i64,
    pub received: Option<i64>,
    pub total: Option<i64>,
}

type Result<T> = std::result::Result<T, String>;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS history (
               id INTEGER PRIMARY KEY,
               url TEXT NOT NULL UNIQUE,
               title TEXT NOT NULL,
               visited_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS history_visited ON history (visited_at DESC);
             CREATE TABLE IF NOT EXISTS downloads (
               id TEXT PRIMARY KEY,
               filename TEXT NOT NULL,
               url TEXT NOT NULL,
               path TEXT,
               status TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               received INTEGER,
               total INTEGER
             );
             CREATE INDEX IF NOT EXISTS downloads_started ON downloads (started_at DESC);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS site_permissions (
               origin TEXT NOT NULL,
               kind TEXT NOT NULL,
               state TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY (origin, kind)
             );",
        )?;
        Ok(Self(Mutex::new(connection)))
    }

    pub(crate) fn with<T>(&self, run: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut connection = self.0.lock().map_err(err)?;
        run(&mut connection).map_err(err)
    }

    /// Saved answer (`allow` / `block`) for a site permission, if any.
    pub fn permission(&self, origin: &str, kind: &str) -> Result<Option<String>> {
        self.with(|c| {
            c.query_row("SELECT state FROM site_permissions WHERE origin = ?1 AND kind = ?2", [origin, kind], |row| row.get(0))
                .optional()
        })
    }

    pub fn set_permission(&self, origin: &str, kind: &str, state: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO site_permissions (origin, kind, state, updated_at) VALUES (?1, ?2, ?3, strftime('%s','now') * 1000)
                 ON CONFLICT (origin, kind) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
                [origin, kind, state],
            )
            .map(|_| ())
        })
    }

    pub fn download_path(&self, id: &str) -> Result<Option<String>> {
        self.with(|c| {
            c.query_row("SELECT path FROM downloads WHERE id = ?1", [id], |row| row.get::<_, Option<String>>(0))
                .optional()
                .map(Option::flatten)
        })
    }
}

fn upsert_history(c: &Connection, entry: &HistoryEntry) -> rusqlite::Result<i64> {
    c.query_row(
        "INSERT INTO history (url, title, visited_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (url) DO UPDATE SET title = excluded.title, visited_at = excluded.visited_at
         RETURNING id",
        params![entry.url, entry.title, entry.visited_at],
        |row| row.get(0),
    )
}

fn upsert_download(c: &Connection, record: &DownloadRecord) -> rusqlite::Result<usize> {
    c.execute(
        "INSERT INTO downloads (id, filename, url, path, status, started_at, received, total)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (id) DO UPDATE SET filename = excluded.filename, path = COALESCE(excluded.path, path),
           status = excluded.status, received = COALESCE(excluded.received, received),
           total = COALESCE(excluded.total, total)",
        params![
            record.id, record.filename, record.url, record.path, record.status,
            record.started_at, record.received, record.total
        ],
    )
}

#[tauri::command]
pub fn history_add(store: State<'_, Store>, url: String, title: String, visited_at: i64) -> Result<HistoryEntry> {
    let mut entry = HistoryEntry { id: String::new(), title, url, visited_at };
    let id = store.with(|c| upsert_history(c, &entry))?;
    entry.id = id.to_string();
    Ok(entry)
}

#[tauri::command]
pub fn history_list(store: State<'_, Store>, limit: i64, query: Option<String>) -> Result<Vec<HistoryEntry>> {
    let pattern = query
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", value.replace('%', "\\%").replace('_', "\\_")));
    store.with(|c| {
        let mut statement = c.prepare(
            "SELECT id, title, url, visited_at FROM history
             WHERE ?2 IS NULL OR title LIKE ?2 ESCAPE '\\' OR url LIKE ?2 ESCAPE '\\'
             ORDER BY visited_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit, pattern], |row| {
            Ok(HistoryEntry { id: row.get::<_, i64>(0)?.to_string(), title: row.get(1)?, url: row.get(2)?, visited_at: row.get(3)? })
        })?;
        rows.collect()
    })
}

/// Deletes history visited before `before` and/or since `since` (epoch ms).
/// Neither deletes everything.
#[tauri::command]
pub fn history_clear(store: State<'_, Store>, before: Option<i64>, since: Option<i64>) -> Result<usize> {
    store.with(|c| match (before, since) {
        (Some(before), _) => c.execute("DELETE FROM history WHERE visited_at < ?1", [before]),
        (None, Some(since)) => c.execute("DELETE FROM history WHERE visited_at >= ?1", [since]),
        (None, None) => c.execute("DELETE FROM history", []),
    })
}

#[tauri::command]
pub fn history_delete(store: State<'_, Store>, id: String) -> Result<usize> {
    let id: i64 = id.parse().map_err(err)?;
    store.with(|c| c.execute("DELETE FROM history WHERE id = ?1", [id]))
}

#[tauri::command]
pub fn download_delete(store: State<'_, Store>, id: String) -> Result<usize> {
    store.with(|c| c.execute("DELETE FROM downloads WHERE id = ?1", [id]))
}

#[tauri::command]
pub fn download_put(store: State<'_, Store>, record: DownloadRecord) -> Result<()> {
    store.with(|c| upsert_download(c, &record).map(|_| ()))
}

#[tauri::command]
pub fn downloads_list(store: State<'_, Store>, limit: i64) -> Result<Vec<DownloadRecord>> {
    store.with(|c| {
        let mut statement = c.prepare(
            "SELECT id, filename, url, path, status, started_at, received, total
             FROM downloads ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit], |row| {
            Ok(DownloadRecord {
                id: row.get(0)?, filename: row.get(1)?, url: row.get(2)?, path: row.get(3)?,
                status: row.get(4)?, started_at: row.get(5)?, received: row.get(6)?, total: row.get(7)?,
            })
        })?;
        rows.collect()
    })
}

#[tauri::command]
pub fn downloads_clear(store: State<'_, Store>, completed_only: bool, since: Option<i64>) -> Result<usize> {
    store.with(|c| match (completed_only, since) {
        (true, _) => c.execute("DELETE FROM downloads WHERE status = 'complete'", []),
        (false, Some(since)) => c.execute("DELETE FROM downloads WHERE started_at >= ?1 AND status != 'active'", [since]),
        (false, None) => c.execute("DELETE FROM downloads WHERE status != 'active'", []),
    })
}

/// One-time move of the lists Sleet used to keep in localStorage.
#[tauri::command]
pub fn import_legacy(store: State<'_, Store>, history: Vec<HistoryEntry>, downloads: Vec<DownloadRecord>) -> Result<bool> {
    store.with(|c| {
        let done: Option<String> = c.query_row("SELECT value FROM meta WHERE key = 'legacy_imported'", [], |row| row.get(0)).optional()?;
        if done.is_some() {
            return Ok(false);
        }
        let tx = c.transaction()?;
        for entry in &history {
            upsert_history(&tx, entry)?;
        }
        for record in &downloads {
            upsert_download(&tx, record)?;
        }
        tx.execute("INSERT INTO meta (key, value) VALUES ('legacy_imported', '1')", [])?;
        tx.commit()?;
        Ok(true)
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePermission {
    pub origin: String,
    pub kind: String,
    pub state: String,
    pub updated_at: i64,
}

/// Saved site permissions, optionally for one site.
#[tauri::command]
pub fn permissions_list(store: State<'_, Store>, origin: Option<String>) -> Result<Vec<SitePermission>> {
    store.with(|c| {
        let mut statement = c.prepare(
            "SELECT origin, kind, state, updated_at FROM site_permissions
             WHERE ?1 IS NULL OR origin = ?1 ORDER BY origin, kind",
        )?;
        let rows = statement.query_map([origin], |row| {
            Ok(SitePermission { origin: row.get(0)?, kind: row.get(1)?, state: row.get(2)?, updated_at: row.get(3)? })
        })?;
        rows.collect()
    })
}

#[tauri::command]
pub fn permission_set(app: tauri::AppHandle, store: State<'_, Store>, origin: String, kind: String, state: String) -> Result<()> {
    if state != "allow" && state != "block" {
        return Err("state must be allow or block".into());
    }
    // WebView2 must ask again so Sleet's answer is the one applied.
    if let Ok(chrome) = crate::chrome_webview(&app) {
        crate::privacy::forget_engine_permission(&chrome, origin.clone(), Some(kind.clone()));
    }
    store.set_permission(&origin, &kind, &state)
}

/// Forgets a saved answer so the site is asked again. `kind: None` forgets all for the site.
#[tauri::command]
pub fn permission_delete(app: tauri::AppHandle, store: State<'_, Store>, origin: String, kind: Option<String>) -> Result<usize> {
    if let Ok(chrome) = crate::chrome_webview(&app) {
        crate::privacy::forget_engine_permission(&chrome, origin.clone(), kind.clone());
    }
    store.with(|c| match kind {
        Some(kind) => c.execute("DELETE FROM site_permissions WHERE origin = ?1 AND kind = ?2", [origin, kind]),
        None => c.execute("DELETE FROM site_permissions WHERE origin = ?1", [origin]),
    })
}

/// Sleet's own saved state (tabs, settings, layout). Kept here rather than
/// in the webview's storage so clearing site data can never touch it.
#[tauri::command]
pub fn kv_all(store: State<'_, Store>) -> Result<std::collections::HashMap<String, String>> {
    store.with(|c| {
        let mut statement = c.prepare("SELECT key, value FROM kv")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        rows.collect()
    })
}

#[tauri::command]
pub fn kv_set(store: State<'_, Store>, key: String, value: String) -> Result<()> {
    store.with(|c| {
        c.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value])
            .map(|_| ())
    })
}

#[tauri::command]
pub fn kv_set_many(store: State<'_, Store>, entries: std::collections::HashMap<String, String>) -> Result<()> {
    store.with(|c| {
        let tx = c.transaction()?;
        for (key, value) in &entries {
            tx.execute("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value])?;
        }
        tx.commit()
    })
}

/// Removes every key starting with `prefix` (used by Reset Sleet).
#[tauri::command]
pub fn kv_delete_prefix(store: State<'_, Store>, prefix: String) -> Result<usize> {
    store.with(|c| c.execute("DELETE FROM kv WHERE substr(key, 1, length(?1)) = ?1", [prefix]))
}
