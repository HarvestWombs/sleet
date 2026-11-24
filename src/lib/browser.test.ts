import { describe, expect, it } from "vitest";
import { normalizeAddress, securityOf, simplifyUrl } from "./browser";
import { pruneHistory } from "./settings";

describe("normalizeAddress", () => {
  it("keeps complete URLs", () => {
    expect(normalizeAddress("https://example.com/read")).toBe("https://example.com/read");
  });

  it("adds https to hostnames", () => {
    expect(normalizeAddress("example.com/read")).toBe("https://example.com/read");
  });

  it("turns words into a private search", () => {
    expect(normalizeAddress("focused reading")).toBe(
      "https://duckduckgo.com/?q=focused%20reading",
    );
  });

  it("sends empty input and sleet://home to the home screen", () => {
    expect(normalizeAddress("  ")).toBe("sleet://home");
    expect(normalizeAddress("sleet://home/")).toBe("sleet://home");
  });

  it("uses the chosen search engine", () => {
    expect(normalizeAddress("tea", { searchUrl: "https://www.google.com/search?q=" })).toBe(
      "https://www.google.com/search?q=tea",
    );
  });

  it("upgrades http to https when preferred, except local hosts", () => {
    expect(normalizeAddress("http://example.com/a", { preferHttps: true })).toBe("https://example.com/a");
    expect(normalizeAddress("http://localhost:3000", { preferHttps: true })).toBe("http://localhost:3000");
    expect(normalizeAddress("http://example.com/a")).toBe("http://example.com/a");
  });
});

describe("simplifyUrl", () => {
  it("drops scheme, www and a bare slash", () => {
    expect(simplifyUrl("https://www.example.com/")).toBe("example.com");
    expect(simplifyUrl("https://example.com/read?x=1")).toBe("example.com/read");
  });
});

describe("pruneHistory", () => {
  const now = Date.UTC(2026, 0, 31);
  const items = [{ visitedAt: now - 1000 }, { visitedAt: now - 40 * 24 * 60 * 60 * 1000 }];

  it("keeps everything forever", () => expect(pruneHistory(items, "forever", now)).toHaveLength(2));
  it("drops entries older than 30 days", () => expect(pruneHistory(items, "30-days", now)).toHaveLength(1));
  it("keeps nothing when disabled", () => expect(pruneHistory(items, "disabled", now)).toHaveLength(0));
});

describe("stepZoom", () => {
  it("moves to the next level and clamps at the ends", async () => {
    const { stepZoom } = await import("./settings");
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });
});

describe("securityOf", () => {
  it("classifies addresses", () => {
    expect(securityOf("https://example.com")).toBe("secure");
    expect(securityOf("http://example.com")).toBe("insecure");
    expect(securityOf("http://localhost:3000")).toBe("local");
    expect(securityOf("sleet://home")).toBe("none");
  });
});
