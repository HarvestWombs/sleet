//! Login forms in pages ↔ the password vault.
//!
//! A small script in each page (PAGE_SCRIPT) reports login-field focus and
//! submitted logins. Messages arrive through the engine's own channel, which
//! tells us the page's real origin (a page can't claim to be another site).
//! Submitted passwords stay in Rust (see Vault::offer); the UI only learns the
//! site and username so it can ask "Save password?".
//!
//! Engine channel: WebView2 (Windows) today, wired in page_hooks.rs. macOS
//! (WKScriptMessageHandler) and Linux (WebKitGTK) can call `handle` the same way.

use crate::vault::{LoginOffer, Vault};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::Zeroizing;

/// Injected into every page's top frame. Untrusted by design: the page can
/// tamper with it, so Rust treats everything it sends as a suggestion.
pub const PAGE_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || window.__sleetLogins) return;
  window.__sleetLogins = true;
  const post = (message) => {
    try {
      const text = JSON.stringify(message);
      if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(text);
      else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sleet) window.webkit.messageHandlers.sleet.postMessage(text);
    } catch (_) { /* ignore */ }
  };
  const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password' && !el.disabled;
  const isUserField = (el) => el instanceof HTMLInputElement && !el.disabled
    && ['text', 'email', 'tel', ''].includes(el.type)
    && (/user|login|email|account|name/i.test(`${el.name} ${el.id} ${el.autocomplete} ${el.placeholder}`) || el.autocomplete === 'username');
  const passwordIn = (root) => Array.from((root || document).querySelectorAll('input[type=password]')).find((el) => !el.disabled && el.offsetParent !== null);
  const usernameFor = (password) => {
    const scope = password.form || document;
    const inputs = Array.from(scope.querySelectorAll('input'));
    for (let i = inputs.indexOf(password) - 1; i >= 0; i -= 1) {
      const el = inputs[i];
      if (el.type === 'hidden' || el.disabled) continue;
      if (['text', 'email', 'tel', ''].includes(el.type)) return el;
    }
    return null;
  };
  let lastPassword = null;
  let lastSent = '';
  const capture = () => {
    const password = (lastPassword && lastPassword.isConnected && lastPassword.value) ? lastPassword : passwordIn();
    if (!password || !password.value) return;
    const user = usernameFor(password);
    const key = `${user ? user.value : ''}\u0000${password.value}`;
    if (key === lastSent) return;
    lastSent = key;
    post({ sleet: 'login-submit', username: user ? user.value : '', password: password.value });
  };
  document.addEventListener('submit', capture, true);
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter' && isPassword(event.target)) capture(); }, true);
  document.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('button, input[type=submit], [role=button]') : null;
    if (button && passwordIn(button.form || document)) setTimeout(capture, 0);
  }, true);
  document.addEventListener('focusin', (event) => {
    const el = event.target;
    if (!isPassword(el) && !(isUserField(el) && passwordIn(el.form || document))) return;
    if (isPassword(el)) lastPassword = el;
    const box = el.getBoundingClientRect();
    post({ sleet: 'login-focus', rect: { x: box.left, y: box.top, width: box.width, height: box.height }, newPassword: el.autocomplete === 'new-password' });
  }, true);
  document.addEventListener('focusout', (event) => {
    if (isPassword(event.target) || isUserField(event.target)) post({ sleet: 'login-blur' });
  }, true);
  // Called by Sleet (only for this exact origin) to fill a chosen login.
  window.__sleetFill = (username, secret, newPassword) => {
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const password = (lastPassword && lastPassword.isConnected) ? lastPassword : passwordIn();
    if (!password) return;
    if (newPassword) {
      // Sign-up / change-password forms: the new password and its confirmation.
      const scope = password.form || document;
      Array.from(scope.querySelectorAll('input[type=password]'))
        .filter((el) => !el.disabled && (el === password || /new|confirm|repeat|again|verify/i.test(`${el.name} ${el.id} ${el.autocomplete} ${el.placeholder}`)))
        .forEach((el) => setValue(el, secret));
      return;
    }
    const user = usernameFor(password);
    if (user && username) setValue(user, username);
    setValue(password, secret);
  };
})();
"#;

#[derive(Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageMessage {
    sleet: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<Zeroizing<String>>,
    #[serde(default)]
    rect: Option<Rect>,
    #[serde(default)]
    new_password: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginFocus {
    label: String,
    origin: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    new_password: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfferEvent {
    label: String,
    #[serde(flatten)]
    offer: LoginOffer,
}

/// Handles one message from a page whose real origin is `origin`.
pub fn handle(app: &AppHandle, label: &str, origin: &str, text: &str) {
    let Ok(message) = serde_json::from_str::<PageMessage>(text) else { return };
    match message.sleet.as_str() {
        "login-focus" => {
            let Some(rect) = message.rect else { return };
            if !crate::privacy::is_private(label) {
                let store = app.state::<crate::store::Store>();
                crate::vault_commands::auto_unlock(app, &app.state::<Vault>(), &store);
            }
            let _ = app.emit("sleet-login-focus", LoginFocus {
                label: label.into(),
                origin: origin.into(),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                new_password: message.new_password,
            });
        }
        "login-blur" => {
            let _ = app.emit("sleet-login-blur", label.to_string());
        }
        "login-submit" => {
            // Private tabs never offer to save.
            if crate::privacy::is_private(label) {
                return;
            }
            let Some(password) = message.password.filter(|password| !password.is_empty() && password.len() < 4096) else { return };
            let username: String = message.username.unwrap_or_default().chars().take(512).collect();
            let vault = app.state::<Vault>();
            crate::vault_commands::auto_unlock(app, &vault, &app.state::<crate::store::Store>());
            let Some(offer) = vault.offer(origin, &username, &password) else { return };
            if offer.kind == "update" {
                let store = app.state::<crate::store::Store>();
                if !vault.offer_changes_password(&store, &offer.pending_id).unwrap_or(true) {
                    // Same password as saved: nothing to ask.
                    let _ = vault.resolve_offer(&store, &offer.pending_id, true);
                    return;
                }
            }
            let _ = app.emit("sleet-password-offer", OfferEvent { label: label.into(), offer });
        }
        _ => {}
    }
}
