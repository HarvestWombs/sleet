//! Sleet's password vault.
//!
//! Design (no custom cryptography; RustCrypto primitives only):
//! - A random 256-bit **vault key** encrypts every entry with XChaCha20-Poly1305
//!   (AEAD). Each ciphertext is bound to its entry id and field through the
//!   associated data, so blobs can't be swapped between entries or fields.
//! - The vault key is stored **wrapped** (encrypted) under a key derived from
//!   the master password with Argon2id (64 MiB, 3 passes). Without the master
//!   password the database holds nothing usable.
//! - Entry metadata (site, username, title) and secrets (password, notes) are
//!   encrypted separately: unlocking decrypts only the metadata into memory;
//!   a password is decrypted at the moment it is filled, copied or revealed.
//! - The key lives in memory only while unlocked and is wiped (zeroize) on
//!   lock, which also happens automatically after a period of inactivity.
//! - Optional "remember on this device" keeps the vault key in the operating
//!   system's secure store (Windows Credential Manager, macOS Keychain, Linux
//!   Secret Service) via the `keyring` crate.
//! - Wrong master passwords are slowed further with an increasing delay.
//!
//! Decrypted passwords never go to the chrome's JavaScript except when the
//! user explicitly reveals one; filling and copying happen here in Rust.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::store::Store;

const FORMAT_VERSION: i64 = 1;
const AAD_PREFIX: &str = "sleet-vault-v1";
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
/// Argon2id cost: 64 MiB, 3 passes, 1 lane (OWASP-recommended range).
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_PASSES: u32 = 3;
const KDF_LANES: u32 = 1;
pub const MIN_MASTER_LEN: usize = 8;
const KEYRING_SERVICE: &str = "Sleet";
const PENDING_TTL: Duration = Duration::from_secs(180);

type VaultKey = Zeroizing<[u8; KEY_LEN]>;
pub type Result<T> = std::result::Result<T, String>;

/// Site, username and label: decrypted into memory while unlocked.
#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct EntryMeta {
    pub id: String,
    pub origin: String,
    pub username: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Password and notes: decrypted only when used, wiped when dropped.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop, Default)]
struct Secret {
    password: String,
    #[serde(default)]
    notes: String,
}

/// A login a page submitted, held here (never sent to the UI) until the user
/// chooses Save, Never or dismisses it.
#[derive(Zeroize, ZeroizeOnDrop)]
struct PendingLogin {
    #[zeroize(skip)]
    created: Instant,
    origin: String,
    username: String,
    password: String,
}

struct Unlocked {
    key: VaultKey,
    index: Vec<EntryMeta>,
}

struct Inner {
    unlocked: Option<Unlocked>,
    last_used: Instant,
    auto_lock: Option<Duration>,
    failures: u32,
    retry_after: Option<Instant>,
    pending: HashMap<String, PendingLogin>,
}

pub struct Vault(Mutex<Inner>);

impl Default for Vault {
    fn default() -> Self {
        Vault(Mutex::new(Inner {
            unlocked: None,
            last_used: Instant::now(),
            auto_lock: Some(Duration::from_secs(15 * 60)),
            failures: 0,
            retry_after: None,
            pending: HashMap::new(),
        }))
    }
}

// ---------------------------------------------------------------- crypto

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn new_id() -> String {
    random_bytes::<12>().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn derive_key(password: &str, salt: &[u8], memory: u32, passes: u32, lanes: u32) -> Result<VaultKey> {
    let params = Params::new(memory, passes, lanes, Some(KEY_LEN)).map_err(|error| error.to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key: VaultKey = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|error| error.to_string())?;
    Ok(key)
}

fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &str) -> Result<(Vec<u8>, Vec<u8>)> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad: aad.as_bytes() })
        .map_err(|_| "encryption failed".to_string())?;
    Ok((nonce.to_vec(), ciphertext))
}

fn open(key: &[u8; KEY_LEN], nonce: &[u8], ciphertext: &[u8], aad: &str) -> Result<Zeroizing<Vec<u8>>> {
    if nonce.len() != 24 {
        return Err("corrupt vault data".into());
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad: aad.as_bytes() })
        .map(Zeroizing::new)
        .map_err(|_| "decryption failed".to_string())
}

fn aad(kind: &str, id: &str) -> String {
    format!("{AAD_PREFIX}:{kind}:{id}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or_default()
}

/// `scheme://host[:port]` for a site address (exact-origin matching for fills).
pub fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_lowercase();
    Some(match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    })
}

// ---------------------------------------------------------------- storage

pub fn create_tables(store: &Store) -> Result<()> {
    store.with(|c| {
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS vault_meta (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               version INTEGER NOT NULL,
               kdf_memory INTEGER NOT NULL,
               kdf_passes INTEGER NOT NULL,
               kdf_lanes INTEGER NOT NULL,
               salt BLOB NOT NULL,
               key_nonce BLOB NOT NULL,
               wrapped_key BLOB NOT NULL,
               check_nonce BLOB NOT NULL,
               check_value BLOB NOT NULL,
               vault_id TEXT NOT NULL,
               remember INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS vault_entries (
               id TEXT PRIMARY KEY,
               meta_nonce BLOB NOT NULL,
               meta BLOB NOT NULL,
               secret_nonce BLOB NOT NULL,
               secret BLOB NOT NULL,
               updated_at INTEGER NOT NULL
             );",
        )
    })
}

