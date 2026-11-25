import { describe, expect, it } from "vitest";
import { groupAfterMove, keepGroupsTogether, liveGroups, nextGroupName, setGroup } from "./tabGroups";

const tabs = (spec: string) => spec.split(" ").map((item) => {
  const [id, groupId] = item.split(":");
  return groupId ? { id, groupId } : { id };
});
const ids = (list: { id: string; groupId?: string }[]) => list.map((tab) => (tab.groupId ? `${tab.id}:${tab.groupId}` : tab.id)).join(" ");

describe("tab groups", () => {
  it("keeps a group's tabs together where it starts", () => {
    expect(ids(keepGroupsTogether(tabs("a b:g c d:g e")))).toBe("a b:g d:g c e");
  });

  it("adds tabs to the end of a group", () => {
    expect(ids(setGroup(tabs("a:g b c:g d"), ["d"], "g"))).toBe("a:g c:g d:g b");
    expect(ids(setGroup(tabs("a b c"), ["b", "c"], "n"))).toBe("a b:n c:n");
  });

  it("removes tabs from a group", () => {
    expect(ids(setGroup(tabs("a:g b:g c:g"), ["b"], undefined))).toBe("a:g c:g b");
  });

  it("decides the group after a drag", () => {
    expect(groupAfterMove(tabs("a:g x b:g"), 1)).toBe("g");
    expect(groupAfterMove(tabs("a:g x:g b"), 1)).toBe("g");
    expect(groupAfterMove(tabs("a x:g b"), 1)).toBeUndefined();
  });

  it("drops empty groups and names new ones", () => {
    const groups = [{ id: "g", name: "Group 1", color: "blue" as const }, { id: "h", name: "Work", color: "red" as const }];
    expect(liveGroups(groups, tabs("a:g b")).map((group) => group.id)).toEqual(["g"]);
    expect(nextGroupName(groups)).toBe("Group 2");
  });
});
