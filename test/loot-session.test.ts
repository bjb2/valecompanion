import { expect, test } from "bun:test";
import { artifactFacts, equipmentFacts } from "../src/core/catalog.ts";
import { explainCondition, matchLoot } from "../src/core/filter/loot-filter.ts";
import { LootSession } from "../src/core/loot-session.ts";
import type { PickupNotification } from "../src/shared/pickup-overlay.ts";
import type { SaviArtifact, SaviEquip, SaviGem, SaviSnapshot, SaviStack, SaviSubstat } from "../src/core/types.ts";

function equipment(uid: string, substats: Array<SaviSubstat | null> = []): SaviEquip {
  return {
    slot: -1,
    uid,
    itemId: "Abyss Shard",
    refine: 0,
    cards: [],
    substats,
    startingPotential: 0,
    spentPotential: 0,
    chaosType: -1,
    favorite: false,
  };
}

function gem(uid: string): SaviGem {
  return {
    uid,
    itemId: "AtkSpd Gem",
    refine: 2,
    favorite: false,
  };
}

function card(count: number): SaviStack {
  return { itemId: "Abomination", count, favorite: false };
}

function snapshot(items: SaviEquip[], partial = false, gems: SaviGem[] = [], cards: SaviStack[] = []): SaviSnapshot {
  return {
    schema: 1,
    updateType: 0,
    name: "",
    title: null,
    archetypes: [1],
    level: 1,
    exp: 0,
    jobLevel: 1,
    jobExp: 0,
    attributes: [0, 0, 0, 0, 0, 0],
    activeLoadout: 0,
    equips: [],
    loadouts: [[], [], []],
    artifacts: [],
    skills: [],
    assigned: [],
    grimoires: [],
    mapId: null,
    capturedAt: "",
    partial,
    inventory: {
      equips: items,
      artifacts: [],
      cards,
      gems,
      junks: [],
      consumables: [],
    },
  };
}

test("decoded inventory remains authoritative when the later character tail is partial", () => {
  const session = new LootSession();
  session.consume(snapshot([equipment("a")]));
  expect(session.consume(snapshot([equipment("a"), equipment("b")])).added.map((item) => item.uid)).toEqual(["b"]);
  session.consume(snapshot([equipment("b")]));
  expect(session.consume(snapshot([equipment("b"), equipment("a")])).added.map((item) => item.uid)).toEqual(["a"]);
  session.consume(snapshot([equipment("a")], true));
  expect(session.bag().map((item) => item.uid)).toEqual(["a"]);
});

test("gems enter the bag and match Gem rules", () => {
  const session = new LootSession();
  session.setFilter('Show "gems"\n  Type Gem\n  Tag GEM');
  session.consume(snapshot([]));
  const result = session.consume(snapshot([], false, [gem("gem-1")]));

  expect(result.added).toHaveLength(1);
  expect(result.added[0]).toMatchObject({
    uid: "gem-1",
    itemId: "AtkSpd Gem",
    name: "Tempo Gem",
    type: "Gem",
    kind: "gem",
    refine: 2,
    match: { tag: "GEM" },
  });
  expect(session.bag()).toHaveLength(1);
});

test("cards enter the bag and repeated stack increases trigger additions", () => {
  const session = new LootSession();
  session.setFilter('Show "cards"\n  Type Card\n  Tag CARD');
  session.consume(snapshot([]));

  const first = session.consume(snapshot([], false, [], [card(1)]));
  expect(first.added).toHaveLength(1);
  expect(first.added[0]).toMatchObject({
    uid: "Abomination:card",
    itemId: "Abomination",
    name: "Abomination Card",
    type: "Card",
    kind: "card",
    count: 1,
    match: { tag: "CARD" },
  });

  expect(session.consume(snapshot([], false, [], [card(2)])).added).toHaveLength(1);
  expect(session.consume(snapshot([], false, [], [card(2)])).added).toHaveLength(0);
  expect(session.bag()[0]?.count).toBe(2);
});

test("pickup notifications use stack deltas independently of sound", () => {
  const pickups: PickupNotification[] = [];
  const played: string[] = [];
  const session = new LootSession({
    soundsEnabled: () => false,
    onSound: (sound) => { played.push(sound); return true; },
    onPickup: (pickup) => { pickups.push(pickup); },
  });
  session.setFilter('Show "cards"\n  Type Card\n  Tag CARD\n  Color #12ab34\n  Sound chime');

  session.consume(snapshot([], false, [], [card(1)]));
  session.consume(snapshot([], false, [], [card(3)]));
  session.consume(snapshot([], false, [], [card(3)]));
  session.consume(snapshot([], false, [], [card(2)]));
  session.consume(snapshot([], false, [], [card(5)]));

  expect(pickups.map((pickup) => pickup.quantity)).toEqual([2, 3]);
  expect(session.history().map((entry) => entry.sequence)).toEqual([2, 1]);
  expect(played).toEqual([]);
});