struct MetaRow {
    memory: u32,
    passes: u32,
    lanes: u32,
    salt: Vec<u8>,
    key_nonce: Vec<u8>,
    wrapped_key: Vec<u8>,
    check_nonce: Vec<u8>,
    check_value: Vec<u8>,
    vault_id: String,
    remember: bool,
}

fn meta_row(store: &Store) -> Result<Option<MetaRow>> {
    store.with(|c| {
        c.query_row(
            "SELECT kdf_memory, kdf_passes, kdf_lanes, salt, key_nonce, wrapped_key, check_nonce, check_value, vault_id, remember FROM vault_meta WHERE id = 1",
            [],
            |row| {
                Ok(MetaRow {
                    memory: row.get(0)?,
                    passes: row.get(1)?,
                    lanes: row.get(2)?,
                    salt: row.get(3)?,
                    key_nonce: row.get(4)?,
                    wrapped_key: row.get(5)?,
                    check_nonce: row.get(6)?,
                    check_value: row.get(7)?,
                    vault_id: row.get(8)?,
                    remember: row.get::<_, i64>(9)? != 0,
                })
            },
        )
        .optional()
    })
}

const CHECK_PLAINTEXT: &[u8] = b"sleet vault key check";

/// Unwraps the vault key with the master password (None = wrong password).
fn unwrap_with_password(row: &MetaRow, password: &str) -> Result<Option<VaultKey>> {
    let kek = derive_key(password, &row.salt, row.memory, row.passes, row.lanes)?;
    match open(&kek, &row.key_nonce, &row.wrapped_key, &aad("key", &row.vault_id)) {
        Ok(bytes) if bytes.len() == KEY_LEN => {
            let mut key: VaultKey = Zeroizing::new([0u8; KEY_LEN]);
            key.copy_from_slice(&bytes);
            Ok(Some(key))
        }
        _ => Ok(None),
    }
}

fn key_matches(row: &MetaRow, key: &[u8; KEY_LEN]) -> bool {
    open(key, &row.check_nonce, &row.check_value, &aad("check", &row.vault_id))
        .map(|bytes| bytes.as_slice() == CHECK_PLAINTEXT)
        .unwrap_or(false)
}

fn load_index(store: &Store, key: &[u8; KEY_LEN]) -> Result<Vec<EntryMeta>> {
    let rows: Vec<(String, Vec<u8>, Vec<u8>)> = store.with(|c| {
        let mut statement = c.prepare("SELECT id, meta_nonce, meta FROM vault_entries")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        rows.collect()
    })?;
    let mut index = Vec::with_capacity(rows.len());
    for (id, nonce, blob) in rows {
        let bytes = open(key, &nonce, &blob, &aad("meta", &id))?;
        let meta: EntryMeta = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if meta.id != id {
            return Err("corrupt vault entry".into());
        }
        index.push(meta);
    }
    index.sort_by(|a, b| a.origin.cmp(&b.origin).then(a.username.cmp(&b.username)));
    Ok(index)
}

fn write_entry(store: &Store, key: &[u8; KEY_LEN], meta: &EntryMeta, secret: &Secret) -> Result<()> {
    let meta_json = Zeroizing::new(serde_json::to_vec(meta).map_err(|error| error.to_string())?);
    let secret_json = Zeroizing::new(serde_json::to_vec(secret).map_err(|error| error.to_string())?);
    let (meta_nonce, meta_blob) = seal(key, &meta_json, &aad("meta", &meta.id))?;
    let (secret_nonce, secret_blob) = seal(key, &secret_json, &aad("secret", &meta.id))?;
    store.with(|c| {
        c.execute(
            "INSERT INTO vault_entries (id, meta_nonce, meta, secret_nonce, secret, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET meta_nonce = excluded.meta_nonce, meta = excluded.meta,
               secret_nonce = excluded.secret_nonce, secret = excluded.secret, updated_at = excluded.updated_at",
            params![meta.id, meta_nonce, meta_blob, secret_nonce, secret_blob, meta.updated_at],
        )
        .map(|_| ())
    })
}

fn read_secret(store: &Store, key: &[u8; KEY_LEN], id: &str) -> Result<Secret> {
    let (nonce, blob): (Vec<u8>, Vec<u8>) = store
        .with(|c| c.query_row("SELECT secret_nonce, secret FROM vault_entries WHERE id = ?1", [id], |row| Ok((row.get(0)?, row.get(1)?))).optional())?
        .ok_or("that login no longer exists")?;
    let bytes = open(key, &nonce, &blob, &aad("secret", id))?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------- device store

fn keyring_entry(vault_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("vault-key-{vault_id}")).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------- operations

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub remembered: bool,
    pub count: usize,
    /// Seconds until another unlock attempt is allowed (after wrong passwords).
    pub retry_in: u64,
}

