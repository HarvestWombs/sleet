import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../types";
import { buildSuggestions } from "./suggest";

const visit = (url: string, title = url, visitedAt = 1): HistoryEntry => ({ id: url, url, title, visitedAt });

describe("buildSuggestions", () => {
  it("sends a bare site name to the site", () => {
    const [first] = buildSuggestions("youtube", [], "Google");
    expect(first).toMatchObject({ kind: "domain", url: "https://youtube.com/", autocomplete: true });
  });

  it("ranks visited sites above well-known ones", () => {
    const history = [visit("https://gitea.example.org/a"), visit("https://gitea.example.org/b")];
    const [first] = buildSuggestions("git", history, "Google");
    expect(first.url).toBe("https://gitea.example.org/");
  });

  it("matches a later part of the host without autocompleting", () => {
    const rows = buildSuggestions("steampowered", [], "Google");
    expect(rows[0]).toMatchObject({ url: "https://store.steampowered.com/" });
    expect(rows[0].autocomplete).toBeFalsy();
  });

  it("searches for phrases and always ends with a search row", () => {
    const rows = buildSuggestions("best pizza near me", [], "DuckDuckGo");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "search", subtitle: "Search DuckDuckGo" });
  });

  it("offers typed addresses directly", () => {
    const rows = buildSuggestions("example.com/docs", [], "Google");
    expect(rows[0]).toMatchObject({ kind: "url", url: "example.com/docs" });
    expect(rows.some((row) => row.autocomplete)).toBe(false);
  });

  it("includes matching history pages", () => {
    const rows = buildSuggestions("trailer", [visit("https://youtube.com/watch?v=1", "Big Trailer")], "Google");
    expect(rows.some((row) => row.kind === "history" && row.title === "Big Trailer")).toBe(true);
  });

  it("returns nothing for empty input", () => {
    expect(buildSuggestions("   ", [], "Google")).toEqual([]);
  });
});
