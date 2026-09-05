import { applySnapshotDelta, snapshotRevision, validateSyncListings } from "./market-sync.ts";
import type { MarketListing } from "../core/market-value.ts";
import type { MarketPricesView } from "../shared/contracts.ts";
import { MARKET_API_URL } from "./market-contracts.ts";
import { errorLogFields, type AppLogger } from "./market-logger.ts";
import { errorMessage, isRecord, loadJson, writeJsonAtomic } from "./market-storage.ts";

const REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
const RETRY_INTERVAL_MS = 2 * 60 * 1_000;

// Allow publication to finish, then spread clients across a 30-second window.
export function nextMarketCheckAt(fetchedAt: number, staggerMs = 0): number {
  const offset = 60_000 + staggerMs;
  return (Math.floor((fetchedAt - offset) / REFRESH_INTERVAL_MS) + 1) * REFRESH_INTERVAL_MS + offset;
}

interface SnapshotState {
  fetchedAt: number;
  etag?: string;
  generatedAt: string;
  body: Record<string, unknown>;
  listings: MarketListing[];
}

export interface MarketSnapshotOptions {
  cachePath: string;
  endpoint?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  logger?: AppLogger;
  staggerMs?: number;
}

// The one place the collector and the Market frame get the public ValeMarket snapshot from.
// Checks shortly after ten-minute publication boundaries, with concurrent
// callers sharing a single download, and keeps stale data across failures so bag pricing
// degrades to old numbers rather than none. The cache stores the API body untouched.
export class MarketSnapshot {
  private byItem = new Map<string, MarketListing[]>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<boolean> | undefined;
  private nextRetryAt = 0;
  private fullResync = false;
  private readonly lifetime = new AbortController();
  private fetchWarning: string | undefined;
  private cacheWarning: string | undefined;
  private readonly staggerMs: number;
  private readonly endpoint: string;
  private readonly fetch: NonNullable<MarketSnapshotOptions["fetch"]>;
  private readonly now: () => Date;

  private constructor(private readonly options: MarketSnapshotOptions, private state: SnapshotState | null) {
    this.endpoint = (options.endpoint ?? MARKET_API_URL).replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.staggerMs = options.staggerMs ?? Math.floor(Math.random() * 30_000);
    this.index();
  }

  static async load(options: MarketSnapshotOptions): Promise<MarketSnapshot> {
    const now = (options.now ?? (() => new Date()))().getTime();
    const state = await loadJson<SnapshotState | null>(options.cachePath, () => null, (value) => parseCache(value, now), (error) => {
      options.logger?.warn("state.load.invalid", { state: "market-snapshot", ...errorLogFields(error) });
    });
    return new MarketSnapshot(options, state);
  }

  listingsFor(itemId: string): MarketListing[] {
    return this.byItem.get(itemId) ?? [];
  }

  view(): MarketPricesView {
    return {
      generatedAt: this.state?.generatedAt ?? null,
      listings: this.state?.listings.length ?? 0,
      ...(this.fetchWarning === undefined ? {} : { warning: this.fetchWarning }),
      ...(this.cacheWarning === undefined ? {} : { cacheWarning: this.cacheWarning }),
    };
  }

  // The API body as last downloaded, refreshed first when it is due. Null only when nothing
  // has ever been fetched and the download fails.
  async body(refresh = false): Promise<Record<string, unknown> | null> {
    await (refresh ? this.refresh() : this.ensureFresh());
    return this.state?.body ?? null;
  }

  async ensureFresh(): Promise<boolean> {
    if (this.dueIn() > 0) return true;
    return this.refresh();
  }

