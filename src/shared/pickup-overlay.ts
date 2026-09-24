import type { LootLine } from "./contracts.ts";

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

export interface PickupOverlayState {
  enabled: boolean;
  repositioning: boolean;
}

export interface PickupOverlayAPI {
  getState(): Promise<PickupOverlayState>;
  setEnabled(enabled: boolean): Promise<PickupOverlayState>;
  reposition(): Promise<PickupOverlayState>;
  finishReposition(): Promise<PickupOverlayState>;
  resetPosition(): Promise<PickupOverlayState>;
  onState(listener: (state: PickupOverlayState) => void): () => void;
  onPickup(listener: (pickup: PickupNotification) => void): () => void;
}
