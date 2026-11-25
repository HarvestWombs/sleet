import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadKv } from "./lib/kv";
import { overlayKindFromLocation } from "./lib/overlay";
import { applyLaunchSettings, readSettings } from "./lib/settings";
import { IS_MAIN_WINDOW, prepareSavedWindows, takeWindowStart } from "./lib/windows";
import { OverlayApp } from "./overlay/OverlayApp";
import "./styles.css";

const overlayKind = overlayKindFromLocation();

/** Saved state is loaded from SQLite before the first render (overlays don't need it). */
async function start() {
  if (!overlayKind) {
    await loadKv();
    if (IS_MAIN_WINDOW) {
      // Launch-time work happens once, in the first window.
      applyLaunchSettings();
      prepareSavedWindows(readSettings().startup === "restore");
    } else {
      await takeWindowStart();
    }
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {overlayKind ? <OverlayApp kind={overlayKind} /> : <App />}
    </StrictMode>,
  );
}

void start();