  refresh(): Promise<boolean> {
    // Cache reads and the background timer share the same failure cooldown.
    if (this.now().getTime() < this.nextRetryAt) return Promise.resolve(false);
    this.inflight ??= this.download().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  start(): void {
    this.schedule(this.dueIn());
  }

  stop(): void {
    clearTimeout(this.refreshTimer);
    this.lifetime.abort();
  }

  private dueIn(): number {
    return this.state ? Math.max(0, nextMarketCheckAt(this.state.fetchedAt, this.staggerMs) - this.now().getTime()) : 0;
  }

  private async download(): Promise<boolean> {
    let next: SnapshotState;
    let mode = "full";
    const revision = !this.fullResync && this.state ? snapshotRevision(this.state.body) : undefined;
    const etag = !this.fullResync ? this.state?.etag : undefined;
    try {
      const route = revision ? `changes?since=${encodeURIComponent(revision)}` : "snapshot";
      const response = await this.fetch(`${this.endpoint}/v2/markets/global/${route}`, {
        headers: { "Cache-Control": "no-cache", ...(etag ? { "If-None-Match": etag } : {}) },
        // Bun treats 304 as a redirect with "error". Manual still refuses to
        // follow redirects, while allowing unchanged responses through.
        redirect: "manual",
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok && response.status !== 304) {
        const retry = response.headers.get("retry-after");
        const seconds = retry !== null && /^\d+$/.test(retry) ? Number(retry) * 1_000 : Date.parse(retry ?? "") - this.now().getTime();
        if (Number.isFinite(seconds)) this.nextRetryAt = this.now().getTime() + Math.max(0, seconds);
        if (revision && (response.status === 400 || response.status === 404 || response.status === 410)) this.fullResync = true;
        throw new Error(`market snapshot returned HTTP ${response.status}`);
      }
      const fetchedAt = this.now().getTime();
      let body: unknown;
      if (response.status === 304) {
        if (!this.state || (!revision && !etag)) throw new Error("unexpected unchanged snapshot response");
        body = this.state.body;
        mode = "unchanged";
      } else {
        try {
          const payload: unknown = await response.json();
          if (isRecord(payload) && "deltas" in payload) {
            if (!this.state) throw new Error("delta without a cached snapshot");
            body = applySnapshotDelta(this.state.body, payload);
            mode = "delta";
          } else body = payload;
        } catch (error) {
          if (revision) this.fullResync = true;
          throw error;
        }
      }
      let parsed: ReturnType<typeof parseBody>;
      try {
        parsed = parseBody(body, fetchedAt);
        if (!parsed) throw new Error("market snapshot returned an invalid response");
      } catch (error) {
        if (revision) this.fullResync = true;
        throw error;
      }
      const nextEtag = response.headers.get("etag") ?? (response.status === 304 ? etag : undefined);
      next = { fetchedAt, ...parsed, ...(nextEtag ? { etag: nextEtag } : {}) };
    } catch (error) {
      this.nextRetryAt = Math.max(this.nextRetryAt, this.now().getTime() + RETRY_INTERVAL_MS);
      this.fetchWarning = `Market prices ${this.state ? "may be stale" : "are unavailable"}: ${errorMessage(error)}`;
      this.options.logger?.warn("market_snapshot.refresh_failed", errorLogFields(error));
      return false;
    }
    this.state = next;
    this.nextRetryAt = 0;
    this.fullResync = false;
    this.fetchWarning = undefined;
    this.index();
    this.options.logger?.info("market_snapshot.refreshed", { generatedAt: next.generatedAt, listings: next.listings.length, mode });
    try {
      await writeJsonAtomic(this.options.cachePath, { fetchedAt: new Date(next.fetchedAt).toISOString(), body: next.body, ...(next.etag ? { etag: next.etag } : {}) });
      this.cacheWarning = undefined;
    } catch (error) {
      this.cacheWarning = `Market snapshot could not be cached: ${errorMessage(error)}`;
      this.options.logger?.warn("market_snapshot.cache_failed", errorLogFields(error));
    }
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.lifetime.signal.aborted) return;
    this.refreshTimer = setTimeout(() => {
      void this.ensureFresh().then((ok) => this.schedule(ok ? Math.max(this.dueIn(), RETRY_INTERVAL_MS) : RETRY_INTERVAL_MS));
    }, delayMs);
  }

  private index(): void {
    this.byItem = new Map();
    for (const listing of this.state?.listings ?? []) {
      const group = this.byItem.get(listing.itemId) ?? [];
      group.push(listing);
      this.byItem.set(listing.itemId, group);
    }
  }
}

function parseCache(value: unknown, now: number): SnapshotState | null {
  if (!isRecord(value) || typeof value.fetchedAt !== "string") return null;
  const fetchedAt = Date.parse(value.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return null;
  const parsed = parseBody(value.body, now);
  return parsed ? { fetchedAt, ...parsed, ...(typeof value.etag === "string" ? { etag: value.etag } : {}) } : null;
}

function parseBody(value: unknown, now: number): Omit<SnapshotState, "fetchedAt"> | null {
  if (!isRecord(value) || value.marketId !== "global" || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.listings)) return null;
  if (value.revision !== undefined) {
    if (!snapshotRevision(value)) return null;
    validateSyncListings(value.listings);
  }
  const listings: MarketListing[] = [];
  for (const entry of value.listings) {
    const listing = parseListing(entry, now);
    if (listing) listings.push(listing);
  }
  return { generatedAt: value.generatedAt, body: value, listings };
}

function parseListing(value: unknown, now: number): MarketListing | null {
  if (!isRecord(value) || typeof value.itemId !== "string" || typeof value.unitPrice !== "number" || !Array.isArray(value.stats)) return null;
  if (typeof value.expiresAt === "string" && Date.parse(value.expiresAt) <= now) return null;
  const stats: MarketListing["stats"] = [];
  for (const stat of value.stats) {
    if (isRecord(stat) && typeof stat.name === "string" && typeof stat.value === "number") stats.push({ name: stat.name, value: stat.value });
  }
  const enhancements = isRecord(value.enhancements) ? value.enhancements : {};
  return {
    itemId: value.itemId,
    unitPrice: value.unitPrice,
    stats,
    refine: typeof enhancements.refine === "number" ? enhancements.refine : 0,
    artifactSlot: typeof enhancements.artifactSlot === "number" ? enhancements.artifactSlot : null,
  };
}
