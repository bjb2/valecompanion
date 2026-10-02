import type { DesktopState, LootItemView, LootLine } from "./contracts.ts";

export interface PickupNotification {
  sequence: number;
  name: string;
  icon: string | null;
  quantity: number;
  color: string;
  tag: string | null;
  refine: number;
  lines: LootLine[];
}

export const OVERLAY_COMPONENTS = ["pickups", "weight", "items", "gold"] as const;
export type OverlayComponent = typeof OVERLAY_COMPONENTS[number];
export type TrackedOverlayItem = Pick<LootItemView, "itemId" | "kind" | "name" | "icon">;

export interface OverlayData {
  bag: LootItemView[];
  bagGeneratedAt: string | null;
  bagWeight: { current: number | null; total: number | null; reason?: string };
  gold: DesktopState["gold"];
  gameDetected: boolean;
  phase: DesktopState["phase"];
}

export interface PickupOverlayState {
  enabled: boolean;
  repositioning: boolean;
  components: Record<OverlayComponent, boolean>;
  trackedItems: TrackedOverlayItem[];
  hotkeyAvailable: boolean;
}

export interface PickupOverlayAPI {
  getState(): Promise<PickupOverlayState>;
  setEnabled(enabled: boolean): Promise<PickupOverlayState>;
  setComponentEnabled(component: OverlayComponent, enabled: boolean): Promise<PickupOverlayState>;
  setTrackedItems(items: TrackedOverlayItem[]): Promise<PickupOverlayState>;
  reposition(): Promise<PickupOverlayState>;
  finishReposition(): Promise<PickupOverlayState>;
  resetPosition(): Promise<PickupOverlayState>;
  onState(listener: (state: PickupOverlayState) => void): () => void;
  onPickup(listener: (pickup: PickupNotification) => void): () => void;
}