test("silent inventory sessions do not emit pickup notifications", () => {
  const pickups: string[] = [];
  const session = new LootSession({ silent: true, onPickup: (pickup) => { pickups.push(pickup.name); } });
  session.setFilter('Show "shards"\n  Name "Abyss Shard"');

  session.consume(snapshot([]));
  session.consume(snapshot([equipment("silent")]));

  expect(pickups).toEqual([]);
});

test("catalog facts use displayed values and preserve chaos slot holes", () => {
  const item = equipment("facts", [
    { index: 0, type: 2, roll: 50, valueStr: null },
    null,
    { index: 2, type: 999, roll: 100, valueStr: null },
  ]);
  item.chaosType = 2;
  const facts = equipmentFacts(item);
  expect(facts.lines[0]?.base).toBe(3);
  expect(facts.lines[0]?.rollPct).toBe(50);
  expect(facts.lines[0]?.isChaos).toBe(false);
  expect(facts.lines[1]?.isChaos).toBe(true);
  expect(facts.avgRollPct).toBe(75);
  expect(facts.topRolls).toBeNull();
});

test("catalog facts apply chest-specific substat caps", () => {
  const item = equipment("chest", [{ index: 0, type: 71, roll: 100, valueStr: null }]);
  item.itemId = "ArcaneChest";
  const facts = equipmentFacts(item);
  expect(facts.slotType).toBe("Chest");
  expect(facts.lines[0]?.base).toBe(10);
  expect(facts.lines[0]?.rollPct).toBe(100);
  expect(facts.topRolls).toBe(1);
  expect(facts.view.icon).toBe("equip-V2_Chest_17.webp");
});

test("Azure Antlers printed rolls satisfy specific stat filters", () => {
  const item = equipment("antlers", [
    { index: 0, type: 4, roll: 70, valueStr: null },
    { index: 1, type: 12, roll: 86, valueStr: null },
    { index: 2, type: 70, roll: 84, valueStr: null },
  ]);
  item.itemId = "Azure Antlers";
  const session = new LootSession();
  session.setFilter('Show "Azure Antlers"\n    Name "Azure Antlers"\n    Stat Int >= 3\n    Stat Mdef >= 5\n    Stat MatkMult >= 2\n    Tag KEEP');
  session.consume(snapshot([item]));
  const antlers = session.bag()[0]!;
  expect(antlers.lines.map(({ stat, printed }) => [stat, printed])).toEqual([
    ["Int", 3], ["Mdef", 5], ["MatkMult", 2],
  ]);
  expect(antlers.topRolls).toBe(3);
  expect(antlers.match?.tag).toBe("KEEP");
});

test("Azure Antlers flat MATK remains distinct from percentage MATK", () => {
  const item = equipment("flat-antlers", [
    { index: 0, type: 0, roll: 70, valueStr: null },
    { index: 1, type: 12, roll: 40, valueStr: null },
    { index: 2, type: 10, roll: 20, valueStr: null },
  ]);
  item.itemId = "Azure Antlers";
  const session = new LootSession();
  session.setFilter('Show "percentage only"\n    Stat MatkMult >= 2\n    Tag WRONG\nShow "flat antlers"\n    Name "Azure Antlers"\n    Stat Str >= 3\n    Stat Mdef >= 3\n    Stat Matk >= 2\n    Tag KEEP');
  session.consume(snapshot([item]));
  const antlers = session.bag()[0]!;
  expect(antlers.lines.map(({ stat, printed }) => [stat, printed])).toEqual([
    ["Str", 3], ["Mdef", 4], ["Matk", 2],
  ]);
  expect(antlers.match?.tag).toBe("KEEP");
});

test.each([
  ["Adventurer's Kit", 12, 5], // Back uses Headgear, not Accessory.
  ["Acolyte_1", 70, 2], // A grimoire without an override defaults to Accessory.
  ["Buckler", 12, 10], // Shield uses Chest.
  ["EchoBook", 67, 10], // Live explicit Magic override absent from the old dependency.
  ["Artemis", 25, 1], // Ranged-specific range, absent from the old table.
  ["Abyss Shard", 80, 20], // Melee-specific multistrike, absent from the old table.
])("live pool selection decodes %s stat %i", (itemId, type, printed) => {
  const item = { ...equipment("pool", [{ index: 0, type, roll: 100, valueStr: null }]), itemId };
  const facts = equipmentFacts(item);
  expect(facts.view.lines[0]?.printed).toBe(printed);
  expect(facts.topRolls).toBe(1);
});

