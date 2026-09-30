import type { LootKind } from "./contracts.ts";

export type CatalogKind = "Material" | "Consumable" | "Equipment" | "Artifact" | "Card" | "Gem" | "Cosmetic";

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: CatalogKind;
  readonly icon?: string | null;
  readonly wiki?: string | null;
  readonly section?: string | null;
  readonly slot?: string | null;
}


export const LOOT_CATALOG_KINDS = {
  material: "Material",
  consumable: "Consumable",
  equipment: "Equipment",
  grimoire: "Equipment",
  artifact: "Artifact",
  card: "Card",
  gem: "Gem",
  cosmetic: "Cosmetic",
} as const satisfies Readonly<Record<LootKind, CatalogKind>>;

export const MARKET_CATALOG_KINDS = {
  1: "Material",
  2: "Consumable",
  3: "Equipment",
  4: "Artifact",
  5: "Card",
  6: "Gem",
  7: "Cosmetic",
} as const satisfies Readonly<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, CatalogKind>>;
export type ItemCatalog = Readonly<Record<string, CatalogEntry>>;

/**
 * Creates a collision-free catalog address from the wire category and game item ID.
 * Artifact pieces share an ID, so their inventory slot disambiguates the concrete piece.
 */
export function catalogKey(kind: CatalogKind, id: string, artifactSlot?: string | null): string {
  return kind === "Artifact" && artifactSlot ? `${kind}:${id}:${artifactSlot}` : `${kind}:${id}`;
}
