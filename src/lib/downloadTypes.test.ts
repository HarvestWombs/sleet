import { describe, expect, it } from "vitest";
import { canAutoOpen, extensionOf, shouldAutoOpen } from "./downloadTypes";

describe("download types", () => {
  it("reads the extension", () => {
    expect(extensionOf("Report.PDF")).toBe("pdf");
    expect(extensionOf("C:\\Users\\me\\Downloads\\archive.tar.gz")).toBe("gz");
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".bashrc")).toBe("");
  });

  it("never auto-opens programs or scripts", () => {
    for (const extension of ["exe", "msi", "bat", "ps1", "js", "lnk", "dmg", "sh", "appimage", "docm"]) {
      expect(canAutoOpen(extension)).toBe(false);
    }
    expect(canAutoOpen("pdf")).toBe(true);
    expect(canAutoOpen("")).toBe(false);
  });

  it("opens only listed, safe types", () => {
    expect(shouldAutoOpen("a.pdf", ["pdf"])).toBe(true);
    expect(shouldAutoOpen("a.png", ["pdf"])).toBe(false);
    expect(shouldAutoOpen("setup.exe", ["exe"])).toBe(false);
  });
});
