/** Plain-language names for site permission kinds (from privacy.rs). */
export const PERMISSION_LABELS: Record<string, { name: string; ask: string }> = {
  camera: { name: "Camera", ask: "use your camera" },
  microphone: { name: "Microphone", ask: "use your microphone" },
  location: { name: "Location", ask: "know your location" },
  notifications: { name: "Notifications", ask: "show notifications" },
  sensors: { name: "Motion sensors", ask: "use motion and light sensors" },
  clipboard: { name: "Clipboard", ask: "see text and images you copy" },
  downloads: { name: "Automatic downloads", ask: "download multiple files" },
  files: { name: "File editing", ask: "edit files on your device" },
  autoplay: { name: "Autoplay", ask: "play media automatically" },
  fonts: { name: "Local fonts", ask: "use fonts installed on your device" },
  midi: { name: "MIDI devices", ask: "control your MIDI devices" },
  windows: { name: "Window management", ask: "manage windows on your displays" },
  popups: { name: "Popups", ask: "open popups" },
  other: { name: "Other", ask: "use a device feature" },
};

export const permissionName = (kind: string) => PERMISSION_LABELS[kind]?.name ?? kind;
export const permissionAsk = (kind: string) => PERMISSION_LABELS[kind]?.ask ?? "use a device feature";

/** Permissions shown in the site info panel even before a site has asked. */
export const COMMON_PERMISSIONS = ["camera", "microphone", "location", "notifications", "popups"];

export const hostOf = (value: string) => {
  try { return new URL(value).host || value; } catch { return value; }
};
