import {
  catalogItemType,
  marketListingKey,
  parseFishNetMarketStats,
  resolveFishNetMarketListingDisplayName,
  type FishNetMarketEvent,
  type FishNetMarketListing,
} from "@kar-mi/spirit-vale-tools-market";
import { printedSubstatValue } from "../core/catalog.ts";
import {
  canonicalObservationPayload,
  sha256Hex,
  type MarketUploadEnhancements,
  type MarketUploadGem,
  type MarketUploadObservation,
  type MarketUploadStat,
} from "./market-contracts.ts";

export async function normalizeMarketEvent(
  event: FishNetMarketEvent,
  capturedAt = new Date(),
): Promise<MarketUploadObservation[]> {
  let listings: FishNetMarketListing[];
  if (event.kind === "searchPage") {
    if (!event.page.success) return [];
    listings = event.page.listings;
  } else if (event.kind === "stallListings") {
    listings = (event.listings ?? []).filter((listing): listing is FishNetMarketListing => listing !== null);
  } else {
    return [];
  }

  const observations: MarketUploadObservation[] = [];
  for (const listing of listings) {
    const observation = await normalizeListing(listing, capturedAt);
    if (observation !== undefined) observations.push(observation);
  }
  return observations;
}

export async function normalizeListing(
  listing: FishNetMarketListing,
  capturedAt = new Date(),
): Promise<MarketUploadObservation | undefined> {
  if (listing.item.itemId === null) return undefined;
  const listingVersion = safeBigInt(listing.version, "listing version");
  const unitPrice = safeBigInt(listing.unitPrice, "unit price");
  if (!Number.isSafeInteger(listing.item.itemType) || listing.item.itemType < 0) throw new Error("market item type is invalid");
  if (!Number.isSafeInteger(listing.availableQuantity) || listing.availableQuantity < 0) throw new Error("market quantity is invalid");
  if (!Number.isSafeInteger(listing.status) || listing.status < 0) throw new Error("market status is invalid");

  const itemType = catalogItemType(listing.item.itemType);
  const parsedStats = parseFishNetMarketStats(
    listing.item.payloadJson,
    itemType,
    listing.item.itemId,
  ) ?? [];
  const statKind = itemType === 2 ? "equipment" : itemType === 3 ? "artifact" : undefined;
  const stats: MarketUploadStat[] = parsedStats.map((stat) => {
    const value = stat.value ?? (statKind !== undefined && stat.name !== undefined
      ? printedSubstatValue(statKind, listing.item.itemId!, stat.name, stat.roll)
      : undefined);
    return {
      type: stat.type,
      ...(stat.name === undefined ? {} : { name: stat.name }),
      ...(value === undefined ? {} : { value }),
      percent: stat.percent,
    };
  });
  const enhancements = parseMarketEnhancements(listing.item.payloadJson, listing.item.itemType);
  const observedAt = listing.updatedAt > 0n
    ? unixSecondsToIso(listing.updatedAt, "listing update")
    : capturedAt.toISOString();
  const expiresAt = listing.expiresAt > 0n
    ? unixSecondsToIso(listing.expiresAt, "listing expiry")
    : null;
  const observation: MarketUploadObservation = {
    reportId: crypto.randomUUID(),
    listingKey: await sha256Hex(marketListingKey(listing)),
    listingVersion,
    payloadHash: "",
    itemType: listing.item.itemType,
    itemId: listing.item.itemId,
    displayName: resolveFishNetMarketListingDisplayName(listing),
    unitPrice,
    quantity: listing.availableQuantity,
    status: listing.status,
    stats,
    ...(enhancements === undefined ? {} : { enhancements }),
    observedAt,
    expiresAt,
  };
  observation.payloadHash = await sha256Hex(canonicalObservationPayload(observation));
  return observation;
}

export function parseMarketEnhancements(payloadJson: string | null, itemType: number): MarketUploadEnhancements | undefined {
  if (payloadJson === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const keys = ["Refine", "StartingPotential", "SpentPotential", "Cards", "Gems"];
  if (!keys.some((key) => Object.hasOwn(value, key))) return undefined;

  const refine = enhancementInteger(value.Refine);
  const startingPotential = enhancementInteger(value.StartingPotential);
  const spentPotential = enhancementInteger(value.SpentPotential);
  const cards = enhancementCards(value.Cards);
  const gems = enhancementGems(value.Gems);
  const hasArtifactSlot = itemType === 4 && value.Slot !== undefined && value.Slot !== null;
  const artifactSlot = hasArtifactSlot ? enhancementInteger(value.Slot) : undefined;
  if (refine === undefined
      || startingPotential === undefined
      || spentPotential === undefined
      || cards === undefined
      || gems === undefined
      || (hasArtifactSlot && (artifactSlot === undefined || artifactSlot > 3))) return undefined;
  return {
    refine,
    startingPotential,
    spentPotential,
    cards,
    gems,
    ...(artifactSlot === undefined ? {} : { artifactSlot }),
  };
}

function enhancementInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function enhancementCards(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const cards: string[] = [];
  for (const card of value) {
    if (typeof card !== "string" || card.length === 0 || card.length > 256) return undefined;
    cards.push(card);
  }
  return cards;
}

function enhancementGems(value: unknown): MarketUploadGem[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const gems: MarketUploadGem[] = [];
  for (const gem of value) {
    if (!isRecord(gem)
        || typeof gem.Id !== "string"
        || gem.Id.length === 0
        || gem.Id.length > 256) return undefined;
    const refine = enhancementInteger(gem.Refine);
    if (refine === undefined) return undefined;
    gems.push({ itemId: gem.Id, refine });
  }
  return gems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeBigInt(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the upload safe-integer contract`);
  return Number(value);
}

function unixSecondsToIso(value: bigint, label: string): string {
  const seconds = safeBigInt(value, label);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${label} exceeds the JavaScript timestamp range`);
  const timestamp = new Date(milliseconds);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} is invalid`);
  return timestamp.toISOString();
}
