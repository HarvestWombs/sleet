# Sleet

A lightweight, focused desktop browser built with Tauri 3 alpha and React.

## Included in the first slice

- Native child-webview tabs with a vertical tab rail
- Local reading history
- Native download lifecycle reporting
- Keyboard-first command palette
- Browser-preview fallback for UI work outside Tauri

## Run

```bash
npm install
npm run tauri dev
```

Tauri 3 currently requires Rust 1.95 or newer. The included toolchain file selects 1.95 automatically.

## Releasing

GitHub Actions builds everything; see `.github/workflows/`.

- **CI** (`ci.yml`): every push and pull request runs the type check, frontend tests and Rust tests on Windows, macOS and Linux.
- **Release** (`release.yml`): pushing a `v*` tag builds installers for every platform and attaches them to a **draft** release. Publishing the draft ships it, and installed copies offer the update in Settings → Advanced.

To release, bump `version` in `src-tauri/tauri.conf.json` (the tag must match it), commit, then:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Signed in-app updates need, under the repository's Settings → Secrets and variables → Actions: the secret `TAURI_SIGNING_PRIVATE_KEY` (contents of the private key), the secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (if it has one) and the variable `TAURI_UPDATER_PUBKEY` (contents of the `.pub` file). Make the key once with `npx tauri signer generate -w ~/.tauri/sleet.key` and keep it backed up: without it, installed copies can't be updated. Without these settings, releases still build, just without in-app updates.

## Keyboard

- `Ctrl/Cmd + K` — command palette
- `Ctrl/Cmd + L` — focus address bar
- `Ctrl/Cmd + T` — new tab
- `Ctrl/Cmd + W` — close active tab

Tauri 3 is still an alpha. The React shell talks to it through `src/native/browserEngine.ts`, keeping version-specific APIs isolated.
