import { describe, expect, test } from "bun:test";
import { bagSignature, marketOpenRequest } from "../src/frontend/market-bridge.ts";
import type { LootItemView, LootLine } from "../src/shared/contracts.ts";

function line(stat: string, printed: number | null, isChaos = false): LootLine {
  return { stat, printed, rollPct: 50, isChaos, over: false };
}

function item(overrides: Partial<LootItemView> = {}): LootItemView {
  return {
    uid: "rune-1", itemId: "Corporeal", name: "Corporeal Rune", type: "Rune", kind: "artifact", icon: null, refine: 0, count: 1,
    favorite: false, hasChaos: false, topRolls: 0, highRolls: 0, avgRollPct: null, match: null,
    lines: [line("Str", 3), line("HpMult", 2)],
    ...overrides,
  };
}

describe("bagSignature", () => {
  test("changes when an item is refined or rerolled under the same UID and count", () => {
    const before = bagSignature([item()]);
    expect(bagSignature([item()])).toBe(before);
    expect(bagSignature([item({ refine: 1 })])).not.toBe(before);
    expect(bagSignature([item({ lines: [line("Str", 4), line("HpMult", 2)] })])).not.toBe(before);
    expect(bagSignature([item({ lines: [line("Dex", 3), line("HpMult", 2)] })])).not.toBe(before);
    expect(bagSignature([item({ lines: [line("Str", 3), line("HpMult", 2, true)], hasChaos: true })])).not.toBe(before);
    expect(bagSignature([item({ favorite: true })])).not.toBe(before);
  });

  test("changes when items are added, removed, or restacked", () => {
    const one = bagSignature([item()]);
    expect(bagSignature([item(), item({ uid: "rune-2" })])).not.toBe(one);
    expect(bagSignature([item({ count: 2 })])).not.toBe(one);
    expect(bagSignature([])).toBe("");
  });
});

describe("marketOpenRequest", () => {
  test("encodes the item, artifact slot, and stat lines as a market URL query", () => {
    const request = marketOpenRequest(item({ lines: [line("Str", 3), line("Crit", null), line("Luk", 9, true)] }));
    expect(request).toEqual({ type: "valecompanion:market-open", search: "item=Artifact%3ACorporeal&slot=Rune&stats=Str%3A3%2CCrit", name: "Corporeal Rune" });
  });

  test("omits the slot for equipment and the stats when none decoded", () => {
    const request = marketOpenRequest(item({ kind: "equipment", type: "Chest", itemId: "Mage Plate", name: "", lines: [] }));
    expect(request).toEqual({ type: "valecompanion:market-open", search: "item=Equipment%3AMage+Plate", name: "Mage Plate" });
  });

  test("keeps material and card market destinations distinct for the same item ID", () => {
    const material = marketOpenRequest(item({ itemId: "Mushroom", kind: "material", type: "Material", lines: [] }));
    const card = marketOpenRequest(item({ itemId: "Mushroom", kind: "card", type: "Card", lines: [] }));
    if (material.type !== "valecompanion:market-open" || card.type !== "valecompanion:market-open") throw new Error("Expected market navigation");
    expect(new URLSearchParams(material.search).get("item")).toBe("Material:Mushroom");
    expect(new URLSearchParams(card.search).get("item")).toBe("Card:Mushroom");
  });
});
