import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveFishNetItem } from "@kar-mi/spirit-vale-tools-items";
import { fishNetMarketStatName } from "@kar-mi/spirit-vale-tools-market";
import substatPools from "../../assets/substat-pools.json";
import type { LootItemView, LootLine } from "../shared/contracts.ts";
import type { OwnedGear, RollLine } from "./filter/types.ts";
import { ARTIFACT_SLOT_NAMES, type SaviArtifact, type SaviEquip, type SaviGem, type SaviStack, type SaviSubstat } from "./types.ts";

type CatalogEntry = {
  name: string;
  icon?: string;
  kind: string;
  section?: string | null;
  slot?: string | null;
};

type DecodedLine = LootLine & { top: boolean };
type Facts = OwnedGear & { view: Omit<LootItemView, "match"> };

const catalogPath = existsSync(path.join(import.meta.dir, "catalog.json"))
  ? path.join(import.meta.dir, "catalog.json")
  : path.join(import.meta.dir, "../../assets/catalog.json");
const exactCatalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, CatalogEntry>;
const cosmeticCatalog = JSON.parse(readFileSync(path.join(path.dirname(catalogPath), "cosmetics.json"), "utf8")) as Record<string, CatalogEntry>;
const attributeStats: Readonly<Record<string, true>> = { Str: true, Vit: true, Agi: true, Dex: true, Int: true, Luk: true };
// Build-scoped game data, including explicit item overrides and compiled defaults.
// Imported JSON is bundled into the collector; no runtime asset lookup is needed.
const caps: Readonly<Record<string, Readonly<Record<string, number>>>> = substatPools.caps;
const equipmentPools: Readonly<Record<string, string>> = substatPools.equipment;

function scaledValue(roll: number, cap: number): number {
  // Match the client's float32 SSE operations before rounding away from zero.
  const factor = Math.fround(Math.fround(Math.fround(Math.fround(roll) / 100) * Math.fround(1 / 3)) + Math.fround(2 / 3));
  const value = Math.fround(Math.abs(cap) * factor) * Math.sign(cap);
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
  const group = kind === "artifact" ? "Artifact" : equipmentPools[item.itemId];
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
      // A grimoire is equipment on the wire and its own thing in the bag.
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

export function gemFacts(item: SaviGem): Facts {
  const exact = exactCatalog[item.itemId];
  const definition = resolveFishNetItem(5, item.itemId);
  const uid = item.uid ?? `${item.itemId}:gem`;
  const name = exact?.name ?? definition?.displayName ?? item.itemId;
  return {
    uid,
    itemId: item.itemId,
    name,
    slotType: "Gem",
    refine: item.refine,
    lines: [],
    topRolls: 0,
    highRolls: 0,
    avgRollPct: null,
    favorite: item.favorite,
    hasChaos: false,
    ...(definition || exact ? {} : { unknown: true as const }),
    view: {
      uid,
      itemId: item.itemId,
      name,
      type: "Gem",
      kind: "gem",
      icon: exact?.icon ? path.basename(exact.icon) : null,
      refine: item.refine,
      count: 1,
      favorite: item.favorite,
      hasChaos: false,
      topRolls: 0,
      highRolls: 0,
      avgRollPct: null,
      lines: [],
    },
  };
}

export function cardFacts(item: SaviStack): Facts {
  const exact = exactCatalog[item.itemId];
  const uid = `${item.itemId}:card`;
  const name = exact?.name ?? item.itemId;
  return {
    uid,
    itemId: item.itemId,
    name,
    slotType: "Card",
    refine: 0,
    lines: [],
    topRolls: 0,
    highRolls: 0,
    avgRollPct: null,
    favorite: item.favorite,
    hasChaos: false,
    ...(exact ? {} : { unknown: true as const }),
    view: {
      uid,
      itemId: item.itemId,
      name,
      type: "Card",
      kind: "card",
      icon: exact?.icon ? path.basename(exact.icon) : null,
      refine: 0,
      count: item.count,
      favorite: item.favorite,
      hasChaos: false,
      topRolls: 0,
      highRolls: 0,
      avgRollPct: null,
      lines: [],
    },
  };
}

// Item IDs overlap across game categories (for example Turtle is both a card and a pet).
// Only use artwork from a catalog entry whose category matches the wire inventory.
export function stackFacts(item: SaviStack, kind: "material" | "consumable"): Facts {
  return simpleInventoryFacts(item, kind);
}

export function cosmeticFacts(item: SaviGem): Facts {
  return simpleInventoryFacts({ ...item, count: 1 }, "cosmetic");
}

function simpleInventoryFacts(item: SaviStack & { uid?: string | null; refine?: number }, kind: "material" | "consumable" | "cosmetic"): Facts {
  const type = { material: "Material", consumable: "Consumable", cosmetic: "Cosmetic" }[kind];
  const itemType = { material: 0, consumable: 1, cosmetic: 6 }[kind];
  const entry = kind === "cosmetic" ? cosmeticCatalog[item.itemId] : exactCatalog[item.itemId];
  const exact = entry?.kind === type ? entry : undefined;
  const definition = resolveFishNetItem(itemType, item.itemId);
  const name = exact?.name ?? definition?.displayName ?? item.itemId;
  const uid = item.uid ?? `${item.itemId}:${kind}`;
  const refine = item.refine ?? 0;
  return {
    uid, itemId: item.itemId, name, slotType: type, refine, lines: [],
    topRolls: 0, highRolls: 0, avgRollPct: null, favorite: item.favorite, hasChaos: false,
    ...(exact || definition ? {} : { unknown: true as const }),
    view: {
      uid, itemId: item.itemId, name, type, kind, refine, count: item.count,
      icon: exact?.icon ? path.basename(exact.icon) : null,
      favorite: item.favorite, hasChaos: false, topRolls: 0, highRolls: 0, avgRollPct: null, lines: [],
    },
  };
}