/// Fields for adding or editing a login. Secret fields wipe themselves on drop.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<Zeroizing<String>>,
    pub title: Option<String>,
    pub notes: Option<Zeroizing<String>>,
}

fn secret_text(value: &str) -> Option<Zeroizing<String>> {
    Some(Zeroizing::new(value.to_string()))
}

/// Result of a page submitting a login: whether to offer Save or Update.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginOffer {
    pub pending_id: String,
    pub origin: String,
    pub username: String,
    /// `new`, `update` or `locked` (can't compare until unlocked).
    pub kind: &'static str,
}

impl Vault {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    fn with_unlocked<T>(&self, run: impl FnOnce(&mut Unlocked) -> Result<T>) -> Result<T> {
        let mut inner = self.inner();
        inner.last_used = Instant::now();
        let unlocked = inner.unlocked.as_mut().ok_or("passwords are locked")?;
        run(unlocked)
    }

    pub fn status(&self, store: &Store) -> Result<VaultStatus> {
        let row = meta_row(store)?;
        let inner = self.inner();
        Ok(VaultStatus {
            exists: row.is_some(),
            unlocked: inner.unlocked.is_some(),
            remembered: row.as_ref().is_some_and(|row| row.remember),
            count: inner.unlocked.as_ref().map(|unlocked| unlocked.index.len()).unwrap_or(0),
            retry_in: inner.retry_after.map(|at| at.saturating_duration_since(Instant::now()).as_secs()).unwrap_or(0),
        })
    }

    /// Creates a new, empty vault protected by `password`, and unlocks it.
    pub fn create(&self, store: &Store, password: &str) -> Result<()> {
        if meta_row(store)?.is_some() {
            return Err("a password vault already exists".into());
        }
        if password.chars().count() < MIN_MASTER_LEN {
            return Err(format!("the master password must be at least {MIN_MASTER_LEN} characters"));
        }
        let vault_id = new_id();
        let salt = random_bytes::<SALT_LEN>();
        let kek = derive_key(password, &salt, KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES)?;
        let key: VaultKey = Zeroizing::new(random_bytes::<KEY_LEN>());
        let (key_nonce, wrapped) = seal(&kek, key.as_ref(), &aad("key", &vault_id))?;
        let (check_nonce, check) = seal(&key, CHECK_PLAINTEXT, &aad("check", &vault_id))?;
        store.with(|c| {
            c.execute(
                "INSERT INTO vault_meta (id, version, kdf_memory, kdf_passes, kdf_lanes, salt, key_nonce, wrapped_key, check_nonce, check_value, vault_id, remember, created_at)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11)",
                params![FORMAT_VERSION, KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES, salt.to_vec(), key_nonce, wrapped, check_nonce, check, vault_id, now_ms()],
            )
            .map(|_| ())
        })?;
        let mut inner = self.inner();
        inner.unlocked = Some(Unlocked { key, index: Vec::new() });
        inner.last_used = Instant::now();
        Ok(())
    }

    /// Unlocks with the master password, slowing down repeated wrong guesses.
    pub fn unlock(&self, store: &Store, password: &str) -> Result<()> {
        {
            let inner = self.inner();
            if let Some(at) = inner.retry_after.filter(|at| *at > Instant::now()) {
                return Err(format!("too many wrong passwords; try again in {} seconds", at.saturating_duration_since(Instant::now()).as_secs().max(1)));
            }
        }
        let row = meta_row(store)?.ok_or("there is no password vault yet")?;
        let Some(key) = unwrap_with_password(&row, password)? else {
            let mut inner = self.inner();
            inner.failures += 1;
            if inner.failures >= 3 {
                let delay = 2u64.saturating_pow(inner.failures - 3).min(60);
                inner.retry_after = Some(Instant::now() + Duration::from_secs(delay));
            }
            return Err("wrong master password".into());
        };
        self.finish_unlock(store, key)
    }

    /// Unlocks with the key kept in the OS secure store ("remember on this device").
    pub fn unlock_with_device(&self, store: &Store) -> Result<()> {
        let row = meta_row(store)?.ok_or("there is no password vault yet")?;
        if !row.remember {
            return Err("this device isn't remembered".into());
        }
        let stored = Zeroizing::new(keyring_entry(&row.vault_id)?.get_secret().map_err(|error| error.to_string())?);
        if stored.len() != KEY_LEN {
            return Err("the remembered key is invalid".into());
        }
        let mut key: VaultKey = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(&stored);
        if !key_matches(&row, &key) {
            return Err("the remembered key doesn't match this vault".into());
        }
        self.finish_unlock(store, key)
    }

    fn finish_unlock(&self, store: &Store, key: VaultKey) -> Result<()> {
        let index = load_index(store, &key)?;
        let mut inner = self.inner();
        inner.unlocked = Some(Unlocked { key, index });
        inner.failures = 0;
        inner.retry_after = None;
        inner.last_used = Instant::now();
        Ok(())
    }

