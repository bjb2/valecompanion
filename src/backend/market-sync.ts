import { isRecord } from "./market-storage.ts";

const REVISION = /^[0-9a-f-]{36}$/;
const LISTING_KEY = /^[0-9a-f]{64}$/;
const MAX_LISTINGS = 250_000;

export function snapshotRevision(body: Record<string, unknown>): string | undefined {
  return typeof body.revision === "string" && REVISION.test(body.revision) ? body.revision : undefined;
}

export function validateSyncListings(listings: unknown[]): void {
  if (listings.length > MAX_LISTINGS) throw new Error("snapshot listing limit exceeded");
  const keys = new Set<string>();
  for (const listing of listings) {
    const key = listingKey(listing);
    if (keys.has(key)) throw new Error("duplicate snapshot listing");
    keys.add(key);
  }
}

function listingKey(value: unknown): string {
  if (!isRecord(value) || typeof value.listingKey !== "string" || !LISTING_KEY.test(value.listingKey)
    || typeof value.itemId !== "string" || typeof value.unitPrice !== "number" || !Number.isFinite(value.unitPrice)
    || value.unitPrice < 0 || !Array.isArray(value.stats)) throw new Error("invalid sync listing");
  return value.listingKey;
}

// Validate and apply to a new map. Never mutate the last usable snapshot while
// processing an untrusted or interrupted delta response.
export function applySnapshotDelta(base: Record<string, unknown>, payload: unknown): Record<string, unknown> {
  const from = snapshotRevision(base);
  if (!from || !Array.isArray(base.listings) || !isRecord(payload) || payload.marketId !== "global"
    || payload.fromRevision !== from || !snapshotRevision(payload) || !Array.isArray(payload.deltas)
    || payload.deltas.length === 0 || payload.deltas.length > 12
    || typeof payload.generatedAt !== "string" || !Number.isFinite(Date.parse(payload.generatedAt))
    || Date.parse(payload.generatedAt) < Date.parse(String(base.generatedAt))) throw new Error("invalid snapshot delta base");
  const listings = new Map(base.listings.map((listing) => [listingKey(listing), listing]));
  let revision = from;
  const revisions = new Set([revision]);
  for (const delta of payload.deltas) {
    if (!isRecord(delta) || delta.fromRevision !== revision || !snapshotRevision(delta)
      || revisions.has(String(delta.revision)) || !Array.isArray(delta.operations)
      || delta.operations.length > 2 * MAX_LISTINGS) throw new Error("invalid snapshot delta chain");
    const touched = new Set<string>();
    for (const operation of delta.operations) {
      if (!isRecord(operation)) throw new Error("invalid snapshot operation");
      const remove = typeof operation.remove === "string";
      const key = remove ? String(operation.remove) : listingKey(operation.upsert);
      if (!LISTING_KEY.test(key) || touched.has(key) || (remove && operation.upsert !== undefined)) {
        throw new Error("invalid snapshot operation key");
      }
      touched.add(key);
      if (remove) listings.delete(key);
      else listings.set(key, operation.upsert);
    }
    if (listings.size > MAX_LISTINGS) throw new Error("snapshot listing limit exceeded");
    revision = String(delta.revision);
    revisions.add(revision);
  }
  if (revision !== payload.revision) throw new Error("incomplete snapshot delta chain");
  return { ...base, revision, generatedAt: payload.generatedAt,
    listings: [...listings.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, listing]) => listing) };
}
