import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveFishNetItem } from "@kar-mi/spirit-vale-tools-items";
import { fishNetMarketStatName } from "@kar-mi/spirit-vale-tools-market";
import type { LootItemView, LootLine } from "../shared/contracts.ts";
import { LOOT_KINDS, type LootKind, type StackKind } from "../shared/loot-kinds.ts";
import type { OwnedGear, RollLine } from "./filter/types.ts";
import { ARTIFACT_SLOT_NAMES, type SaviArtifact, type SaviCosmetic, type SaviEquip, type SaviGem, type SaviStack, type SaviSubstat } from "./types.ts";

type CatalogEntry = {
  name: string;
  icon?: string;
  kind: string;
  section?: string | null;
  slot?: string | null;
};

type DecodedLine = LootLine & { top: boolean };
export type Facts = OwnedGear & { view: Omit<LootItemView, "match"> };

const catalogPath = existsSync(path.join(import.meta.dir, "catalog.json"))
  ? path.join(import.meta.dir, "catalog.json")
  : path.join(import.meta.dir, "../../assets/catalog.json");
const exactCatalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, CatalogEntry>;
const attributeStats: Readonly<Record<string, true>> = { Str: true, Vit: true, Agi: true, Dex: true, Int: true, Luk: true };
const capGroupBySlot: Readonly<Record<string, string>> = {
  Accessory: "Accessory",
  Back: "Accessory",
  Eyewear: "Accessory",
  Chest: "Chest",
  Feet: "Feet",
  Head: "Headgear",
  Legs: "Legs",
  Shield: "Shield",
  Book: "Magic",
  Grimoire: "Magic",
  Wand: "Magic",
  Bow: "Ranged",
  GatlingGun: "Ranged",
  Launcher: "Ranged",
  Pistol: "Ranged",
  Rifle: "Ranged",
  Shotgun: "Ranged",
  Axe: "Melee",
  Dagger: "Melee",
  Katar: "Melee",
  Mace: "Melee",
  Scythe: "Melee",
  Spear: "Melee",
  Sword: "Melee",
  Twinblade: "Melee",
};
const caps: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  Accessory: { HpMult: 2, MpMult: 2, AtkMult: 2, MatkMult: 2, Crit: 5, Hit: 10, AtkSpd: 5 },
  Artifact: { HpMult: 2, MpMult: 2, AtkMult: 2, MatkMult: 2 },
  Chest: { HpMult: 10, MpMult: 10, Def: 10, Mdef: 10, DefMult: 5, MdefMult: 5, DamageFromMelee: -5, DamageFromMagic: -5, HealingReceived: 10, PerfectDodge: 5 },
  Feet: { AtkSpd: 10, MoveSpd: 10, CastSpd: 10, AtkSpdLimit: 1 },
  Headgear: { HpMult: 2, MpMult: 2, AtkMult: 2, MatkMult: 2, Atk: 3, Matk: 3, Def: 5, Mdef: 5 },
  Legs: { HpRegenMult: 25, MpRegenMult: 25, Leech: 5, CastSpd: 10, Flee: 15, PerfectDodge: 5, MpCost: -10 },
  Magic: { AtkMult: 5, MatkMult: 5, DamageMelee: 5, DamageMagic: 5, CastSpd: 10, MpCost: -10, AtkSpd: 10, Atk: 5, Matk: 5 },
  Melee: { AtkMult: 5, MatkMult: 5, DamageMelee: 5, DamageMagic: 5, CastSpd: 10, MpCost: -10, AtkSpd: 10, Atk: 5, Matk: 5 },
  Ranged: { AtkMult: 5, MatkMult: 5, DamageMelee: 5, DamageMagic: 5, CastSpd: 10, MpCost: -10, AtkSpd: 10, Atk: 5, Matk: 5 },
  Shield: { HpMult: 10, MpMult: 10, Def: 10, Mdef: 10, DefMult: 5, MdefMult: 5, DamageFromMelee: -5, DamageFromMagic: -5, HealingReceived: 10, PerfectDodge: 5 },
};