    /// Forgets the key and decrypted metadata (both are wiped on drop).
    pub fn lock(&self) {
        let mut inner = self.inner();
        inner.unlocked = None;
    }

    /// Locks if unused for longer than the auto-lock period. Returns true if it locked.
    pub fn lock_if_idle(&self) -> bool {
        let mut inner = self.inner();
        let idle = inner.auto_lock.is_some_and(|limit| inner.last_used.elapsed() >= limit);
        inner.pending.retain(|_, pending| pending.created.elapsed() < PENDING_TTL);
        if idle && inner.unlocked.is_some() {
            inner.unlocked = None;
            return true;
        }
        false
    }

    pub fn set_auto_lock(&self, minutes: u64) {
        self.inner().auto_lock = (minutes > 0).then(|| Duration::from_secs(minutes * 60));
    }

    /// Checks the master password without changing the lock state (for reveal/export).
    fn verify_password(&self, store: &Store, password: &str) -> Result<()> {
        let row = meta_row(store)?.ok_or("there is no password vault yet")?;
        match unwrap_with_password(&row, password)? {
            Some(key) if self.with_unlocked(|unlocked| Ok(unlocked.key.as_ref() == key.as_ref()))? => Ok(()),
            _ => Err("wrong master password".into()),
        }
    }

    /// Re-wraps the same vault key under a new master password.
    pub fn change_password(&self, store: &Store, current: &str, next: &str) -> Result<()> {
        if next.chars().count() < MIN_MASTER_LEN {
            return Err(format!("the master password must be at least {MIN_MASTER_LEN} characters"));
        }
        let row = meta_row(store)?.ok_or("there is no password vault yet")?;
        let key = unwrap_with_password(&row, current)?.ok_or("wrong master password")?;
        let salt = random_bytes::<SALT_LEN>();
        let kek = derive_key(next, &salt, KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES)?;
        let (key_nonce, wrapped) = seal(&kek, key.as_ref(), &aad("key", &row.vault_id))?;
        store.with(|c| {
            c.execute(
                "UPDATE vault_meta SET salt = ?1, key_nonce = ?2, wrapped_key = ?3, kdf_memory = ?4, kdf_passes = ?5, kdf_lanes = ?6 WHERE id = 1",
                params![salt.to_vec(), key_nonce, wrapped, KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES],
            )
            .map(|_| ())
        })
    }

    /// Keeps (or forgets) the vault key in the OS secure store.
    pub fn set_remember(&self, store: &Store, remember: bool) -> Result<()> {
        let row = meta_row(store)?.ok_or("there is no password vault yet")?;
        let entry = keyring_entry(&row.vault_id)?;
        if remember {
            let key = self.with_unlocked(|unlocked| Ok(Zeroizing::new(unlocked.key.to_vec())))?;
            entry.set_secret(&key).map_err(|error| format!("couldn't save to this device's secure store: {error}"))?;
        } else {
            let _ = entry.delete_credential();
        }
        store.with(|c| c.execute("UPDATE vault_meta SET remember = ?1 WHERE id = 1", [remember as i64]).map(|_| ()))
    }

