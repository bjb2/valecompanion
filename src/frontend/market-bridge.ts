import type { LootItemView } from "../shared/contracts.ts";
import { catalogKey, LOOT_CATALOG_KINDS } from "../shared/item-catalog.ts";

export type MarketBridgeMessage =
  | { type: "valecompanion:market-open"; search: string; name: string }
  | { type: "valecompanion:bag"; bag: LootItemView[] };

export function marketOpenRequest(item: LootItemView): MarketBridgeMessage {
  const params = new URLSearchParams({ item: catalogKey(LOOT_CATALOG_KINDS[item.kind], item.itemId) });
  if (item.kind === "artifact") params.set("slot", item.type);
  const stats = item.lines
    .filter((line) => !line.isChaos)
    .map((line) => (line.printed === null ? line.stat : `${line.stat}:${line.printed}`));
  if (stats.length) params.set("stats", stats.join(","));
  return { type: "valecompanion:market-open", search: params.toString(), name: item.name || item.itemId };
}

// Covers every field the market frame displays or prices, so a refine or reroll on an
// existing UID re-sends the bag.
export function bagSignature(bag: LootItemView[]): string {
  return bag.map((item) => [
    item.uid, item.count, item.refine, item.favorite ? 1 : 0, item.hasChaos ? 1 : 0,
    ...item.lines.map((line) => `${line.stat}=${line.printed ?? ""}${line.isChaos ? "c" : ""}`),
  ].join(":")).join("|");
}
