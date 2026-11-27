# Changelog

What changed in each Sleet release. Each release's notes on GitHub come from
its section here, so add one before tagging (the release build stops if the
version has no section).

## [0.1.2] - 2026-11-27

### Added

- **Keep tab active**: a tab menu item that stops a tab from being unloaded
  to save memory. Kept tabs show an anchor in the sidebar.

### Fixed

- Logging in no longer shows the engine's own "save password" prompt and
  suggestion list on top of Sleet's password popup.

## [0.1.1] - 2026-11-25

### Fixed

- Clicking a link in another app while Sleet was open could start a second
  Sleet that crashed. Links now always open as a tab in the window you used
  last.
- When Sleet is the default browser, it keeps Windows pointing links at the
  installed copy, even after an update or reinstall.

## [0.1.0] - 2026-11-25

First release.

- Vertical tabs, tab groups, bookmarks with folders and import from other
  browsers, and tabs that sleep to save memory.
- Docking: tabs side by side, each pane with its own title bar.
- Multiple windows, with tabs that move between them without reloading.
- Downloads with pause and resume, Save as, and "always open" file types.
- Tracking prevention, a popup blocker, HTTPS upgrades, private tabs and
  per-site permissions.
- A built-in password manager (Argon2id and XChaCha20-Poly1305).
- Find in page, print and save as PDF, full-screen video, crash recovery and
  signed in-app updates.

[0.1.2]: https://github.com/HarvestWombs/sleet/releases/tag/v0.1.2
[0.1.1]: https://github.com/HarvestWombs/sleet/releases/tag/v0.1.1
[0.1.0]: https://github.com/HarvestWombs/sleet/releases/tag/v0.1.0
