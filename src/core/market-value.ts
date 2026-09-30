import type { LootItemView, MarketValueTier, MarketValueView } from "../shared/contracts.ts";
import { ARTIFACT_SLOT_NAMES } from "./types.ts";
import { LOOT_CATALOG_KINDS, type CatalogKind } from "../shared/item-catalog.ts";

export interface MarketListing {
  itemId: string;
  unitPrice: number;
  stats: Array<{ name: string; value: number }>;
  refine: number;
  artifactSlot: number | null;
}

const ARTIFACT_SLOT_IDS: Record<string, number> = Object.fromEntries(
  Object.entries(ARTIFACT_SLOT_NAMES).map(([id, name]) => [name, Number(id)]),
);

// A listing is comparable when it shares the item, artifact slot, and stat lines, and every
// value is at least the owned roll. Looser tiers fall back to the same lines, then any roll.
export function priceItem(item: LootItemView, listings: MarketListing[]): MarketValueView | null {
  if (listings.length === 0 || item.kind === "material" || item.kind === "consumable" || item.kind === "cosmetic") return null;
  if (item.kind === "card" || item.kind === "gem") return unitValue(item, listings);
  const slot = item.kind === "artifact" ? ARTIFACT_SLOT_IDS[item.type] ?? null : null;
  const pool = slot === null ? listings : listings.filter((listing) => listing.artifactSlot === slot);
  if (pool.length === 0) return null;
  const lines = item.lines.filter((line) => !line.isChaos);
  const names = lines.map((line) => line.stat).sort();
  const family = pool.filter((listing) => sameNames(listing, names));
  const comparable = family.filter((listing) => lines.every((line) => {
    if (line.printed === null) return true;
    const value = listing.stats.find((stat) => stat.name === line.stat)?.value;
    return value !== undefined && value >= line.printed;
  }));
  const [tier, matched]: [MarketValueTier, MarketListing[]] = comparable.length > 0
    ? ["comparable", comparable]
    : family.length > 0 ? ["same-lines", family] : ["other-lines", pool];
  const prices = sortedPrices(matched);
  return { low: prices[0]!, median: percentile(prices, 0.5), tier, listings: prices.length };
}

export function priceBag(bag: LootItemView[], byItem: (itemId: string, kind: CatalogKind) => MarketListing[]): LootItemView[] {
  return bag.map((item) => {
    const value = priceItem(item, byItem(item.itemId, LOOT_CATALOG_KINDS[item.kind]));
    return value ? { ...item, value } : item;
  });
}

function unitValue(item: LootItemView, listings: MarketListing[]): MarketValueView {
  const sameRefine = item.kind === "gem" ? listings.filter((listing) => listing.refine === item.refine) : [];
  const pool = sameRefine.length > 0 ? sameRefine : listings;
  const prices = sortedPrices(pool);
  const count = Math.max(1, item.count);
  return { low: percentile(prices, 0.25) * count, median: percentile(prices, 0.5) * count, tier: "unit", listings: pool.length };
}

function sameNames(listing: MarketListing, names: string[]): boolean {
  if (listing.stats.length !== names.length) return false;
  const own = listing.stats.map((stat) => stat.name).sort();
  return own.every((name, index) => name === names[index]);
}

function sortedPrices(listings: MarketListing[]): number[] {
  return listings.map((listing) => listing.unitPrice).sort((left, right) => left - right);
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}
