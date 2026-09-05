import { describe, expect, test } from "bun:test";
import { priceBag, priceItem, type MarketListing } from "../src/core/market-value.ts";
import type { LootItemView } from "../src/shared/contracts.ts";

function listing(unitPrice: number, stats: Array<[string, number]>, extra: Partial<MarketListing> = {}): MarketListing {
  return { itemId: "Mage Plate", unitPrice, stats: stats.map(([name, value]) => ({ name, value })), refine: 0, artifactSlot: null, ...extra };
}

function item(overrides: Partial<LootItemView>): LootItemView {
  return {
    uid: "u", itemId: "Mage Plate", name: "Mage Plate", type: "Chest", kind: "equipment", icon: null, refine: 0, count: 1,
    favorite: false, hasChaos: false, topRolls: 0, highRolls: 0, avgRollPct: null, match: null,
    lines: [{ stat: "Luk", printed: 3, rollPct: 100, isChaos: false, over: false }, { stat: "DefMult", printed: 3, rollPct: 60, isChaos: false, over: false }],
    ...overrides,
  };
}

describe("priceItem", () => {
  test("prefers the cheapest listing whose every stat is at least as good", () => {
    const value = priceItem(item({}), [
      listing(5_000, [["Luk", 3], ["DefMult", 4]]),
      listing(1_000, [["Luk", 2], ["DefMult", 4]]),
      listing(9_000, [["Luk", 5], ["DefMult", 3]]),
      listing(100, [["Str", 3]]),
    ]);
    expect(value).toEqual({ low: 5_000, median: 5_000, tier: "comparable", listings: 2 });
  });

  test("falls back to the same stat lines, then to any roll of the item", () => {
    const sameLines = priceItem(item({}), [listing(1_000, [["Luk", 2], ["DefMult", 1]]), listing(100, [["Str", 3]])]);
    expect(sameLines).toEqual({ low: 1_000, median: 1_000, tier: "same-lines", listings: 1 });
    const other = priceItem(item({}), [listing(100, [["Str", 3]]), listing(70, [["Agi", 1], ["Vit", 2]])]);
    expect(other).toEqual({ low: 70, median: 70, tier: "other-lines", listings: 2 });
  });

  test("ignores chaos lines and lines without a decoded value", () => {
    const lines = [
      { stat: "Luk", printed: 3, rollPct: 100, isChaos: false, over: false },
      { stat: "Crit", printed: 9, rollPct: 100, isChaos: true, over: true },
      { stat: "DefMult", printed: null, rollPct: 0, isChaos: false, over: false },
    ];
    const value = priceItem(item({ lines }), [listing(2_000, [["Luk", 3], ["DefMult", 1]])]);
    expect(value).toEqual({ low: 2_000, median: 2_000, tier: "comparable", listings: 1 });
  });

  test("only compares artifacts within the same slot", () => {
    const rune = item({ kind: "artifact", type: "Rune", itemId: "Corporeal", lines: [{ stat: "Str", printed: 3, rollPct: 100, isChaos: false, over: false }] });
    const value = priceItem(rune, [
      listing(500, [["Str", 3]], { itemId: "Corporeal", artifactSlot: 1 }),
      listing(9_000, [["Str", 3]], { itemId: "Corporeal", artifactSlot: 0 }),
    ]);
    expect(value).toEqual({ low: 9_000, median: 9_000, tier: "comparable", listings: 1 });
  });

  test("values stacks at the P25 unit ask times the count", () => {
    const card = item({ kind: "card", type: "Card", itemId: "Ghost", count: 7, lines: [] });
    const asks = [3_900, 4_000, 4_800, 4_900, 5_000, 5_000, 5_300, 990_000];
    const value = priceItem(card, asks.map((unitPrice) => listing(unitPrice, [], { itemId: "Ghost" })));
    expect(value).toEqual({ low: 4_000 * 7, median: 4_900 * 7, tier: "unit", listings: 8 });
  });

  test("prices gems against the same refine when any is listed", () => {
    const gem = item({ kind: "gem", type: "Gem", itemId: "Poison Gem", refine: 2, lines: [] });
    const value = priceItem(gem, [
      listing(100, [], { itemId: "Poison Gem", refine: 0 }),
      listing(800, [], { itemId: "Poison Gem", refine: 2 }),
    ]);
    expect(value).toEqual({ low: 800, median: 800, tier: "unit", listings: 1 });
  });

  test("reports the median of the matched tier as the top of the range", () => {
    const value = priceItem(item({}), [1_000, 1_500, 4_000, 9_000].map((price) => listing(price, [["Luk", 3], ["DefMult", 3]])));
    expect(value).toEqual({ low: 1_000, median: 1_500, tier: "comparable", listings: 4 });
  });

  test("returns null when nothing of the item is listed", () => {
    expect(priceItem(item({}), [])).toBeNull();
  });
});

describe("priceBag", () => {
  test("attaches a value only to items with listings", () => {
    const priced = priceBag([item({ uid: "a" }), item({ uid: "b", itemId: "Unlisted" })], (itemId) =>
      itemId === "Mage Plate" ? [listing(400, [["Luk", 3], ["DefMult", 3]])] : []);
    expect(priced[0]?.value).toEqual({ low: 400, median: 400, tier: "comparable", listings: 1 });
    expect(priced[1]?.value).toBeUndefined();
  });
});

describe("fungible kinds", () => {
  test("consumables and materials price by the unit ask times the stack", () => {
    const stack = { itemId: "Ash", name: "Ash", type: "Material", kind: "material" as const, count: 10, lines: [] };
    const listings = [listing(20, [], { itemId: "Ash" }), listing(60, [], { itemId: "Ash" }), listing(100, [], { itemId: "Ash" })];
    expect(priceItem(item(stack), listings)).toEqual({ low: 200, median: 600, tier: "unit", listings: 3 });

    const box = { itemId: "Artifact Box Base", name: "Box of Origins", type: "Consumable", kind: "consumable" as const, count: 2, lines: [] };
    expect(priceItem(item(box), [listing(500, [], { itemId: "Artifact Box Base" })])).toEqual({ low: 1_000, median: 1_000, tier: "unit", listings: 1 });
  });
});
