import type { CapturedFishNetPacket } from "@valecompanion/capture";
import type { GoldAnalyticsView, GoldBucketView, GoldSessionSummaryView } from "../shared/contracts.ts";
import type { SaviSnapshot } from "./types.ts";

const HOUR_MS = 60 * 60 * 1_000;
const RECENT_WINDOW_MS = 15 * 60 * 1_000;
const BUCKET_MS = 5 * 60 * 1_000;
const BUCKET_COUNT = 12;
const EVENT_RETENTION_MS = HOUR_MS;
const MAX_EVENTS = 10_000;
const MAX_PREVIOUS_SESSIONS = 100;

type GoldEvent = { at: number; delta: number };

type PersistedActiveSession = {
  balance: number;
  playerObjectId?: number;
  startingBalance: number;
  startedAt: number;
  lastChangeAt: number | null;
  earned: number;
  spent: number;
  earningEvents: number;
  spendingEvents: number;
  monsterKills: number;
  confirmedMonsterKills?: number;
  lastMonsterKillCount?: number;
  activeMs?: number;
  activeSince?: number;
  activeIntervals?: ActiveInterval[];
  events: GoldEvent[];
};

type ActiveInterval = { from: number; to: number };

export interface PersistedGoldState {
  schema: 1;
  active: PersistedActiveSession | null;
  previousSessions: GoldSessionSummaryView[];
}

export class GoldSession {
  readonly #events: GoldEvent[] = [];
  readonly #previousSessions: GoldSessionSummaryView[] = [];
  #balance: number | null = null;
  #startingBalance: number | null = null;
  #playerObjectId: number | undefined;
  #startedAt: number | null = null;
  #lastChangeAt: number | null = null;
  #earned = 0;
  #spent = 0;
  #earningEvents = 0;
  #spendingEvents = 0;
  #monsterKills = 0;
  #confirmedMonsterKills = 0;
  #lastMonsterKillCount: number | undefined;
  // Rates divide by played time, not wall-clock. Intervals keep the last hour of stretches so the
  // recent-window rate can exclude pauses.
  #activeMs = 0;
  #activeSince: number | null = null;
  readonly #activeIntervals: ActiveInterval[] = [];

  static restore(value: unknown): GoldSession {
    const state = parsePersistedState(value);
    const session = new GoldSession();
    session.#previousSessions.push(...state.previousSessions);
    if (state.active) {
      session.#balance = state.active.balance;
      session.#startingBalance = state.active.startingBalance;
      session.#startedAt = state.active.startedAt;
      session.#lastChangeAt = state.active.lastChangeAt;
      session.#playerObjectId = state.active.playerObjectId;
      session.#earned = state.active.earned;
      session.#spent = state.active.spent;
      session.#earningEvents = state.active.earningEvents;
      session.#spendingEvents = state.active.spendingEvents;
      session.#monsterKills = state.active.monsterKills;
      session.#confirmedMonsterKills = state.active.confirmedMonsterKills
        ?? (state.active.earned > 0 ? state.active.monsterKills : 0);
      session.#lastMonsterKillCount = state.active.lastMonsterKillCount;
      session.#events.push(...state.active.events);
      // Restore starts paused. An in-progress stretch is closed at the last balance change, the
      // latest moment the game is known to have been running. Saves without activeMs predate
      // pausing and are treated as one stretch from the start.
      const { activeMs, activeSince, activeIntervals, startedAt, lastChangeAt } = state.active;
      session.#activeMs = activeMs ?? 0;
      session.#activeSince = activeMs === undefined ? startedAt : activeSince ?? null;
      session.#activeIntervals.push(...(activeIntervals ?? []));
      session.#pause(lastChangeAt ?? startedAt);
    }
    return session;
  }

  setGameActive(active: boolean, at = Date.now()): void {
    if (active) this.#markActive(at);
    else this.#pause(at);
  }