function scaledValue(roll: number, cap: number): number {
  const value = cap * (2 / 3 + roll / 300);
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function capFor(kind: "equipment" | "artifact", group: string | undefined, stat: string): number | undefined {
  if (attributeStats[stat]) return 3;
  if (kind === "artifact") return caps.Artifact?.[stat];
  if (group) return caps[group]?.[stat];

  const values = new Set(
    Object.entries(caps)
      .filter(([name]) => name !== "Artifact")
      .map(([, pool]) => pool[stat])
      .filter((value): value is number => value !== undefined),
  );
  return values.size === 1 ? values.values().next().value : undefined;
}

function decodeLine(
  kind: "equipment" | "artifact",
  group: string | undefined,
  substat: SaviSubstat,
  chaos: boolean,
  lastIndex: number,
): DecodedLine {
  const stat = fishNetMarketStatName(substat.type) ?? `Stat ${substat.type}`;
  const cap = capFor(kind, group, stat);
  const printed = cap === undefined ? null : scaledValue(substat.roll, cap);
  return {
    stat,
    rollPct: substat.roll,
    printed,
    isChaos: chaos && substat.index === lastIndex,
    over: substat.roll > 100,
    top: cap !== undefined && printed !== null
      && (cap >= 0 ? printed >= scaledValue(100, cap) : printed <= scaledValue(100, cap)),
  };
}

function makeFacts(
  kind: "equipment" | "artifact",
  item: SaviEquip | SaviArtifact,
  highRollThreshold: number,
): Facts {
  const baseExact = exactCatalog[item.itemId];
  const artifactSlot = kind === "artifact" ? ARTIFACT_SLOT_NAMES[item.slot] : undefined;
  const exact = kind === "artifact" && baseExact && artifactSlot
    ? exactCatalog[`${baseExact.name} ${artifactSlot}`] ?? baseExact
    : baseExact;
  const definition = resolveFishNetItem(kind === "equipment" ? 2 : 3, item.itemId);
  const group = kind === "artifact" ? "Artifact" : definition?.substatGroup ?? (exact?.slot ? capGroupBySlot[exact.slot] : undefined);
  const chaos = kind === "equipment" && (item as SaviEquip).chaosType >= 0;
  const decoded = item.substats
    .filter((value): value is SaviSubstat => value !== null)
    .map((substat) => decodeLine(kind, group, substat, chaos, item.substats.length - 1));
  const allResolved = decoded.every((line) => line.printed !== null);
  const topRolls = allResolved ? decoded.filter((line) => line.top).length : null;
  const avgRollPct = decoded.length
    ? Math.round(decoded.reduce((sum, line) => sum + line.rollPct, 0) / decoded.length)
    : null;
  const highRolls = decoded.filter((line) => line.rollPct >= highRollThreshold).length;
  const type = artifactSlot ?? exact?.slot ?? definition?.substatGroup ?? "Unknown";
  const name = exact?.name ?? definition?.displayName ?? item.itemId;
  const uid = item.uid ?? `${item.itemId}:${kind}:${item.slot}`;
  const hasChaos = chaos || decoded.some((line) => line.over);
  const lines: RollLine[] = decoded.map(({ stat, rollPct, printed, isChaos, over }) => ({
    stat,
    base: printed ?? Number.NaN,
    rollPct,
    isChaos,
    over,
  }));

  return {
    uid,
    itemId: item.itemId,
    name,
    slotType: type,
    refine: item.refine,
    lines,
    topRolls,
    highRolls,
    avgRollPct,
    favorite: item.favorite,
    hasChaos,
    ...(definition || exact ? {} : { unknown: true as const }),
    view: {
      uid,
      itemId: item.itemId,
      name,
      type,
      // A grimoire is equipment on the wire but its own thing in the bag.
      kind: exact?.slot === "Grimoire" ? "grimoire" : kind,
      icon: exact?.icon ? path.basename(exact.icon) : null,
      refine: item.refine,
      count: 1,
      favorite: item.favorite,
      hasChaos,
      topRolls,
      highRolls,
      avgRollPct,
      lines: decoded.map(({ stat, rollPct, printed, isChaos, over }) => ({
        stat,
        rollPct,
        printed,
        isChaos,
        over,
      })),
    },
  };
}

export function equipmentFacts(item: SaviEquip, highRollThreshold = 90): Facts {
  return makeFacts("equipment", item, highRollThreshold);
}

export function artifactFacts(item: SaviArtifact, highRollThreshold = 90): Facts {
  return makeFacts("artifact", item, highRollThreshold);
}

/**
 * One bag entry for an item that carries no rolls: gems, cosmetics, and the counted stacks.
 * The local catalog wins on names and icons; the bundled FishNet directory covers the ids it
 * lacks, which is most materials and every cosmetic.
 */
function flatFacts(kind: LootKind, item: { itemId: string; favorite: boolean }, uid: string, refine: number, count: number): Facts {
  const { flatType, itemType } = LOOT_KINDS[kind];
  const type = flatType ?? "Unknown";
  const exact = exactCatalog[item.itemId];
  const definition = resolveFishNetItem(itemType, item.itemId);
  const name = exact?.name ?? definition?.displayName ?? item.itemId;
  const view = {
    uid,
    itemId: item.itemId,
    name,
    type,
    kind,
    icon: exact?.icon ? path.basename(exact.icon) : null,
    refine,
    count,
    favorite: item.favorite,
    hasChaos: false,
    topRolls: 0,
    highRolls: 0,
    avgRollPct: null,
    lines: [],
  };
  return {
    uid,
    itemId: item.itemId,
    name,
    slotType: type,
    refine,
    lines: [],
    topRolls: 0,
    highRolls: 0,
    avgRollPct: null,
    favorite: item.favorite,
    hasChaos: false,
    ...(definition || exact ? {} : { unknown: true as const }),
    view,
  };
}

export function gemFacts(item: SaviGem): Facts {
  return flatFacts("gem", item, item.uid ?? `${item.itemId}:gem`, item.refine, 1);
}

export function cosmeticFacts(item: SaviCosmetic): Facts {
  return flatFacts("cosmetic", item, item.uid ?? `${item.itemId}:cosmetic`, item.refine, 1);
}

export function stackFacts(item: SaviStack, kind: StackKind): Facts {
  return flatFacts(kind, item, `${item.itemId}:${kind}`, 0, item.count);
}
