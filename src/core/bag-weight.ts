import { resolveFishNetItem, type FishNetItemDefinition } from "@valecompanion/items";
import type { SaviEquip, SaviInventory, SaviSnapshot } from "./types.ts";

export interface BagWeightView {
  current: number | null;
  total: number | null;
  reason?: string;
}

const WEIGHT_LIMIT_STAT = 101;
const BASE_WEIGHT_LIMIT = 2_000;
const WEIGHT_LIMIT_PER_LEVEL = 30;
const HEAD_EQUIP_SLOT = 2;
const LEGS_EQUIP_SLOT = 3;

/**
 * Mirrors `Formula.GetWeightValue(InventoryData)` and
 * `Formula.GetWeightLimit(PlayerController)`. The latter is
 * `2000 + level * 30 + StatusComponent.Get(WeightLimit)`.
 *
 * Verified against 0.33.0-ea: WeightLimit contributions come only from equipped
 * gear, the two matching card configs, and artifact gems. All 209 StatusConfig
 * and 184 SkillPassiveConfig assets have no WeightLimit StatValues. Recheck these
 * sources when refreshing the bundled item definitions for a new game build.
 */
export class BagWeightTracker {
  #current: number | null | undefined;
  #capacity: number | null | undefined;

  reset(): void {
    this.#current = undefined;
    this.#capacity = undefined;
  }

  consumeInventory(inventory: SaviInventory): void {
    this.#current = currentWeight(inventory);
  }

  consumeSnapshot(snapshot: SaviSnapshot): void {
    this.#capacity = weightLimit(snapshot);
    if (snapshot.inventory) this.consumeInventory(snapshot.inventory);
  }

  view(): BagWeightView {
    if (this.#current === undefined) {
      return {
        current: null,
        total: null,
        reason: "No authoritative bag inventory snapshot has been observed",
      };
    }

    const current = this.#current;
    if (current === null) {
      return {
        current: null,
        total: null,
        reason: "An equipment weight is missing from the current item catalog",
      };
    }

    if (this.#capacity === undefined) {
      return {
        current,
        total: null,
        reason: "No authoritative character snapshot has been observed",
      };
    }

    const total = this.#capacity;
    if (total === null) {
      return {
        current,
        total: null,
        reason: "An equipped WeightLimit source is missing from the current item catalog",
      };
    }
    return { current, total };
  }
}

function currentWeight(inventory: SaviInventory): number | null {
  let total = 0;

  // Formula.GetWeightValue(StackableItemData) returns Count. This covers cards, junks,
  // and consumables; the client therefore charges one weight unit per stack member.
  for (const item of inventory.cards) total += item.count;
  for (const item of inventory.junks) total += item.count;
  for (const item of inventory.consumables) total += item.count;

  // Formula.GetWeightValue returns ten for every non-stackable non-equipment inventory
  // item: artifacts, gems, and cosmetics. Equipped artifacts are not in InventoryData.
  total += 10 * (inventory.artifacts.length + inventory.gems.length + (inventory.cosmetics?.length ?? 0));

  for (const item of inventory.equips) {
    const weight = resolveFishNetItem(2, item.itemId)?.weight;
    if (weight === undefined) return null;
    total += weight;
  }
  return total;
}

function weightLimit(character: SaviSnapshot): number | null {
  let total = BASE_WEIGHT_LIMIT + WEIGHT_LIMIT_PER_LEVEL * character.level;

  for (const equip of character.equips) {
    const definition = resolveFishNetItem(2, equip.itemId);
    if (!definition) return null;
    total += statValue(definition, equip.refine);

    for (const cardId of equip.cards) {
      if (!cardId) continue;
      const card = resolveFishNetItem(4, cardId);
      if (!card) return null;
      total += cardWeightLimit(card, equip);
    }
  }

  for (const artifact of character.artifacts) {
    if (!resolveFishNetItem(3, artifact.itemId)) return null;
    for (const gem of artifact.gems) {
      const definition = resolveFishNetItem(5, gem.itemId);
      if (!definition) return null;
      total += statValue(definition, gem.refine);
    }
  }

  return total;
}

function statValue(item: FishNetItemDefinition, refine: number): number {
  // SetGear/SetArtifacts pass maxLevel=10 to AddEquipStat; cards use a separate,
  // unclamped ApplyEffectStats path below.
  return (item.effects?.reduce(weightLimitEffect, 0) ?? 0)
    + Math.max(0, Math.min(10, refine)) * (item.refineEffects?.reduce(weightLimitEffect, 0) ?? 0);
}

function weightLimitEffect(total: number, effect: { readonly type: number; readonly value: number }): number {
  return effect.type === WEIGHT_LIMIT_STAT ? total + effect.value : total;
}

function cardWeightLimit(card: FishNetItemDefinition, equip: SaviEquip): number {
  // Cards are applied as EffectData at their host equipment's refine level. The two
  // current WeightLimit cards require Head and Legs respectively.
  if (card.id === "Delivery Robot" && equip.slot === HEAD_EQUIP_SLOT) return 100 * equip.refine;
  if (card.id === "Nozzle Robot" && equip.slot === LEGS_EQUIP_SLOT) return 100 * equip.refine;
  return 0;
}