  persisted(): PersistedGoldState {
    return {
      schema: 1,
      active: this.#balance === null || this.#startingBalance === null || this.#startedAt === null
        ? null
        : {
            balance: this.#balance,
            startingBalance: this.#startingBalance,
            startedAt: this.#startedAt,
            lastChangeAt: this.#lastChangeAt,
            activeMs: this.#activeMs,
            ...(this.#activeSince === null ? {} : { activeSince: this.#activeSince }),
            activeIntervals: this.#activeIntervals.map((interval) => ({ ...interval })),
            earned: this.#earned,
            spent: this.#spent,
            earningEvents: this.#earningEvents,
            spendingEvents: this.#spendingEvents,
            monsterKills: this.#monsterKills,
            confirmedMonsterKills: this.#confirmedMonsterKills,
            ...(this.#playerObjectId === undefined ? {} : { playerObjectId: this.#playerObjectId }),
            ...(this.#lastMonsterKillCount === undefined ? {} : { lastMonsterKillCount: this.#lastMonsterKillCount }),
            events: this.#events.map((event) => ({ ...event })),
          },
      previousSessions: this.#previousSessions.map((session) => ({ ...session })),
    };
  }

  consumePacket(packet: CapturedFishNetPacket, observedAt = packet.liteNetPacket.udpPacket.capturedAt.getTime()): boolean {
    if (packet.liteNetPacket.udpPacket.direction === "outbound") return false;
    if (packet.rpcName !== "CoinsCallback_T" && packet.rpcName !== "ExpCoinsChanged_T") return false;

    const coins = numericField(packet, "coins");
    if (coins === undefined || coins < 0) return false;

    if (this.#balance === null) {
      this.#start(coins, observedAt, packet.objectId);
      return true;
    }
    if (packet.objectId !== undefined) this.#playerObjectId = packet.objectId;
    this.consumeBalance(coins, observedAt);
    return true;
  }

  consumeBalance(balance: number, observedAt = Date.now()): void {
    if (!Number.isSafeInteger(balance) || balance < 0) return;
    if (this.#balance === null) {
      this.#start(balance, observedAt, this.#playerObjectId);
      return;
    }
    // A balance update is proof the game is running, whatever the collector last said.
    this.#markActive(observedAt);

    const delta = balance - this.#balance;
    this.#balance = balance;
    if (delta === 0) return;

    if (delta > 0) {
      this.#earned += delta;
      this.#earningEvents++;
    } else {
      this.#spent += -delta;
      this.#spendingEvents++;
    }
    this.#confirmedMonsterKills = this.#monsterKills;
    this.#lastChangeAt = observedAt;
    this.#events.push({ at: observedAt, delta });
    this.#pruneEvents(observedAt);
  }

  consumeSnapshot(snapshot: SaviSnapshot): boolean {
    const count = snapshot.monsterKills;
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) return false;
    if (this.#lastMonsterKillCount === undefined || count < this.#lastMonsterKillCount) {
      this.#lastMonsterKillCount = count;
      return true;
    }
    const added = count - this.#lastMonsterKillCount;
    this.#monsterKills += added;
    this.#lastMonsterKillCount = count;
    return added > 0;
  }

  reset(observedAt = Date.now()): void {
    if (this.#balance === null) return;
    const balance = this.#balance;
    const playerObjectId = this.#playerObjectId;
    const lastMonsterKillCount = this.#lastMonsterKillCount;
    // The next session inherits the pause state: finishing while the game is closed must not start
    // a clock that only a balance update or game detection should resume.
    const active = this.#activeSince !== null;
    this.#archiveCurrent(observedAt);
    this.#start(balance, observedAt, playerObjectId, active);
    this.#lastMonsterKillCount = lastMonsterKillCount;
  }

  end(observedAt = Date.now()): void {
    this.#archiveCurrent(observedAt);
    this.#clearSession();
  }

  clearHistory(): void {
    this.#previousSessions.length = 0;
  }

  deleteSession(id: string): boolean {
    const index = this.#previousSessions.findIndex((session) => session.id === id);
    if (index === -1) return false;
    this.#previousSessions.splice(index, 1);
    return true;
  }

  snapshot(observedAt = Date.now()): GoldAnalyticsView {
    const previousSessions = this.#previousSessions.map((session) => ({ ...session }));
    if (this.#balance === null || this.#startedAt === null) {
      return {
        status: "waiting",
        balance: null,
        startedAt: null,
        elapsedSeconds: 0,
        earned: 0,
        spent: 0,
        net: 0,
        goldPerHour: 0,
        goldPerMinute: 0,
        netPerHour: 0,
        recentGoldPerHour: 0,
        earningEvents: 0,
        spendingEvents: 0,
        averageGoldPerEvent: 0,
        monsterKills: 0,
        unconfirmedMonsterKills: 0,
        goldPerMonsterKill: null,
        killCountAvailable: this.#lastMonsterKillCount !== undefined,
        buckets: [],
        previousSessions,
      };
    }

    const elapsedMs = this.#activeElapsed(observedAt);
    const elapsedHours = elapsedMs / HOUR_MS;
    const recentStart = Math.max(this.#startedAt, observedAt - RECENT_WINDOW_MS);
    const recentElapsedHours = this.#activeWithin(recentStart, observedAt) / HOUR_MS;
    const recentEarned = this.#events.reduce(
      (total, event) => event.at >= recentStart && event.delta > 0 ? total + event.delta : total,
      0,
    );

    return {
      status: this.#activeSince === null ? "paused" : "tracking",
      balance: this.#balance,
      startedAt: new Date(this.#startedAt).toISOString(),
      elapsedSeconds: Math.floor(elapsedMs / 1_000),
      earned: this.#earned,
      spent: this.#spent,
      net: this.#earned - this.#spent,
      goldPerHour: rate(this.#earned, elapsedHours),
      goldPerMinute: rate(this.#earned, elapsedMs / 60_000),
      netPerHour: rate(this.#earned - this.#spent, elapsedHours),
      recentGoldPerHour: rate(recentEarned, recentElapsedHours),
      earningEvents: this.#earningEvents,
      spendingEvents: this.#spendingEvents,
      averageGoldPerEvent: this.#earningEvents === 0 ? 0 : this.#earned / this.#earningEvents,
      monsterKills: this.#monsterKills,
      unconfirmedMonsterKills: this.#monsterKills - this.#confirmedMonsterKills,
      goldPerMonsterKill: this.#confirmedMonsterKills === 0 ? null : this.#earned / this.#confirmedMonsterKills,
      killCountAvailable: this.#lastMonsterKillCount !== undefined,
      ...(this.#lastChangeAt === null ? {} : { lastChangeAt: new Date(this.#lastChangeAt).toISOString() }),
      buckets: this.#buckets(observedAt),
      previousSessions,
    };
  }

  #start(balance: number, observedAt: number, playerObjectId: number | undefined, active = true): void {
    this.#clearSession();
    this.#balance = balance;
    this.#startingBalance = balance;
    this.#playerObjectId = playerObjectId;
    this.#startedAt = observedAt;
    this.#activeSince = active ? observedAt : null;
  }

  #clearSession(): void {
    this.#balance = null;
    this.#startingBalance = null;
    this.#playerObjectId = undefined;
    this.#startedAt = null;
    this.#lastChangeAt = null;
    this.#events.length = 0;
    this.#earned = 0;
    this.#spent = 0;
    this.#earningEvents = 0;
    this.#spendingEvents = 0;
    this.#monsterKills = 0;
    this.#confirmedMonsterKills = 0;
    this.#lastMonsterKillCount = undefined;
    this.#activeMs = 0;
    this.#activeSince = null;
    this.#activeIntervals.length = 0;
  }

  #markActive(at: number): void {
    if (this.#activeSince === null) this.#activeSince = at;
  }

  #pause(at: number): void {
    if (this.#activeSince === null) return;
    const from = this.#activeSince;
    const to = Math.max(from, at);
    this.#activeMs += to - from;
    this.#activeIntervals.push({ from, to });
    this.#activeSince = null;
    // Only the recent-window rate reads intervals, so nothing older than that window is kept.
    dropBefore(this.#activeIntervals, at - RECENT_WINDOW_MS, (interval) => interval.to);
  }

  #activeElapsed(at: number): number {
    return this.#activeMs + (this.#activeSince === null ? 0 : Math.max(0, at - this.#activeSince));
  }

  #activeWithin(from: number, to: number): number {
    const overlap = (interval: ActiveInterval) => Math.max(0, Math.min(interval.to, to) - Math.max(interval.from, from));
    let total = this.#activeIntervals.reduce((sum, interval) => sum + overlap(interval), 0);
    if (this.#activeSince !== null) total += overlap({ from: this.#activeSince, to });
    return total;
  }

  #archiveCurrent(observedAt: number): void {
    if (this.#balance === null || this.#startingBalance === null || this.#startedAt === null) return;
    const elapsedMs = this.#activeElapsed(observedAt);
    if (this.#earned === 0 && this.#spent === 0) return;
    const elapsedHours = elapsedMs / HOUR_MS;
    this.#previousSessions.unshift({
      id: `${new Date(this.#startedAt).toISOString()}-${new Date(observedAt).toISOString()}`,
      startedAt: new Date(this.#startedAt).toISOString(),
      endedAt: new Date(observedAt).toISOString(),
      elapsedSeconds: Math.floor(elapsedMs / 1_000),
      startingBalance: this.#startingBalance,
      endingBalance: this.#balance,
      earned: this.#earned,
      spent: this.#spent,
      net: this.#earned - this.#spent,
      goldPerHour: rate(this.#earned, elapsedHours),
      netPerHour: rate(this.#earned - this.#spent, elapsedHours),
      earningEvents: this.#earningEvents,
      monsterKills: this.#monsterKills,
      goldPerMonsterKill: this.#confirmedMonsterKills === 0 ? null : this.#earned / this.#confirmedMonsterKills,
    });
    if (this.#previousSessions.length > MAX_PREVIOUS_SESSIONS) {
      this.#previousSessions.length = MAX_PREVIOUS_SESSIONS;
    }
  }

  #pruneEvents(observedAt: number): void {
    dropBefore(this.#events, observedAt - EVENT_RETENTION_MS, (event) => event.at);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
  }

  #buckets(observedAt: number): GoldBucketView[] {
    const windowStart = observedAt - BUCKET_COUNT * BUCKET_MS;
    const buckets = Array.from({ length: BUCKET_COUNT }, (_, index): GoldBucketView => ({
      startedAt: new Date(windowStart + index * BUCKET_MS).toISOString(),
      earned: 0,
      spent: 0,
    }));
    for (const event of this.#events) {
      const index = Math.floor((event.at - windowStart) / BUCKET_MS);
      if (index < 0 || index >= buckets.length) continue;
      if (event.delta > 0) buckets[index]!.earned += event.delta;
      else buckets[index]!.spent += -event.delta;
    }
    return buckets;
  }
}

function parsePersistedState(value: unknown): PersistedGoldState {
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.previousSessions)) {
    throw new Error("gold analytics state has an unsupported shape");
  }
  const previousSessions = value.previousSessions.map(parseSessionSummary).slice(0, MAX_PREVIOUS_SESSIONS);
  if (value.active === null) return { schema: 1, active: null, previousSessions };
  if (!isRecord(value.active) || !Array.isArray(value.active.events)) {
    throw new Error("gold analytics active session is invalid");
  }
  const active: PersistedActiveSession = {
    balance: safeInteger(value.active.balance, "balance"),
    startingBalance: safeInteger(value.active.startingBalance, "startingBalance"),
    startedAt: safeInteger(value.active.startedAt, "startedAt"),
    lastChangeAt: value.active.lastChangeAt === null ? null : safeInteger(value.active.lastChangeAt, "lastChangeAt"),
    earned: safeInteger(value.active.earned, "earned"),
    spent: safeInteger(value.active.spent, "spent"),
    earningEvents: safeInteger(value.active.earningEvents, "earningEvents"),
    spendingEvents: safeInteger(value.active.spendingEvents, "spendingEvents"),
    monsterKills: safeInteger(value.active.monsterKills, "monsterKills"),
    ...(value.active.confirmedMonsterKills === undefined
      ? {}
      : { confirmedMonsterKills: safeInteger(value.active.confirmedMonsterKills, "confirmedMonsterKills") }),
    events: value.active.events.slice(-MAX_EVENTS).map((event) => {
      if (!isRecord(event)) throw new Error("gold analytics event is invalid");
      return { at: safeInteger(event.at, "event.at"), delta: signedSafeInteger(event.delta, "event.delta") };
    }),
  };
  if (value.active.playerObjectId !== undefined) {
    active.playerObjectId = safeInteger(value.active.playerObjectId, "playerObjectId");
  }
  if (value.active.lastMonsterKillCount !== undefined) {
    active.lastMonsterKillCount = safeInteger(value.active.lastMonsterKillCount, "lastMonsterKillCount");
  }
  if (value.active.activeMs !== undefined) {
    active.activeMs = safeInteger(value.active.activeMs, "activeMs");
  }
  if (value.active.activeSince !== undefined) {
    active.activeSince = safeInteger(value.active.activeSince, "activeSince");
  }
  if (value.active.activeIntervals !== undefined) {
    if (!Array.isArray(value.active.activeIntervals)) throw new Error("gold analytics active intervals are invalid");
    active.activeIntervals = value.active.activeIntervals.map((interval) => {
      if (!isRecord(interval)) throw new Error("gold analytics active interval is invalid");
      return { from: safeInteger(interval.from, "interval.from"), to: safeInteger(interval.to, "interval.to") };
    });
  }
  return { schema: 1, active, previousSessions };
}

function parseSessionSummary(value: unknown): GoldSessionSummaryView {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.startedAt !== "string" || typeof value.endedAt !== "string") {
    throw new Error("gold analytics previous session is invalid");
  }
  if (!Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.endedAt))) {
    throw new Error("gold analytics previous session timestamp is invalid");
  }
  return {
    id: value.id,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    elapsedSeconds: safeInteger(value.elapsedSeconds, "elapsedSeconds"),
    startingBalance: safeInteger(value.startingBalance, "startingBalance"),
    endingBalance: safeInteger(value.endingBalance, "endingBalance"),
    earned: safeInteger(value.earned, "earned"),
    spent: safeInteger(value.spent, "spent"),
    net: signedSafeInteger(value.net, "net"),
    goldPerHour: finiteNumber(value.goldPerHour, "goldPerHour"),
    netPerHour: finiteNumber(value.netPerHour, "netPerHour"),
    earningEvents: safeInteger(value.earningEvents, "earningEvents"),
    monsterKills: safeInteger(value.monsterKills, "monsterKills"),
    goldPerMonsterKill: value.goldPerMonsterKill === null ? null : finiteNumber(value.goldPerMonsterKill, "goldPerMonsterKill"),
  };
}

function numericField(packet: CapturedFishNetPacket, name: string): number | undefined {
  const raw = packet.decodedFields?.find((field) => field.name === name)?.value;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function rate(value: number, duration: number): number {
  return duration <= 0 ? 0 : value / duration;
}

/** Drops the leading entries of a chronologically ordered list whose timestamp is before `cutoff`. */
function dropBefore<T>(list: T[], cutoff: number, at: (entry: T) => number): void {
  let remove = 0;
  while (remove < list.length && at(list[remove]!) < cutoff) remove++;
  if (remove > 0) list.splice(0, remove);
}

function safeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
  return value;
}

function signedSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field} is invalid`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
