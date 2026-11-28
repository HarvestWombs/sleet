import { describe, expect, it } from "vitest";
import { assignBinding, bindingFromEvent, bindingTable, conflictFor, removeBinding, resetAction, resolveShortcuts, SHORTCUT_ACTIONS, usableBinding } from "./shortcuts";

const press = (code: string, key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  bindingFromEvent({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("shortcuts", () => {
  it("names key presses by position", () => {
    expect(press("KeyS", "s", { altKey: true })).toBe("Alt+S");
    expect(press("KeyN", "N", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+N");
    expect(press("KeyT", "t", { metaKey: true })).toBe("Ctrl+T");
    expect(press("Equal", "+", { ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+=");
    expect(press("ArrowLeft", "ArrowLeft", { altKey: true })).toBe("Alt+Left");
    expect(press("F5", "F5")).toBe("F5");
    expect(press("ShiftLeft", "Shift", { shiftKey: true })).toBeNull();
  });

  it("only allows keys that don't get in the way of typing", () => {
    expect(usableBinding("Alt+S")).toBe(true);
    expect(usableBinding("F7")).toBe(true);
    expect(usableBinding("S")).toBe(false);
    expect(usableBinding("Shift+S")).toBe(false);
    expect(usableBinding("Ctrl+C")).toBe(false);
  });

  it("defaults have no clashes", () => {
    const all = SHORTCUT_ACTIONS.flatMap((action) => action.defaults);
    expect(new Set(all).size).toBe(all.length);
    expect(bindingTable(resolveShortcuts())["Alt+S"]).toBe("toggle-sidebar");
  });

  it("moves a key from the action that had it", () => {
    const overrides = assignBinding({}, "history", "Alt+S");
    expect(resolveShortcuts(overrides).history).toEqual(["Alt+H", "Ctrl+Y", "Alt+S"]);
    expect(resolveShortcuts(overrides)["toggle-sidebar"]).toEqual(["Ctrl+Shift+S"]);
    expect(conflictFor({}, "Alt+S", "history")?.id).toBe("toggle-sidebar");
  });

  it("removes and resets keys, keeping only changes", () => {
    const removed = removeBinding({}, "history", "Ctrl+Y");
    expect(removed).toEqual({ history: ["Alt+H"] });
    expect(resetAction(removed, "history")).toEqual({});
    // Resetting takes its defaults back from whoever borrowed one.
    const borrowed = assignBinding({}, "downloads", "Alt+H");
    expect(resolveShortcuts(resetAction(borrowed, "history")).downloads).not.toContain("Alt+H");
  });
});
