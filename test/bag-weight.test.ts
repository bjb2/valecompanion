import { expect, test } from "bun:test";
import { BagWeightTracker } from "../src/core/bag-weight.ts";
import type { SaviInventory, SaviSnapshot } from "../src/core/types.ts";

const emptyInventory = (): SaviInventory => ({
  equips: [], artifacts: [], cards: [], gems: [], junks: [], consumables: [], cosmetics: [],
});

test("bag weight mirrors stack, fixed non-stack, and catalog equipment weights", () => {
  const inventory = emptyInventory();
  inventory.equips.push({
    slot: -1, uid: "chest", itemId: "ArcaneChest", refine: 0, cards: [], substats: [],
    startingPotential: 0, spentPotential: 0, chaosType: -1, favorite: false,
  });
  inventory.artifacts.push({ slot: 0, uid: "artifact", itemId: "Atk", refine: 0, gems: [], substats: [], favorite: false });
  inventory.gems.push({ uid: "gem", itemId: "AtkSpd Gem", refine: 0, favorite: false });
  inventory.cosmetics?.push({ uid: "cosmetic", itemId: "ArcaneChest", refine: 0, favorite: false });
  inventory.cards.push({ itemId: "Abomination", count: 3, favorite: false });
  inventory.junks.push({ itemId: "Acorn", count: 5, favorite: false });
  inventory.consumables.push({ itemId: "Artifact Box Base", count: 2, favorite: false });

  const tracker = new BagWeightTracker();
  tracker.consumeInventory(inventory);

  // Arcane Chest weighs 50; three non-stackables weigh 10 each; stacks weigh their counts.
  // A bag snapshot alone has no character state from which to calculate the limit.
  expect(tracker.view()).toMatchObject({ current: 90, total: null });
});

test("bag weight derives the automatic limit from level, equipment cards, and artifact gems", () => {
  const tracker = new BagWeightTracker();
  tracker.consumeInventory(emptyInventory());
  const character: SaviSnapshot = {
    schema: 1,
    updateType: 0,
    name: "",
    title: null,
    archetypes: [],
    level: 10,
    exp: 0,
    jobLevel: 0,
    jobExp: 0,
    attributes: [0, 0, 0, 0, 0, 0],
    activeLoadout: 0,
    equips: [
      {
        slot: 8, uid: "backpack", itemId: "Backpack", refine: 2, cards: [], substats: [],
        startingPotential: 0, spentPotential: 0, chaosType: -1, favorite: false,
      },
      {
        slot: 2, uid: "head", itemId: "DiscipleHelm", refine: 2, cards: ["Delivery Robot"], substats: [],
        startingPotential: 0, spentPotential: 0, chaosType: -1, favorite: false,
      },
      {
        slot: 3, uid: "legs", itemId: "DiscipleLegs", refine: 3, cards: ["Nozzle Robot"], substats: [],
        startingPotential: 0, spentPotential: 0, chaosType: -1, favorite: false,
      },
    ],
    loadouts: [[], [], []],
    artifacts: [{
      slot: 0, uid: "artifact", itemId: "Atk", refine: 0,
      gems: [{ uid: "weight-gem", itemId: "WeightLimit Gem", refine: 3, favorite: false }],
      substats: [], favorite: false,
    }],
    skills: [],
    assigned: [],
    grimoires: [],
    mapId: null,
    capturedAt: "",
    partial: false,
  };
  tracker.consumeSnapshot(character);

  expect(tracker.view()).toEqual({ current: 0, total: 4_600 });

  character.equips[0]!.refine = 20;
  character.equips[1]!.refine = 12;
  character.artifacts[0]!.gems[0]!.refine = 20;
  tracker.consumeSnapshot(character);
  // Backpack: 1000 + 10*100; gem: 10*200; cards: 12*100 + 3*100.
  expect(tracker.view()).toEqual({ current: 0, total: 7_800 });

  character.equips[1]!.slot = 0;
  tracker.consumeSnapshot(character);
  expect(tracker.view().total).toBe(6_600);

  // A character update with a truncated inventory tail still refreshes capacity.
  tracker.consumeSnapshot({ ...character, level: 11, equips: [], artifacts: [], partial: true });
  expect(tracker.view()).toEqual({ current: 0, total: 2_330 });
  const updatedBag = emptyInventory();
  updatedBag.junks.push({ itemId: "Acorn", count: 7, favorite: false });
  tracker.consumeInventory(updatedBag);
  expect(tracker.view()).toEqual({ current: 7, total: 2_330 });
  tracker.reset();
  expect(tracker.view()).toMatchObject({ current: null, total: null });
});


test("an equipment absent from the catalog is reported as unknown", () => {
  const inventory = emptyInventory();
  inventory.equips.push({
    slot: -1, uid: "unknown", itemId: "FutureChest", refine: 0, cards: [], substats: [],
    startingPotential: 0, spentPotential: 0, chaosType: -1, favorite: false,
  });
  const tracker = new BagWeightTracker();
  tracker.consumeInventory(inventory);

  expect(tracker.view()).toMatchObject({ current: null, total: null });
});