    /// Deletes the vault and everything in it (forgotten master password).
    pub fn reset(&self, store: &Store) -> Result<()> {
        if let Some(row) = meta_row(store)? {
            if let Ok(entry) = keyring_entry(&row.vault_id) {
                let _ = entry.delete_credential();
            }
        }
        store.with(|c| c.execute_batch("DELETE FROM vault_entries; DELETE FROM vault_meta;"))?;
        let mut inner = self.inner();
        inner.unlocked = None;
        inner.pending.clear();
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<EntryMeta>> {
        self.with_unlocked(|unlocked| Ok(unlocked.index.clone()))
    }

    /// Logins saved for exactly this origin.
    pub fn matches(&self, origin: &str) -> Result<Vec<EntryMeta>> {
        self.with_unlocked(|unlocked| Ok(unlocked.index.iter().filter(|meta| meta.origin == origin).cloned().collect()))
    }

    pub fn add(&self, store: &Store, input: &EntryInput) -> Result<EntryMeta> {
        let origin = input.url.as_deref().and_then(origin_of).ok_or("enter the site's address (https://…)")?;
        let password = input.password.clone().unwrap_or_default();
        if password.is_empty() {
            return Err("enter a password".into());
        }
        self.with_unlocked(|unlocked| {
            let now = now_ms();
            let meta = EntryMeta {
                id: new_id(),
                origin: origin.clone(),
                username: input.username.clone().unwrap_or_default(),
                title: input.title.clone().filter(|title| !title.trim().is_empty()).unwrap_or_else(|| origin.split("://").nth(1).unwrap_or(&origin).to_string()),
                created_at: now,
                updated_at: now,
            };
            let secret = Secret { password: password.to_string(), notes: input.notes.as_deref().cloned().unwrap_or_default() };
            write_entry(store, &unlocked.key, &meta, &secret)?;
            unlocked.index.push(meta.clone());
            unlocked.index.sort_by(|a, b| a.origin.cmp(&b.origin).then(a.username.cmp(&b.username)));
            Ok(meta)
        })
    }

    pub fn update(&self, store: &Store, id: &str, input: &EntryInput) -> Result<EntryMeta> {
        self.with_unlocked(|unlocked| {
            let position = unlocked.index.iter().position(|meta| meta.id == id).ok_or("that login no longer exists")?;
            let mut meta = unlocked.index[position].clone();
            let mut secret = read_secret(store, &unlocked.key, id)?;
            if let Some(url) = &input.url {
                meta.origin = origin_of(url).ok_or("enter the site's address (https://…)")?;
            }
            if let Some(username) = &input.username { meta.username = username.clone(); }
            if let Some(title) = &input.title { meta.title = title.clone(); }
            if let Some(password) = input.password.as_ref().filter(|password| !password.is_empty()) { secret.password = password.to_string(); }
            if let Some(notes) = &input.notes { secret.notes = notes.to_string(); }
            meta.updated_at = now_ms();
            write_entry(store, &unlocked.key, &meta, &secret)?;
            unlocked.index[position] = meta.clone();
            Ok(meta)
        })
    }

    pub fn delete(&self, store: &Store, id: &str) -> Result<()> {
        self.with_unlocked(|unlocked| {
            store.with(|c| c.execute("DELETE FROM vault_entries WHERE id = ?1", [id]).map(|_| ()))?;
            unlocked.index.retain(|meta| meta.id != id);
            Ok(())
        })
    }

    /// Password and notes for display, after re-entering the master password.
    pub fn reveal(&self, store: &Store, id: &str, master: &str) -> Result<(String, String)> {
        self.verify_password(store, master)?;
        self.with_unlocked(|unlocked| {
            let secret = read_secret(store, &unlocked.key, id)?;
            Ok((secret.password.clone(), secret.notes.clone()))
        })
    }

    /// Username and password for filling (exact origin checked by the caller).
    pub fn credentials(&self, store: &Store, id: &str) -> Result<(EntryMeta, Zeroizing<String>)> {
        self.with_unlocked(|unlocked| {
            let meta = unlocked.index.iter().find(|meta| meta.id == id).cloned().ok_or("that login no longer exists")?;
            let secret = read_secret(store, &unlocked.key, id)?;
            Ok((meta, Zeroizing::new(secret.password.clone())))
        })
    }

    /// Stores a submitted login until the user decides; says whether it's new.
    pub fn offer(&self, origin: &str, username: &str, password: &str) -> Option<LoginOffer> {
        let mut inner = self.inner();
        inner.pending.retain(|_, pending| pending.created.elapsed() < PENDING_TTL);
        // The same submission often arrives twice (click and submit): keep one.
        if inner.pending.values().any(|pending| pending.origin == origin && pending.username == username && pending.password == password) {
            return None;
        }
        let kind = match &inner.unlocked {
            None => "locked",
            Some(unlocked) => match unlocked.index.iter().find(|meta| meta.origin == origin && meta.username == username) {
                None => "new",
                Some(_) => "update",
            },
        };
        let pending_id = new_id();
        inner.pending.insert(pending_id.clone(), PendingLogin { created: Instant::now(), origin: origin.into(), username: username.into(), password: password.into() });
        Some(LoginOffer { pending_id, origin: origin.into(), username: username.into(), kind })
    }

    /// For an "update" offer: whether the submitted password differs from the saved one.
    pub fn offer_changes_password(&self, store: &Store, pending_id: &str) -> Result<bool> {
        let (origin, username, password) = {
            let inner = self.inner();
            let pending = inner.pending.get(pending_id).ok_or("that login is no longer waiting")?;
            (pending.origin.clone(), pending.username.clone(), Zeroizing::new(pending.password.clone()))
        };
        let existing = self.with_unlocked(|unlocked| Ok(unlocked.index.iter().find(|meta| meta.origin == origin && meta.username == username).map(|meta| meta.id.clone())))?;
        match existing {
            None => Ok(true),
            Some(id) => Ok(self.with_unlocked(|unlocked| read_secret(store, &unlocked.key, &id))?.password.as_str() != password.as_str()),
        }
    }

    /// Re-checks a pending offer after unlocking.
    pub fn recheck_offer(&self, pending_id: &str) -> Result<LoginOffer> {
        let inner = self.inner();
        let pending = inner.pending.get(pending_id).ok_or("that login is no longer waiting")?;
        let unlocked = inner.unlocked.as_ref().ok_or("passwords are locked")?;
        let exists = unlocked.index.iter().any(|meta| meta.origin == pending.origin && meta.username == pending.username);
        Ok(LoginOffer { pending_id: pending_id.into(), origin: pending.origin.clone(), username: pending.username.clone(), kind: if exists { "update" } else { "new" } })
    }

    /// Saves (or updates) a pending login. `discard` drops it instead.
    pub fn resolve_offer(&self, store: &Store, pending_id: &str, discard: bool) -> Result<()> {
        let pending = self.inner().pending.remove(pending_id).ok_or("that login is no longer waiting")?;
        if discard {
            return Ok(());
        }
        let existing = self.with_unlocked(|unlocked| Ok(unlocked.index.iter().find(|meta| meta.origin == pending.origin && meta.username == pending.username).map(|meta| meta.id.clone())))?;
        let input = EntryInput { url: Some(pending.origin.clone()), username: Some(pending.username.clone()), password: secret_text(&pending.password), ..Default::default() };
        match existing {
            Some(id) => self.update(store, &id, &input).map(|_| ()),
            None => self.add(store, &input).map(|_| ()),
        }
    }

    /// Adds logins in bulk (imports), skipping ones already saved with the same
    /// site, username and password. Returns (added, updated, skipped).
    pub fn add_many(&self, store: &Store, logins: Vec<(String, String, Zeroizing<String>, String, String)>) -> Result<(usize, usize, usize)> {
        let (mut added, mut updated, mut skipped) = (0, 0, 0);
        for (url, username, password, title, notes) in logins {
            let Some(origin) = origin_of(&url) else { skipped += 1; continue };
            if password.is_empty() { skipped += 1; continue; }
            let existing = self.with_unlocked(|unlocked| Ok(unlocked.index.iter().find(|meta| meta.origin == origin && meta.username == username).map(|meta| meta.id.clone())))?;
            let input = EntryInput { url: Some(origin), username: Some(username), password: Some(password.clone()), title: Some(title), notes: secret_text(&notes) };
            match existing {
                Some(id) => {
                    let same = self.with_unlocked(|unlocked| read_secret(store, &unlocked.key, &id))?.password.as_str() == password.as_str();
                    if same { skipped += 1; } else { self.update(store, &id, &input)?; updated += 1; }
                }
                None => { self.add(store, &input)?; added += 1; }
            }
        }
        Ok((added, updated, skipped))
    }

    /// Every login with its secret, for backups and CSV export (after re-auth).
    fn export_all(&self, store: &Store, master: &str) -> Result<Vec<ExportedLogin>> {
        self.verify_password(store, master)?;
        self.with_unlocked(|unlocked| {
            unlocked.index.iter().map(|meta| {
                let secret = read_secret(store, &unlocked.key, &meta.id)?;
                Ok(ExportedLogin { url: meta.origin.clone(), username: meta.username.clone(), password: secret.password.clone(), title: meta.title.clone(), notes: secret.notes.clone() })
            }).collect()
        })
    }
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct ExportedLogin {
    url: String,
    username: String,
    password: String,
    title: String,
    notes: String,
}

// ---------------------------------------------------------------- backups and CSV

/// An encrypted, portable backup protected by the master password.
#[derive(Serialize, Deserialize)]
struct Backup {
    format: String,
    version: i64,
    kdf: (u32, u32, u32),
    salt: String,
    nonce: String,
    data: String,
}

const BACKUP_FORMAT: &str = "sleet-vault-backup";

fn b64() -> base64::engine::GeneralPurpose { base64::engine::general_purpose::STANDARD }

impl Vault {
    pub fn export_backup(&self, store: &Store, master: &str) -> Result<String> {
        use base64::Engine;
        let logins = self.export_all(store, master)?;
        let plaintext = Zeroizing::new(serde_json::to_vec(&logins).map_err(|error| error.to_string())?);
        let salt = random_bytes::<SALT_LEN>();
        let key = derive_key(master, &salt, KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES)?;
        let (nonce, data) = seal(&key, &plaintext, &aad("backup", BACKUP_FORMAT))?;
        serde_json::to_string_pretty(&Backup {
            format: BACKUP_FORMAT.into(),
            version: FORMAT_VERSION,
            kdf: (KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES),
            salt: b64().encode(salt),
            nonce: b64().encode(nonce),
            data: b64().encode(data),
        })
        .map_err(|error| error.to_string())
    }

    /// Imports a Sleet backup made with `password` (which may be an older master password).
    pub fn import_backup(&self, store: &Store, text: &str, password: &str) -> Result<(usize, usize, usize)> {
        use base64::Engine;
        let backup: Backup = serde_json::from_str(text).map_err(|_| "that isn't a Sleet password backup")?;
        if backup.format != BACKUP_FORMAT {
            return Err("that isn't a Sleet password backup".into());
        }
        let (memory, passes, lanes) = backup.kdf;
        if memory > 1024 * 1024 || passes > 20 || lanes > 16 {
            return Err("that backup's settings are out of range".into());
        }
        let salt = b64().decode(&backup.salt).map_err(|_| "corrupt backup")?;
        let nonce = b64().decode(&backup.nonce).map_err(|_| "corrupt backup")?;
        let data = b64().decode(&backup.data).map_err(|_| "corrupt backup")?;
        let key = derive_key(password, &salt, memory, passes, lanes)?;
        let plaintext = open(&key, &nonce, &data, &aad("backup", BACKUP_FORMAT)).map_err(|_| "wrong password for that backup")?;
        let logins: Vec<ExportedLogin> = serde_json::from_slice(&plaintext).map_err(|_| "corrupt backup")?;
        let rows = logins.iter().map(|login| (login.url.clone(), login.username.clone(), Zeroizing::new(login.password.clone()), login.title.clone(), login.notes.clone())).collect();
        self.add_many(store, rows)
    }

    /// CSV in the common browser format (name,url,username,password,note). Unencrypted.
    pub fn export_csv(&self, store: &Store, master: &str) -> Result<Zeroizing<String>> {
        let logins = self.export_all(store, master)?;
        let mut writer = csv::Writer::from_writer(Vec::new());
        writer.write_record(["name", "url", "username", "password", "note"]).map_err(|error| error.to_string())?;
        for login in &logins {
            writer.write_record([&login.title, &login.url, &login.username, &login.password, &login.notes]).map_err(|error| error.to_string())?;
        }
        let bytes = Zeroizing::new(writer.into_inner().map_err(|error| error.to_string())?);
        Ok(Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

/// Reads password CSVs from Chrome/Edge/Brave/Opera, Firefox, Bitwarden,
/// 1Password, Safari and others by matching common column names.
pub fn parse_password_csv(text: &str) -> Result<Vec<(String, String, Zeroizing<String>, String, String)>> {
    let mut reader = csv::ReaderBuilder::new().flexible(true).trim(csv::Trim::Headers).from_reader(text.as_bytes());
    let headers: Vec<String> = reader.headers().map_err(|error| error.to_string())?.iter().map(|header| header.to_lowercase()).collect();
    let column = |names: &[&str]| headers.iter().position(|header| names.contains(&header.as_str()));
    let url = column(&["url", "login_uri", "website", "web site", "login url", "uri"]).ok_or("no website column in that file")?;
    let password = column(&["password", "login_password"]).ok_or("no password column in that file")?;
    let username = column(&["username", "login_username", "user name", "login", "email", "user"]);
    let title = column(&["name", "title"]);
    let notes = column(&["note", "notes", "extra", "comments"]);
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|error| error.to_string())?;
        let get = |index: Option<usize>| index.and_then(|index| record.get(index)).unwrap_or_default().to_string();
        rows.push((get(Some(url)), get(username), Zeroizing::new(get(Some(password))), get(title), get(notes)));
    }
    Ok(rows)
}

// ---------------------------------------------------------------- generator

/// A random password from a cryptographically secure source.
pub fn generate_password(length: usize, symbols: bool) -> Zeroizing<String> {
    // No look-alike characters (0/O, 1/l/I).
    const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
    const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
    const DIGITS: &[u8] = b"23456789";
    const SYMBOLS: &[u8] = b"!@#$%^&*-_=+?";
    let length = length.clamp(12, 64);
    let mut sets: Vec<&[u8]> = vec![LOWER, UPPER, DIGITS];
    if symbols { sets.push(SYMBOLS); }
    let all: Vec<u8> = sets.concat();
    let pick = |set: &[u8]| -> u8 {
        // Rejection sampling avoids modulo bias.
        let limit = 256 - (256 % set.len());
        loop {
            let byte = random_bytes::<1>()[0] as usize;
            if byte < limit { return set[byte % set.len()]; }
        }
    };
    loop {
        let mut chars: Vec<u8> = (0..length).map(|_| pick(&all)).collect();
        // Require one of each class so sites with rules accept it.
        if sets.iter().all(|set| chars.iter().any(|char| set.contains(char))) {
            let password = Zeroizing::new(String::from_utf8(chars.clone()).unwrap_or_default());
            chars.zeroize();
            return password;
        }
        chars.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> Store {
        let store = Store::open(std::path::Path::new(":memory:")).expect("store");
        create_tables(&store).expect("tables");
        store
    }

    #[test]
    fn create_unlock_and_wrong_password() {
        let store = test_store();
        let vault = Vault::default();
        vault.create(&store, "correct horse battery").unwrap();
        vault.add(&store, &EntryInput { url: Some("https://example.com/login".into()), username: Some("ana".into()), password: secret_text("hunter2!"), ..Default::default() }).unwrap();
        vault.lock();
        assert!(vault.list().is_err(), "locked vault must not list");
        assert_eq!(vault.unlock(&store, "wrong").unwrap_err(), "wrong master password");
        vault.unlock(&store, "correct horse battery").unwrap();
        let list = vault.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].origin, "https://example.com");
        let (_, password) = vault.credentials(&store, &list[0].id).unwrap();
        assert_eq!(password.as_str(), "hunter2!");
    }

    #[test]
    fn nothing_readable_in_the_database() {
        let store = test_store();
        let vault = Vault::default();
        vault.create(&store, "correct horse battery").unwrap();
        vault.add(&store, &EntryInput { url: Some("https://secret-bank.test".into()), username: Some("me@example.com".into()), password: secret_text("p4ssw0rd-plain"), ..Default::default() }).unwrap();
        let blobs: Vec<Vec<u8>> = store.with(|c| {
            let mut statement = c.prepare("SELECT meta FROM vault_entries UNION ALL SELECT secret FROM vault_entries UNION ALL SELECT wrapped_key FROM vault_meta")?;
            let rows = statement.query_map([], |row| row.get(0))?;
            rows.collect()
        }).unwrap();
        for blob in blobs {
            let text = String::from_utf8_lossy(&blob);
            assert!(!text.contains("secret-bank") && !text.contains("me@example.com") && !text.contains("p4ssw0rd"));
        }
    }

    #[test]
    fn tampering_and_swapping_are_detected() {
        let store = test_store();
        let vault = Vault::default();
        vault.create(&store, "correct horse battery").unwrap();
        let a = vault.add(&store, &EntryInput { url: Some("https://a.test".into()), password: secret_text("aaaa"), ..Default::default() }).unwrap();
        let b = vault.add(&store, &EntryInput { url: Some("https://b.test".into()), password: secret_text("bbbb"), ..Default::default() }).unwrap();
        // Copy b's secret blob onto a: the associated data (entry id) must reject it.
        store.with(|c| c.execute("UPDATE vault_entries SET secret = (SELECT secret FROM vault_entries WHERE id = ?2), secret_nonce = (SELECT secret_nonce FROM vault_entries WHERE id = ?2) WHERE id = ?1", [a.id.as_str(), b.id.as_str()]).map(|_| ())).unwrap();
        assert!(vault.credentials(&store, &a.id).is_err());
    }

    #[test]
    fn change_password_keeps_entries() {
        let store = test_store();
        let vault = Vault::default();
        vault.create(&store, "first password").unwrap();
        vault.add(&store, &EntryInput { url: Some("https://x.test".into()), password: secret_text("xx"), ..Default::default() }).unwrap();
        vault.change_password(&store, "first password", "second password").unwrap();
        vault.lock();
        assert!(vault.unlock(&store, "first password").is_err());
        vault.unlock(&store, "second password").unwrap();
        assert_eq!(vault.list().unwrap().len(), 1);
    }

    #[test]
    fn backups_round_trip_and_need_the_password() {
        let store = test_store();
        let vault = Vault::default();
        vault.create(&store, "backup password").unwrap();
        vault.add(&store, &EntryInput { url: Some("https://y.test".into()), username: Some("u".into()), password: secret_text("yy"), ..Default::default() }).unwrap();
        let backup = vault.export_backup(&store, "backup password").unwrap();
        assert!(!backup.contains("y.test"));
        let other_store = test_store();
        let other = Vault::default();
        other.create(&other_store, "another vault").unwrap();
        assert!(other.import_backup(&other_store, &backup, "wrong").is_err());
        assert_eq!(other.import_backup(&other_store, &backup, "backup password").unwrap(), (1, 0, 0));
        assert_eq!(other.import_backup(&other_store, &backup, "backup password").unwrap(), (0, 0, 1));
    }

    #[test]
    fn csv_formats() {
        let chrome = "name,url,username,password,note\nExample,https://example.com/,ana,pw1,\n";
        let bitwarden = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Site,,,0,https://site.test,bob,pw2,\n";
        assert_eq!(parse_password_csv(chrome).unwrap()[0].2.as_str(), "pw1");
        let rows = parse_password_csv(bitwarden).unwrap();
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str(), rows[0].2.as_str()), ("https://site.test", "bob", "pw2"));
    }