test("client float32 rounding preserves half-step and negative roll values", () => {
  const legs = equipmentFacts({
    ...equipment("legs", [
      { index: 0, type: 14, roll: 90, valueStr: null },
      { index: 1, type: 75, roll: 34, valueStr: null },
    ]),
    itemId: "ArcaneLegs",
  });
  expect(legs.view.lines.map((line) => line.printed)).toEqual([15, 20]);
  expect(legs.topRolls).toBe(1);
  const shield = equipmentFacts({
    ...equipment("shield", [{ index: 0, type: 57, roll: 10, valueStr: null }]),
    itemId: "Buckler",
  });
  expect(shield.view.lines[0]?.printed).toBe(-4);
});

test("artifact facts resolve the concrete slot piece", () => {
  const item: SaviArtifact = {
    slot: 1,
    uid: "artifact",
    itemId: "Auto",
    refine: 0,
    gems: [],
    substats: [],
    favorite: false,
  };
  const facts = artifactFacts(item);
  expect(facts.view.name).toBe("Blitzcore Jewel");
  expect(facts.view.type).toBe("Jewel");
  expect(facts.view.icon).toBe("artifact-auto-1.webp");
});

test("artifact category rule matches a three-top primary artifact", () => {
  const item: SaviArtifact = {
    slot: 0,
    uid: "perfect-artifact",
    itemId: "Corporeal",
    refine: 0,
    gems: [],
    substats: [
      { index: 0, type: 0, roll: 100, valueStr: null },
      { index: 1, type: 71, roll: 100, valueStr: null },
      { index: 2, type: 72, roll: 100, valueStr: null },
    ],
    favorite: false,
  };
  const session = new LootSession();
  const parsed = session.setFilter(`Show "Artifact — perfect"
    Type Artifact
    TopRolls >= 3
    AnyOf
        Stat Str >= 3
        Stat Vit >= 3
        Stat Dex >= 3
        Stat Agi >= 3
        Stat Int >= 3
        Stat Luk >= 3
    Tag ART-P
    Color #f4d35e
    Highlight glow
    Background holo
    Border off
    Sound alert`);
  expect(parsed.errors).toEqual([]);
  session.consumeInventory({
    equips: [],
    artifacts: [item],
    cards: [],
    gems: [],
    junks: [],
    consumables: [],
  });
  expect(session.bag()).toEqual([expect.objectContaining({
    kind: "artifact",
    type: "Rune",
    topRolls: 3,
    lines: [
      expect.objectContaining({ stat: "Str", printed: 3 }),
      expect.objectContaining({ stat: "HpMult", printed: 2 }),
      expect.objectContaining({ stat: "MpMult", printed: 2 }),
    ],
    match: {
      rule: "Artifact — perfect",
      tag: "ART-P",
      color: "#f4d35e",
      highlight: "glow",
      background: "holo",
      border: false,
      sound: "alert",
    },
  })]);
  const facts = artifactFacts(item);
  const context = { threshold: 90 };
  const rule = parsed.rules[0]!;
  expect(explainCondition(facts, rule.when, context).checks.find((check) => check.key === "type"))
    .toMatchObject({ actual: "Rune", status: "pass" });

  const runeOnly = new LootSession().setFilter(`Show "Rune only"
    Type Rune
    Tag RUNE`).rules[0]!;
  expect(matchLoot(facts, [runeOnly], context)?.label).toBe("RUNE");

  const equipmentItem = equipment("not-artifact", [
    { index: 0, type: 0, roll: 100, valueStr: null },
    { index: 1, type: 4, roll: 100, valueStr: null },
    { index: 2, type: 12, roll: 100, valueStr: null },
  ]);
  equipmentItem.itemId = "Azure Antlers";
  expect(equipmentFacts(equipmentItem).topRolls).toBe(3);
  expect(matchLoot(equipmentFacts(equipmentItem), [rule], context)).toBeNull();

  const twoTop = artifactFacts({
    ...item,
    uid: "two-top-artifact",
    substats: [
      { index: 0, type: 0, roll: 100, valueStr: null },
      { index: 1, type: 71, roll: 100, valueStr: null },
      { index: 2, type: 72, roll: 0, valueStr: null },
    ],
  });
  expect(twoTop.topRolls).toBe(2);
  expect(matchLoot(twoTop, [rule], context)).toBeNull();

  const noPrimary = artifactFacts({
    ...item,
    uid: "no-primary-artifact",
    substats: [
      { index: 0, type: 71, roll: 100, valueStr: null },
      { index: 1, type: 72, roll: 100, valueStr: null },
      { index: 2, type: 69, roll: 100, valueStr: null },
    ],
  });
  expect(noPrimary.topRolls).toBe(3);
  expect(matchLoot(noPrimary, [rule], context)).toBeNull();
});

