import { describe, expect, it } from "vitest";
import { neighbour, recordVisit } from "./tabNav";

describe("recordVisit", () => {
  it("starts from the tab's current address", () => {
    expect(recordVisit(undefined, "sleet://home", "https://a.test/")).toEqual({ stack: ["sleet://home", "https://a.test/"], index: 1 });
  });

  it("treats the neighbouring entry as back/forward", () => {
    const nav = { stack: ["a", "b", "c"], index: 2 };
    expect(recordVisit(nav, "c", "b")).toEqual({ stack: ["a", "b", "c"], index: 1 });
    expect(recordVisit({ ...nav, index: 1 }, "b", "c")).toEqual({ stack: ["a", "b", "c"], index: 2 });
  });

  it("drops forward entries on a new visit", () => {
    expect(recordVisit({ stack: ["a", "b", "c"], index: 1 }, "b", "d")).toEqual({ stack: ["a", "b", "d"], index: 2 });
  });

  it("ignores repeats of the current entry", () => {
    const nav = { stack: ["a", "b"], index: 1 };
    expect(recordVisit(nav, "b", "b")).toBe(nav);
  });
});

describe("neighbour", () => {
  it("returns the entry one step away, or null at the ends", () => {
    const nav = { stack: ["a", "b"], index: 1 };
    expect(neighbour(nav, true)).toEqual({ url: "a", index: 0 });
    expect(neighbour(nav, false)).toBeNull();
    expect(neighbour(undefined, true)).toBeNull();
  });
});
