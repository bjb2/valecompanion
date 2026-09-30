import { expect, test } from "bun:test";
import { priceItem } from "../src/core/market-value.ts";
import { LootSession } from "../src/core/loot-session.ts";
import type { SaviInventory } from "../src/core/types.ts";
import type { ItemCatalog } from "../src/shared/item-catalog.ts";

const empty = (): SaviInventory => ({ equips: [], artifacts: [], cards: [], gems: [], junks: [], consumables: [], cosmetics: [] });
const card = (count: number) => ({ itemId: "Abomination", count, favorite: false });

test("storage replaces contents independently and never records loot alerts", () => {
  const bag = new LootSession();
  const storage = new LootSession({ silent: true, soundsEnabled: () => true, onSound: () => { throw new Error("Storage must be silent"); } });
  storage.setFilter('Show "all"\n  Sound alert');
  bag.consumeInventory({ ...empty(), cards: [card(2)] });
  storage.consumeInventory(empty());
  storage.consumeInventory({ ...empty(), cards: [card(5)], junks: [{ itemId: "Unknown material", count: 8, favorite: false }], consumables: [{ itemId: "Unknown potion", count: 3, favorite: false }], cosmetics: [{ itemId: "Unknown hat", uid: "hat", refine: 2, favorite: true }] });
  expect(bag.bag()[0]?.count).toBe(2);
  expect(storage.bag()).toHaveLength(4);
  expect(storage.bag().map(item => item.kind).sort()).toEqual(["card", "consumable", "cosmetic", "material"]);
  expect(storage.history()).toEqual([]);
  storage.consumeInventory(empty());
  expect(storage.bag()).toEqual([]);
  expect(bag.bag()).toHaveLength(1);
  storage.resetCharacter();
  expect(storage.bag()).toEqual([]);
});

test("bag updates from storage transfers are silent but later loot still alerts", () => {
  const bag = new LootSession();
  bag.setFilter('Show "all"');
  bag.consumeInventory({ ...empty(), cards: [card(1)] });
  bag.consumeInventory({ ...empty(), cards: [card(2)] }, false, true);
  expect(bag.history()).toEqual([]);
  bag.consumeInventory({ ...empty(), cards: [card(3)] });
  expect(bag.history()).toHaveLength(1);
});


test("bag and storage both retain materials, consumables, and cosmetics", () => {
  const inventory: SaviInventory = { ...empty(),
    junks: [{ itemId: "material", count: 12, favorite: false }],
    consumables: [{ itemId: "potion", count: 4, favorite: true }],
    cosmetics: [{ itemId: "hat", uid: "cosmetic-uid", refine: 3, favorite: true }],
  };
  for (const session of [new LootSession(), new LootSession({ silent: true })]) {
    session.consumeInventory(inventory);
    const items = session.bag();
    expect(items).toHaveLength(3);
    for (const item of items) expect(priceItem(item, [{ itemId: item.itemId, unitPrice: 999, stats: [], refine: 0, artifactSlot: null }])).toBeNull();
    expect(items.find(item => item.kind === "material")?.count).toBe(12);
    expect(items.find(item => item.kind === "consumable")?.count).toBe(4);
    expect(items.find(item => item.kind === "cosmetic")).toMatchObject({ uid: "cosmetic-uid", refine: 3, favorite: true });
    session.consumeInventory(empty());
    expect(session.bag()).toEqual([]);
  }
});


test("shared item IDs retain category-specific card and cosmetic identities", () => {
  for (const session of [new LootSession(), new LootSession({ silent: true })]) {
    session.consumeInventory({ ...empty(), cards: [{ itemId: "Turtle", count: 2, favorite: false }], cosmetics: [{ itemId: "Turtle", uid: "pet-uid", refine: 0, favorite: false }] });
    const card = session.bag().find(item => item.kind === "card")!;
    const pet = session.bag().find(item => item.kind === "cosmetic")!;
    expect(card.name).toBe("Turtle Baby Card");
    expect(card.icon).toBe("published-content-game-icons-card.webp");
    expect(pet.name).toBe("Turtle Baby Pet");
    expect(pet.icon).toBe("cosmetic-turtle.webp");
    expect(pet.uid).not.toBe(card.uid);
  }
});

test("shared equipment and cosmetic IDs use their category-specific catalog entries", () => {
  const session = new LootSession();
  session.consumeInventory({ ...empty(),
    equips: [{
      slot: -1, uid: "weapon-uid", itemId: "Abyss Shard", refine: 0, cards: [], substats: [],
      startingPotential: 0, spentPotential: 0, chaosType: -1, favorite: false,
    }],
    cosmetics: [{ itemId: "Abyss Shard", uid: "cosmetic-uid", refine: 0, favorite: false }],
  });

  expect(session.bag().find((item) => item.kind === "equipment")).toMatchObject({
    name: "Abyss Shard", icon: "published-content-game-icons-equip-v1_wield_gear_right_20.webp",
  });
  expect(session.bag().find((item) => item.kind === "cosmetic")).toMatchObject({
    name: "Abyss Shard", icon: "cosmetic-abyss-shard.webp",
  });
});


test("unified catalog preserves supplementary cosmetic identities and local artwork", async () => {
  const catalog = await Bun.file(new URL("../assets/catalog.json", import.meta.url)).json() as ItemCatalog;
  const cosmetics = Object.values(catalog).filter((entry) => entry.kind === "Cosmetic");
  const turtle = cosmetics.find((entry) => entry.id === "Turtle");
  expect(turtle).toMatchObject({ name: "Turtle Baby Pet", icon: "icons/cosmetic-turtle.webp", slot: "Cosmetic" });
  for (const entry of cosmetics) {
    if (entry.icon) expect(await Bun.file(new URL(`../assets/${entry.icon}`, import.meta.url)).exists()).toBe(true);
  }
});
