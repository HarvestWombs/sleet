# Changelog

What changed in each Sleet release. Each release's notes on GitHub come from
its section here, so add one before tagging (the release build stops if the
version has no section).

## [0.1.3] - 2026-11-27

### Added

- **Bookmarks on the Home page**, laid out on one grid like the Windows 10
  Start screen. Bookmarks can sit on their own or in groups.
  - Drag a tile anywhere on the grid, into a group, or into a group's
    gutter (the column right of it and the row under it) to make the group
    bigger. The gutter lights up while you drag.
  - Make groups with **New group** (top left of the Home page) or by
    right-clicking empty grid. Drag a group by its name to move it, and drag
    its edge or corner to resize it. Neighbors move out of the way.
  - Each group has a ⋮ menu for its name, a color (swatches or a custom
    color), opening all its bookmarks, and removing it with or without its
    bookmarks. Double-click a group's name strip to rename it.
  - Site icons are fetched for bookmarks whose sites aren't open.
- **Customize** on the Home page: greeting and clock, keyboard hints,
  bookmarks, names under tiles, tile size, and how much groups are tinted.
- The bookmark button in the address bar adds the page to the Home page
  (Ctrl+D). The star pins it to the sidebar.
- **Alt+D** lists every bookmark in the address bar; typing narrows it.
- The sidebar's grid is now **Pinned** sites. Ctrl+1–9 open them in order
  (Ctrl+9 the last). A pinned site can be set to open a new tab every time
  (right-click › New tab every time).
- **Keyboard shortcuts** can be changed in Settings › Keyboard shortcuts.
  More actions have Alt shortcuts, and they work while a web page has focus.
- Sleet's own icon replaces the "S" on the Home page.

### Changed

- Clicking a finished download's notice opens the file; its button opens the
  Downloads page.
- The ⋯ button in the toolbar is gone; the command palette is still Ctrl+K.

### Fixed

- The address suggestions could shrink to a sliver when the list was long.

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