test("changing the filter threshold recalculates current high-roll counts", () => {
  const session = new LootSession();
  session.setFilter("Threshold 90");
  session.consume(snapshot([equipment("a", [{ index: 0, type: 2, roll: 92, valueStr: null }])]));
  expect(session.bag()[0]?.highRolls).toBe(1);
  session.setFilter("Threshold 95");
  expect(session.bag()[0]?.highRolls).toBe(0);
});

test("high-roll metrics do not imply an active filter rule", () => {
  const session = new LootSession();
  session.consume(snapshot([equipment("high", [{ index: 0, type: 2, roll: 100, valueStr: null }])]));
  expect(session.filter.rules).toEqual([]);
  expect(session.bag()[0]?.highRolls).toBe(1);
  expect(session.bag()[0]?.match).toBeNull();
});

test("hidden matches never project, play, enter history, or notify", () => {
  const played: string[] = [];
  const pickups: PickupNotification[] = [];
  const session = new LootSession({
    soundsEnabled: () => true,
    onSound: (sound) => { played.push(sound); return true; },
    onPickup: (pickup) => { pickups.push(pickup); },
  });
  session.setFilter('AlwaysHide "Abyss Shard"');
  session.consume(snapshot([]));
  const result = session.consume(snapshot([equipment("hidden")]));
  expect(result.added[0]?.match).toBeNull();
  expect(session.bag()[0]?.match).toBeNull();
  expect(session.history()).toEqual([]);
  expect(played).toEqual([]);
  expect(pickups).toEqual([]);
});

test("one snapshot awards sound priority once and records every visible match", () => {
  const played: string[] = [];
  const session = new LootSession({ soundsEnabled: () => true, onSound: (sound) => { played.push(sound); return true; } });
  session.setFilter('Show "shards"\n  Name "Abyss Shard"\n  Sound chime');
  session.consume(snapshot([]));
  session.consume(snapshot([equipment("first"), equipment("second")]));
  expect(played).toEqual(["chime"]);
  expect(session.history()).toHaveLength(2);
  expect(session.history().filter((entry) => entry.soundWinner)).toHaveLength(1);
  expect(session.history().filter((entry) => entry.soundPlayed)).toHaveLength(1);
  session.clearHistory();
  expect(session.history()).toEqual([]);
});

test("async sound dispatch updates history only after confirmation", async () => {
  let confirm!: (played: boolean) => void;
  const session = new LootSession({
    soundsEnabled: () => true,
    onSound: () => new Promise<boolean>((resolve) => { confirm = resolve; }),
  });
  session.setFilter('Show "shards"\n  Name "Abyss Shard"\n  Sound chime');
  session.consume(snapshot([]));
  session.consume(snapshot([equipment("confirmed")]));
  expect(session.history()[0]?.soundPlayed).toBe(false);
  confirm(true);
  await Promise.resolve();
  expect(session.history()[0]?.soundPlayed).toBe(true);
  expect(session.history()[0]?.note).toBe("alert played");

  const rejected = new LootSession({
    soundsEnabled: () => true,
    onSound: () => Promise.reject(new Error("transport failed")),
  });
  rejected.setFilter('Show "shards"\n  Name "Abyss Shard"\n  Sound chime');
  rejected.consume(snapshot([]));
  rejected.consume(snapshot([equipment("rejected")]));
  await Promise.resolve();
  expect(rejected.history()[0]?.soundPlayed).toBe(false);
  expect(rejected.history()[0]?.note).toBe("sound unavailable or disabled");
});

test("a grimoire is its own kind, not equipment", () => {
  const session = new LootSession();
  session.consume(snapshot([]));
  // Rogue_3 is Venom Bloom: equipment on the wire, Grimoire in the catalog.
  const grimoire: SaviEquip = { ...equipment("g2"), itemId: "Rogue_3" };
  const result = session.consume(snapshot([equipment("g1"), grimoire]));

  expect(Object.fromEntries(result.added.map((item) => [item.uid, item.kind])))
    .toEqual({ g1: "equipment", g2: "grimoire" });
  expect(result.added.find((item) => item.uid === "g2"))
    .toMatchObject({ name: "Venom Bloom", type: "Grimoire" });
});
