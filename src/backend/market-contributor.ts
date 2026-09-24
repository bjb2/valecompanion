import { CURRENT_GAME_BUILD_FINGERPRINT, type CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import { readSignedPackedWhole } from "@kar-mi/spirit-vale-tools-capture/wire-reader";
import {
  decodeFishNetMarketPacket,
  FishNetMarketTracker,
  type FishNetMarketEvent,
} from "@kar-mi/spirit-vale-tools-market";
import {
  MARKET_API_URL,
  MARKET_PACKAGE_VERSION,
  MARKET_PROTOCOL_VERSION,
  type MarketObservationBatch,
  type MarketUploadObservation,
} from "./market-contracts.ts";
import { normalizeMarketEvent } from "./market-normalizer.ts";
import { errorLogFields, type AppLogger, type LogFields } from "./market-logger.ts";
import { errorMessage, isRecord, loadJson, writeJsonAtomic } from "./market-storage.ts";

type FishNetSearchPageEvent = Extract<FishNetMarketEvent, { kind: "searchPage" }>;

const FLUSH_OBSERVATIONS = 50;
const MAX_BATCH_OBSERVATIONS = 100;
const FLUSH_INTERVAL_MS = 7_500;
const MAX_REQUEST_BYTES = 240 * 1024;
const MAX_RECENT_KEYS = 20_000;
const MAX_RETRY_MS = 5 * 60 * 1_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

interface StoredBatch {
  batch: MarketObservationBatch;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

interface ContributorState {
  schemaVersion: 1;
  installationToken?: string;
  outbox: StoredBatch[];
  recentKeys: string[];
}

export interface ContributorSnapshot {
  prepared: number;
  uploaded: number;
  queuedBatches: number;
  marketEventsDecoded: number;
  searchRequestsDecoded: number;
  listingEventsDecoded: number;
  listingsDecoded: number;
  observationsNormalized: number;
  normalizationDropped: number;
  normalizationErrors: number;
  duplicatesSuppressed: number;
  unresolvedInboundRpcLinks: number;
  lateSessionResponsesRecovered: number;
  lateSessionRecoveryCandidates: number;
  lateSessionRecoveryFramingRejected: number;
  lateSessionRecoveryPayloadCandidates: number;
  lateSessionRecoveryDecodeRejected: number;
  latestObservationAt?: string;
  latestUploadAt?: string;
  warning?: string;
}

export interface MarketContributorOptions {
  statePath: string;
  collectorVersion: string;
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  onState?: (state: ContributorSnapshot) => void;
  logger?: AppLogger;
}

export class MarketContributor {
  private readonly tracker = new FishNetMarketTracker();
  private readonly pending = new Map<string, MarketUploadObservation>();
  private readonly recent = new Set<string>();
  private readonly recentOrder: string[];
  private readonly endpoint: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => Date;
  private readonly metrics: ContributorSnapshot;
  private pendingSearchResponses = 0;
  private lateSessionRecoveryFailuresLogged = 0;
  private operations: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private uploadTimer: ReturnType<typeof setTimeout> | undefined;
  private enabled = false;
  private stopped = false;

  private constructor(
    private readonly options: MarketContributorOptions,
    private readonly state: ContributorState,
  ) {
    this.endpoint = (options.endpoint ?? MARKET_API_URL).replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.recentOrder = [...state.recentKeys];
    for (const key of this.recentOrder) this.recent.add(key);
    this.metrics = {
      prepared: 0,
      uploaded: 0,
      queuedBatches: state.outbox.length,
      marketEventsDecoded: 0,
      searchRequestsDecoded: 0,
      listingEventsDecoded: 0,
      listingsDecoded: 0,
      observationsNormalized: 0,
      normalizationDropped: 0,
      normalizationErrors: 0,
      duplicatesSuppressed: 0,
      unresolvedInboundRpcLinks: 0,
      lateSessionResponsesRecovered: 0,
      lateSessionRecoveryCandidates: 0,
      lateSessionRecoveryFramingRejected: 0,
      lateSessionRecoveryPayloadCandidates: 0,
      lateSessionRecoveryDecodeRejected: 0,
    };
  }

  static async load(options: MarketContributorOptions): Promise<MarketContributor> {
    const state = await loadJson(options.statePath, emptyState, parseState, (error) => {
      options.logger?.warn("state.load.invalid", { state: "contributor", ...errorLogFields(error) });
    });
    return new MarketContributor(options, state);
  }

  snapshot(): ContributorSnapshot {
    return { ...this.metrics, queuedBatches: this.state.outbox.length };
  }

  setEnabled(enabled: boolean): void {
    if (this.stopped || this.enabled === enabled) return;
    this.enabled = enabled;
    this.options.logger?.info("contributor.enabled.changed", { enabled });
    if (!enabled) {
      clearTimeout(this.flushTimer);
      clearTimeout(this.uploadTimer);
      this.flushTimer = undefined;
      this.uploadTimer = undefined;
      this.pending.clear();
      this.pendingSearchResponses = 0;
      this.publish();
      return;
    }
    if (this.state.outbox.length > 0) this.scheduleUpload(0);
  }

  consume(packet: CapturedFishNetPacket): void {
    if (!this.enabled || this.stopped) return;
    const inboundRpcLink = packet.packetName === "rpcLink"
      && packet.liteNetPacket.udpPacket.direction === "inbound";
    const unresolvedInboundRpcLink = inboundRpcLink && packet.linkResolved === false;
    if (unresolvedInboundRpcLink) this.metrics.unresolvedInboundRpcLinks += 1;
    let events;
    try {
      events = this.tracker.consume(packet);
    } catch (error) {
      this.warn(`Could not decode a verified market packet: ${errorMessage(error)}`, errorLogFields(error));
      return;
    }
    if (events.length === 0 && inboundRpcLink) {
      const recovered = this.recoverSearchPage(packet);
      if (recovered !== undefined) {
        events = [this.tracker.apply(recovered)];
        this.metrics.lateSessionResponsesRecovered += 1;
        this.options.logger?.info("contributor.market_response.recovered", {
          linkId: packet.linkId,
          originalLinkResolved: packet.linkResolved,
          originalRpcName: packet.rpcName,
          listings: recovered.page.listings.length,
        });
      }
    }
    if (events.length === 0) {
      if (unresolvedInboundRpcLink) this.publish();
      return;
    }
    const decoded = events.map((event) => {
      let listingCount: number | undefined;
      if (event.kind === "searchPage") listingCount = event.page.listings.length;
      if (event.kind === "stallListings") {
        listingCount = (event.listings ?? []).filter((listing) => listing !== null).length;
      }
      return { event, listingCount };
    });
    this.metrics.marketEventsDecoded += decoded.length;
    for (const result of decoded) {
      if (result.event.kind === "searchRequest") {
        this.metrics.searchRequestsDecoded += 1;
        this.pendingSearchResponses = Math.min(32, this.pendingSearchResponses + 1);
      } else if (result.event.kind === "searchPage") {
        this.pendingSearchResponses = Math.max(0, this.pendingSearchResponses - 1);
      }
      if (result.listingCount === undefined) continue;
      this.metrics.listingEventsDecoded += 1;
      this.metrics.listingsDecoded += result.listingCount;
    }
    this.publish();
    this.enqueue(async () => {
      if (!this.enabled || this.stopped) return;
      for (const result of decoded) {
        let observations;
        try {
          observations = await normalizeMarketEvent(result.event, this.now());
        } catch (error) {
          this.metrics.normalizationErrors += 1;
          this.publish();
          throw error;
        }
        this.metrics.observationsNormalized += observations.length;
        if (result.listingCount !== undefined) {
          this.metrics.normalizationDropped += Math.max(0, result.listingCount - observations.length);
        }
        for (const observation of observations) this.addObservation(observation);
      }
      this.publish();
      if (this.pending.size >= FLUSH_OBSERVATIONS) {
        await this.flushPending();
        await this.uploadOutbox();
      } else if (this.pending.size > 0) {
        this.scheduleFlush();
      }
    });
  }
  private recoverSearchPage(packet: CapturedFishNetPacket): FishNetSearchPageEvent | undefined {
    if (this.pendingSearchResponses === 0) return;
    const transport = packet.liteNetPacket.packet.property;
    if (transport !== "channeled" && transport !== "unreliable") return;
    this.metrics.lateSessionRecoveryCandidates += 1;
    let length;
    try {
      length = readSignedPackedWhole(packet.payload, 0);
    } catch {
      this.metrics.lateSessionRecoveryFramingRejected += 1;
      return;
    }
    if (length.value < 0 || length.nextOffset + length.value !== packet.payload.length) {
      this.metrics.lateSessionRecoveryFramingRejected += 1;
      return;
    }
    const bytes = packet.payload.subarray(length.nextOffset);
    const pageJson = bytes.toString("utf8");
    if (!Buffer.from(pageJson, "utf8").equals(bytes)) {
      this.metrics.lateSessionRecoveryFramingRejected += 1;
      return;
    }
    this.metrics.lateSessionRecoveryPayloadCandidates += 1;
    const candidate: CapturedFishNetPacket = {
      ...packet,
      linkedPacketName: "targetRpc",
      linkResolved: true,
      rpcName: "RequestVendorItemList_T",
      rpcResolution: "verified",
      networkBehaviourType: "PlayerController",
      decodedFields: [{
        name: "pageJson",
        typeName: "System.String",
        codec: "stringUtf8Packed",
        value: pageJson,
      }],
    };
    try {
      const events = decodeFishNetMarketPacket(candidate);
      const event = events.length === 1 ? events[0] : undefined;
      if (event?.kind === "searchPage") return event;
      this.rejectRecoveryCandidate(packet, transport, "decoded payload was not a market search page");
    } catch (error) {
      this.rejectRecoveryCandidate(packet, transport, errorMessage(error));
    }
    return;
  }

  private rejectRecoveryCandidate(packet: CapturedFishNetPacket, transport: string, reason: string): void {
    this.metrics.lateSessionRecoveryDecodeRejected += 1;
    if (this.lateSessionRecoveryFailuresLogged >= 3) return;
    this.lateSessionRecoveryFailuresLogged += 1;
    this.options.logger?.warn("contributor.market_response.recovery_rejected", {
      linkId: packet.linkId,
      transport,
      payloadBytes: packet.payload.length,
      reason,
    });
  }


  async shutdown(): Promise<void> {
    this.options.logger?.info("contributor.shutdown.started", {
      pendingObservations: this.pending.size,
      queuedBatches: this.state.outbox.length,
    });
    clearTimeout(this.flushTimer);
    clearTimeout(this.uploadTimer);
    this.flushTimer = undefined;
    this.uploadTimer = undefined;
    await this.operations;
    if (this.enabled && this.pending.size > 0) await this.flushPending();
    this.stopped = true;
    await this.persist();
    this.options.logger?.info("contributor.shutdown.completed", { queuedBatches: this.state.outbox.length });
  }

  private addObservation(observation: MarketUploadObservation): void {
    const key = deduplicationKey(observation);
    if (this.recent.has(key) || this.pending.has(key)) {
      this.metrics.duplicatesSuppressed += 1;
      return;
    }
    this.pending.set(key, observation);
    this.recent.add(key);
    this.recentOrder.push(key);
    while (this.recentOrder.length > MAX_RECENT_KEYS) {
      const removed = this.recentOrder.shift();
      if (removed !== undefined) this.recent.delete(removed);
    }
    this.metrics.prepared += 1;
    this.metrics.latestObservationAt = this.now().toISOString();
    delete this.metrics.warning;
    this.publish();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.stopped || !this.enabled) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.enqueue(async () => {
        if (!this.enabled || this.stopped) return;
        await this.flushPending();
        await this.uploadOutbox();
      });
    }, FLUSH_INTERVAL_MS);
  }

  private scheduleUpload(delayMs: number): void {
    if (this.stopped || !this.enabled) return;
    clearTimeout(this.uploadTimer);
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = undefined;
      this.enqueue(async () => {
        if (this.enabled && !this.stopped) await this.uploadOutbox();
      });
    }, delayMs);
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operations = this.operations.then(operation).catch((error) => {
      this.warn(errorMessage(error), errorLogFields(error));
    });
  }

  private async flushPending(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    while (this.pending.size > 0) {
      const observations: MarketUploadObservation[] = [];
      const selectedKeys: string[] = [];
      for (const [key, observation] of this.pending) {
        observations.push(observation);
        selectedKeys.push(key);
        const batch = this.createBatch(observations);
        if (encoder.encode(JSON.stringify(batch)).byteLength > MAX_REQUEST_BYTES) {
          observations.pop();
          selectedKeys.pop();
          if (observations.length === 0) throw new Error("One normalized market observation exceeds the upload request limit");
          break;
        }
        if (observations.length >= MAX_BATCH_OBSERVATIONS) break;
      }
      const batch = this.createBatch(observations);
      this.state.outbox.push({ batch, attempts: 0, nextAttemptAt: this.now().toISOString() });
      this.options.logger?.info("contributor.batch.queued", {
        observations: batch.observations.length,
        queuedBatches: this.state.outbox.length,
      });
      for (const key of selectedKeys) this.pending.delete(key);
    }
    this.state.recentKeys = [...this.recentOrder];
    await this.persist();
    this.publish();
  }

  private createBatch(observations: MarketUploadObservation[]): MarketObservationBatch {
    return {
      protocolVersion: MARKET_PROTOCOL_VERSION,
      batchId: crypto.randomUUID(),
      marketId: "global",
      sentAt: this.now().toISOString(),
      collector: {
        version: this.options.collectorVersion,
        gameBuild: CURRENT_GAME_BUILD_FINGERPRINT,
        marketPackageVersion: MARKET_PACKAGE_VERSION,
      },
      observations,
    };
  }

  private async uploadOutbox(): Promise<void> {
    while (this.enabled && !this.stopped && this.state.outbox.length > 0) {
      const entry = this.state.outbox[0]!;
      const delay = Date.parse(entry.nextAttemptAt) - this.now().getTime();
      if (delay > 0) {
        this.scheduleUpload(delay);
        return;
      }
      try {
        const token = await this.installationToken();
        const response = await this.fetch(`${this.endpoint}/v2/observations`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(entry.batch),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 202) {
          this.metrics.uploaded += entry.batch.observations.length;
          this.metrics.latestUploadAt = this.now().toISOString();
          delete this.metrics.warning;
          this.state.outbox.shift();
          await this.persist();
          this.publish();
          this.options.logger?.info("contributor.upload.succeeded", {
            observations: entry.batch.observations.length,
            queuedBatches: this.state.outbox.length,
          });
          continue;
        }
        if (response.status === 401) delete this.state.installationToken;
        const retryAfter = retryAfterMs(response.headers.get("retry-after"), this.now());
        await this.deferEntry(entry, `Market upload returned HTTP ${response.status}`, retryAfter);
      } catch (error) {
        await this.deferEntry(entry, `Market upload failed: ${errorMessage(error)}`, undefined, error);
      }
      return;
    }
  }

  private async installationToken(): Promise<string> {
    if (this.state.installationToken !== undefined) return this.state.installationToken;
    const response = await this.fetch(`${this.endpoint}/v2/installations`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 201) throw new Error(`Contributor registration returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.token !== "string" || !TOKEN.test(body.token)) {
      throw new Error("Contributor registration returned an invalid token");
    }
    this.state.installationToken = body.token;
    await this.persist();
    this.options.logger?.info("contributor.registration.succeeded");
    return body.token;
  }

  private async deferEntry(entry: StoredBatch, message: string, serverDelay?: number, error?: unknown): Promise<void> {
    entry.attempts += 1;
    entry.lastError = message;
    const delay = serverDelay ?? Math.min(MAX_RETRY_MS, 1_000 * (2 ** Math.min(entry.attempts - 1, 8)));
    entry.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    await this.persist();
    this.warn(message, {
      attempt: entry.attempts,
      delayMs: delay,
      ...(error === undefined ? {} : errorLogFields(error)),
    });
    this.scheduleUpload(delay);
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.options.statePath, this.state);
  }

  private warn(message: string, fields: LogFields = {}): void {
    this.metrics.warning = message;
    this.options.logger?.warn("contributor.warning", { message, ...fields });
    this.publish();
  }

  private publish(): void {
    this.options.onState?.(this.snapshot());
  }
}

function emptyState(): ContributorState {
  return { schemaVersion: 1, outbox: [], recentKeys: [] };
}

function parseState(value: unknown): ContributorState {
  if (!isRecord(value) || value.schemaVersion !== 1) return emptyState();
  const installationToken = typeof value.installationToken === "string" && TOKEN.test(value.installationToken)
    ? value.installationToken
    : undefined;
  const outbox = Array.isArray(value.outbox)
    ? value.outbox.map(parseStoredBatch).filter((entry): entry is StoredBatch => entry !== undefined)
    : [];
  const recentKeys = Array.isArray(value.recentKeys)
    ? value.recentKeys.filter((entry): entry is string => typeof entry === "string" && deduplicationKeyPattern(entry)).slice(-MAX_RECENT_KEYS)
    : [];
  return {
    schemaVersion: 1,
    ...(installationToken === undefined ? {} : { installationToken }),
    outbox,
    recentKeys,
  };
}

function parseStoredBatch(value: unknown): StoredBatch | undefined {
  if (!isRecord(value) || !isRecord(value.batch)) return undefined;
  const batch = value.batch;
  const rawObservations = batch.observations;
  if (!Array.isArray(rawObservations)
    || batch.protocolVersion !== MARKET_PROTOCOL_VERSION
    || typeof batch.batchId !== "string"
    || batch.marketId !== "global"
    || typeof batch.sentAt !== "string"
    || !isRecord(batch.collector)
    || typeof batch.collector.version !== "string"
    || typeof batch.collector.gameBuild !== "string"
    || typeof batch.collector.marketPackageVersion !== "string") return undefined;
  const observations = rawObservations.filter(isObservation);
  if (observations.length !== rawObservations.length || observations.length === 0) return undefined;
  const parsedBatch: MarketObservationBatch = {
    protocolVersion: MARKET_PROTOCOL_VERSION,
    batchId: batch.batchId,
    marketId: "global",
    sentAt: batch.sentAt,
    collector: {
      version: batch.collector.version,
      gameBuild: batch.collector.gameBuild,
      marketPackageVersion: batch.collector.marketPackageVersion,
    },
    observations,
  };
  const attempts = Number.isSafeInteger(value.attempts) && Number(value.attempts) >= 0 ? Number(value.attempts) : 0;
  const nextAttemptAt = typeof value.nextAttemptAt === "string" && Number.isFinite(Date.parse(value.nextAttemptAt))
    ? value.nextAttemptAt
    : new Date().toISOString();
  return {
    batch: parsedBatch,
    attempts,
    nextAttemptAt,
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

function isObservation(value: unknown): value is MarketUploadObservation {
  return isRecord(value)
    && typeof value.reportId === "string"
    && typeof value.listingKey === "string" && HASH.test(value.listingKey)
    && typeof value.listingVersion === "number" && Number.isSafeInteger(value.listingVersion)
    && typeof value.payloadHash === "string" && HASH.test(value.payloadHash)
    && typeof value.itemType === "number" && Number.isSafeInteger(value.itemType)
    && typeof value.itemId === "string"
    && (typeof value.displayName === "string" || value.displayName === null)
    && typeof value.unitPrice === "number" && Number.isSafeInteger(value.unitPrice)
    && typeof value.quantity === "number" && Number.isSafeInteger(value.quantity)
    && typeof value.status === "number" && Number.isSafeInteger(value.status)
    && Array.isArray(value.stats)
    && (value.enhancements === undefined || isEnhancements(value.enhancements))
    && typeof value.observedAt === "string"
    && (typeof value.expiresAt === "string" || value.expiresAt === null);
}

function isEnhancements(value: unknown): boolean {
  if (!isRecord(value)
      || !Number.isSafeInteger(value.refine) || Number(value.refine) < 0
      || !Number.isSafeInteger(value.startingPotential) || Number(value.startingPotential) < 0
      || !Number.isSafeInteger(value.spentPotential) || Number(value.spentPotential) < 0
      || !Array.isArray(value.cards) || value.cards.length > 16
      || !value.cards.every((card) => typeof card === "string" && card.length > 0 && card.length <= 256)
      || (value.artifactSlot !== undefined
        && (!Number.isSafeInteger(value.artifactSlot) || Number(value.artifactSlot) < 0 || Number(value.artifactSlot) > 3))
      || !Array.isArray(value.gems) || value.gems.length > 16) return false;
  return value.gems.every((gem) => isRecord(gem)
    && typeof gem.itemId === "string" && gem.itemId.length > 0 && gem.itemId.length <= 256
    && Number.isSafeInteger(gem.refine) && Number(gem.refine) >= 0);
}

function deduplicationKey(observation: MarketUploadObservation): string {
  return `${observation.listingKey}:${observation.listingVersion}:${observation.payloadHash}`;
}

function deduplicationKeyPattern(value: string): boolean {
  const [listingKey, version, payloadHash, extra] = value.split(":");
  return extra === undefined && listingKey !== undefined && HASH.test(listingKey)
    && version !== undefined && /^\d+$/.test(version)
    && payloadHash !== undefined && HASH.test(payloadHash);
}

function retryAfterMs(value: string | null, now: Date): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Math.min(MAX_RETRY_MS, Number(value) * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(MAX_RETRY_MS, Math.max(0, timestamp - now.getTime()));
}
