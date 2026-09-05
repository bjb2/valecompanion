/**
 * One row per bag category. Everything that used to hard-code a kind list reads this instead:
 * the bag sections and their order, the pricing path, the fact builders, and the fallback sigil.
 * Declaration order is the order the bag draws its sections in.
 */
export interface LootKindInfo {
  /** Section heading in the bag. */
  label: string;
  /** Letter drawn when an item has no icon. Unique per kind, so it stays readable. */
  sigil: string;
  /**
   * Display type for kinds whose items all share one, which is also the name a filter rule
   * matches with `Type`. Equipment, grimoires and artifacts take theirs from the item instead.
   */
  flatType?: string;
  /** Priced by unit ask times stack size rather than by comparing rolls against listings. */
  fungible: boolean;
  /** `FishNetItemType` for this kind, used to resolve display names the local catalog lacks. */
  itemType: number;
  /** Inventory bucket on the wire, for the kinds that arrive as counted stacks. */
  stackBucket?: "cards" | "consumables" | "junks";
}

const KINDS = {
  equipment: { label: "Equipment", sigil: "E", fungible: false, itemType: 2 },
  artifact: { label: "Artifacts", sigil: "A", fungible: false, itemType: 3 },
  card: { label: "Cards", sigil: "C", flatType: "Card", fungible: true, itemType: 4, stackBucket: "cards" },
  consumable: { label: "Consumables", sigil: "U", flatType: "Consumable", fungible: true, itemType: 1, stackBucket: "consumables" },
  gem: { label: "Gems", sigil: "G", flatType: "Gem", fungible: true, itemType: 5 },
  grimoire: { label: "Grimoires", sigil: "R", fungible: false, itemType: 2 },
  material: { label: "Materials", sigil: "M", flatType: "Material", fungible: true, itemType: 0, stackBucket: "junks" },
} as const satisfies Record<string, LootKindInfo>;

export type LootKind = keyof typeof KINDS;

/** The kinds that arrive as counted stacks rather than as individual items. */
export type StackKind = { [K in LootKind]: (typeof KINDS)[K] extends { stackBucket: string } ? K : never }[LootKind];

export const LOOT_KINDS: Readonly<Record<LootKind, LootKindInfo>> = KINDS;

/** Every kind, in the order the bag draws them. */
export const LOOT_KIND_ORDER = Object.keys(KINDS) as LootKind[];

/** Each stack kind with the inventory bucket it is read from. */
export const STACK_KINDS = LOOT_KIND_ORDER.flatMap((kind) => {
  const bucket = LOOT_KINDS[kind].stackBucket;
  return bucket ? [[kind as StackKind, bucket] as const] : [];
});
