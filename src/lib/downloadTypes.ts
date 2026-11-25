/**
 * "Always open files of this type". Programs, scripts, installers and
 * shortcuts can never be opened automatically: a site could otherwise run
 * code just by starting a download.
 */
const NEVER_AUTO_OPEN = new Set([
  // Windows programs, installers and scripts
  "exe", "com", "scr", "pif", "msi", "msix", "msixbundle", "appx", "appxbundle", "msp", "mst",
  "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "wsc", "hta",
  "cpl", "msc", "lnk", "url", "scf", "reg", "inf", "ins", "isp", "application", "appref-ms",
  "gadget", "jar", "jnlp", "ocx", "dll", "sys", "drv", "library-ms", "settingcontent-ms", "website",
  // macOS
  "app", "pkg", "mpkg", "dmg", "command", "workflow", "terminal", "scpt", "scptd", "applescript",
  // Linux and cross-platform
  "sh", "bash", "zsh", "csh", "ksh", "run", "bin", "deb", "rpm", "appimage", "flatpakref", "snap", "desktop",
  "py", "pyw", "pyc", "pl", "rb", "php",
  // Disk images and archives that mount or unpack and run
  "iso", "img", "vhd", "vhdx",
  // Office documents with macros
  "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm",
]);

/** Pausing needs WebView2's download API, so only Windows has it for now. */
export const canPauseDownloads = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/** `report.PDF` → `pdf`; empty when the name has no extension. */
export function extensionOf(filename: string) {
  const name = filename.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** `.EXE` → `exe`; empty for anything that isn't a plain extension. */
export function normalizeExtension(extension: string) {
  const type = extension.trim().replace(/^\./, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,15}$/.test(type) ? type : "";
}

/** Whether files with this extension may be opened automatically. */
export function canAutoOpen(extension: string) {
  return /^[a-z0-9][a-z0-9-]{0,15}$/.test(extension) && !NEVER_AUTO_OPEN.has(extension);
}

/** The download should open as soon as it finishes. */
export function shouldAutoOpen(filename: string, autoOpenTypes: readonly string[]) {
  const extension = extensionOf(filename);
  return canAutoOpen(extension) && autoOpenTypes.includes(extension);
}
