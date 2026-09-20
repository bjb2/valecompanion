export type CollectorPhase = "disabled" | "capture-unavailable" | "waiting-for-game" | "capturing" | "error";
export type LootKind = "equipment" | "grimoire" | "artifact" | "gem" | "card" | "material" | "consumable" | "cosmetic";
export type LootHighlight = "dot" | "mark" | "glow";
export type LootBackground = "border" | "fill" | "holo";

export interface CaptureDevice {
  name: string;
  description: string;
  addresses: string[];
  loopback: boolean;
  automaticCandidate?: boolean;
}

export interface LootLine {
  stat: string;
  rollPct: number;
  printed: number | null;
  isChaos: boolean;
  over: boolean;
}

export interface LootMatchView {
  rule: string;
  tag: string;
  color: string;
  highlight: LootHighlight;
  background: LootBackground;
  border: boolean;
  sound: string | null;
}

export type MarketValueTier = "comparable" | "same-lines" | "other-lines" | "unit";

export interface MarketValueView {
  low: number;
  median: number;
  tier: MarketValueTier;
  listings: number;
}

export interface LootItemView {
  uid: string;
  itemId: string;
  name: string;
  type: string;
  kind: LootKind;
  icon: string | null;
  refine: number;
  count: number;
  favorite: boolean;
  hasChaos: boolean;
  topRolls: number | null;
  highRolls: number;
  avgRollPct: number | null;
  lines: LootLine[];
  match: LootMatchView | null;
  value?: MarketValueView;
}

export interface FilterErrorView {
  line: number;
  text: string;
  message: string;
}

export interface ProfileView {
  name: string;
  active: boolean;
}

export interface AlertHistoryView {
  sequence: number;
  at: string;
  uid: string;
  name: string;
  type: string;
  rule: string;
  tag: string;
  sound: string | null;
  soundWinner: boolean;
  soundPlayed: boolean;
  note: string;
}

export type LinuxCaptureMode = "auto" | "libpcap" | "dumpcap";
export interface MarketPricesView {
  generatedAt: string | null;
  listings: number;
  warning?: string;
  cacheWarning?: string;
}

export interface MarketContributorView {
  prepared: number;
  uploaded: number;
  queuedBatches: number;
  marketEventsDecoded: number;
  listingsDecoded: number;
  observationsNormalized: number;
  latestObservationAt?: string;
  latestUploadAt?: string;
  warning?: string;
}

export interface GoldBucketView {
  startedAt: string;
  earned: number;
  spent: number;
}

export interface GoldSessionSummaryView {
  id: string;
  startedAt: string;
  endedAt: string;
  elapsedSeconds: number;
  startingBalance: number;
  endingBalance: number;
  earned: number;
  spent: number;
  net: number;
  goldPerHour: number;
  netPerHour: number;
  earningEvents: number;
  monsterKills: number;
  goldPerMonsterKill: number | null;
}

export interface GoldAnalyticsView {
  status: "waiting" | "tracking" | "paused";
  balance: number | null;
  startedAt: string | null;
  lastChangeAt?: string;
  elapsedSeconds: number;
  earned: number;
  spent: number;
  net: number;
  goldPerHour: number;
  goldPerMinute: number;
  netPerHour: number;
  recentGoldPerHour: number;
  earningEvents: number;
  spendingEvents: number;
  averageGoldPerEvent: number;
  monsterKills: number;
  unconfirmedMonsterKills: number;
  goldPerMonsterKill: number | null;
  killCountAvailable: boolean;
  buckets: GoldBucketView[];
  previousSessions: GoldSessionSummaryView[];
}


export interface DesktopState {
  version: string;
  enabled: boolean;
  soundsEnabled: boolean;
  contributionEnabled: boolean;
  deviceName: string | null;
  linuxCaptureMode: LinuxCaptureMode;
  captureAdapter?: {
    name: string;
    description: string;
    selection: "automatic" | "manual";
    automaticCandidate: boolean;
  };
  phase: CollectorPhase;
  detail: string;
  capture: {
    backend: string;
    availability: "ready" | "missing" | "error";
    detail: string;
    version?: string;
  };
  gameDetected: boolean;
  packetsObserved: number;
  lastAttributedPacketAt?: string;
  automaticCaptureRestarts: number;
  snapshotsDecoded: number;
  partialSnapshots: number;
  duplicateSnapshots: number;
  market: MarketContributorView;
  marketPrices: MarketPricesView;
  gold: GoldAnalyticsView;
  bag: LootItemView[];
  bagGeneratedAt: string | null;
  storage: LootItemView[];
  storageGeneratedAt: string | null;
  bagCoverage: string;
  filter: {
    text: string;
    path: string;
    threshold: number;
    ruleCount: number;
    errors: FilterErrorView[];
  };
  profiles: ProfileView[];
  soundsDirectory: string;
  logsDirectory: string;
  history: AlertHistoryView[];
  sounds: string[];
  warning?: string;
}

export interface DesktopSettingsUpdate {
  enabled?: boolean;
  soundsEnabled?: boolean;
  contributionEnabled?: boolean;
  deviceName?: string | null;
  linuxCaptureMode?: LinuxCaptureMode;
}

export type ProfileCommand =
  | { action: "create"; name: string; text: string }
  | { action: "duplicate"; source: string; name: string }
  | { action: "rename"; source: string; name: string }
  | { action: "activate"; name: string };