    #[test]
    fn offers_dedupe_and_classify() {
        let store = test_store();
        let vault = Vault::default();
        vault.create(&store, "offer password").unwrap();
        let offer = vault.offer("https://z.test", "zed", "pw").unwrap();
        assert_eq!(offer.kind, "new");
        assert!(vault.offer("https://z.test", "zed", "pw").is_none(), "same submission twice");
        vault.resolve_offer(&store, &offer.pending_id, false).unwrap();
        assert_eq!(vault.offer("https://z.test", "zed", "pw2").unwrap().kind, "update");
    }

    #[test]
    fn generator_uses_every_class() {
        let password = generate_password(20, true);
        assert_eq!(password.len(), 20);
        assert!(password.chars().any(|c| c.is_ascii_digit()) && password.chars().any(|c| c.is_ascii_uppercase()) && password.chars().any(|c| !c.is_ascii_alphanumeric()));
        assert_ne!(generate_password(20, true).as_str(), password.as_str());
    }

    #[test]
    fn origins_are_exact() {
        assert_eq!(origin_of("https://Example.com/login?x=1").as_deref(), Some("https://example.com"));
        assert_eq!(origin_of("http://localhost:3000/a").as_deref(), Some("http://localhost:3000"));
        assert_eq!(origin_of("javascript:alert(1)"), None);
        assert_ne!(origin_of("https://example.com.evil.test"), origin_of("https://example.com"));
    }
}
