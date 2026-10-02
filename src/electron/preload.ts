import { contextBridge, ipcRenderer } from "electron";
import type {
  OverlayComponent,
  PickupNotification,
  PickupOverlayAPI,
  PickupOverlayState,
  TrackedOverlayItem,
} from "../shared/pickup-overlay.ts";
import type { UpdateAPI, UpdateState } from "../shared/updates.ts";
const TRACKED_ITEM_KINDS: Record<TrackedOverlayItem["kind"], true> = {
  equipment: true,
  grimoire: true,
  artifact: true,
  gem: true,
  card: true,
  material: true,
  consumable: true,
  cosmetic: true,
};


contextBridge.exposeInMainWorld("valeCompanion", {
  updates: {
    getState: () => ipcRenderer.invoke("valeCompanion:updates", "state"),
    command: (command) => ipcRenderer.invoke("valeCompanion:updates", command),
    setAutomaticChecks: (enabled) => ipcRenderer.invoke("valeCompanion:updates", "automatic", enabled),
    onState(listener) {
      const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
      ipcRenderer.on("valeCompanion:update-state", handler);
      return () => ipcRenderer.removeListener("valeCompanion:update-state", handler);
    },
  } satisfies UpdateAPI,
  pickupOverlay: {
    getState: () => ipcRenderer.invoke("valeCompanion:pickup-overlay", "state"),
    setEnabled: (enabled) => ipcRenderer.invoke("valeCompanion:pickup-overlay", "enabled", enabled),
    setComponentEnabled: (component: OverlayComponent, enabled: boolean) =>
      ipcRenderer.invoke("valeCompanion:pickup-overlay", "component", component, enabled),
    setTrackedItems: (items: TrackedOverlayItem[]) => ipcRenderer.invoke("valeCompanion:pickup-overlay", "tracked", items),
    reposition: () => ipcRenderer.invoke("valeCompanion:pickup-overlay", "reposition"),
    finishReposition: () => ipcRenderer.invoke("valeCompanion:pickup-overlay", "finish"),
    resetPosition: () => ipcRenderer.invoke("valeCompanion:pickup-overlay", "reset"),
    onState(listener) {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
        if (isPickupOverlayState(state)) listener(state);
      };
      ipcRenderer.on("valeCompanion:pickup-overlay-state", handler);
      return () => ipcRenderer.removeListener("valeCompanion:pickup-overlay-state", handler);
    },
    onPickup(listener) {
      const handler = (_event: Electron.IpcRendererEvent, pickup: unknown) => {
        if (isPickupNotification(pickup)) listener(pickup);
      };
      ipcRenderer.on("valeCompanion:pickup-overlay-pickup", handler);
      return () => ipcRenderer.removeListener("valeCompanion:pickup-overlay-pickup", handler);
    },
  } satisfies PickupOverlayAPI,
  onAlert(listener: (name: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, name: unknown) => {
      if (typeof name === "string") listener(name);
    };
    ipcRenderer.on("valeCompanion:play-sound", handler);
    return () => { ipcRenderer.removeListener("valeCompanion:play-sound", handler); };
  },
});

function isPickupOverlayState(value: unknown): value is PickupOverlayState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as {
    enabled?: unknown;
    repositioning?: unknown;
    hotkeyAvailable?: unknown;
    components?: unknown;
    trackedItems?: unknown;
  };
  if (typeof state.enabled !== "boolean" || typeof state.repositioning !== "boolean"
    || typeof state.hotkeyAvailable !== "boolean" || !state.components || typeof state.components !== "object"
    || Array.isArray(state.components) || !Array.isArray(state.trackedItems)) return false;
  const components = state.components as Record<OverlayComponent, unknown>;
  if (typeof components.pickups !== "boolean" || typeof components.weight !== "boolean"
    || typeof components.items !== "boolean" || typeof components.gold !== "boolean") return false;
  if (state.trackedItems.length > 3) return false;
  const trackedKeys = new Set<string>();
  return state.trackedItems.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const tracked = item as { itemId?: unknown; kind?: unknown; name?: unknown; icon?: unknown };
    if (typeof tracked.itemId !== "string" || typeof tracked.kind !== "string"
      || !Object.hasOwn(TRACKED_ITEM_KINDS, tracked.kind) || typeof tracked.name !== "string"
      || (tracked.icon !== null && typeof tracked.icon !== "string")) return false;
    const key = `${tracked.kind}:${tracked.itemId}`;
    if (trackedKeys.has(key)) return false;
    trackedKeys.add(key);
    return true;
  });
}

function isPickupNotification(value: unknown): value is PickupNotification {
  if (!value || typeof value !== "object") return false;
  const pickup = value as PickupNotification;
  return Number.isSafeInteger(pickup.sequence) && typeof pickup.name === "string"
    && (pickup.icon === null || typeof pickup.icon === "string")
    && Number.isSafeInteger(pickup.quantity) && typeof pickup.color === "string"
    && Number.isSafeInteger(pickup.refine) && Array.isArray(pickup.lines)
    && (pickup.tag === null || typeof pickup.tag === "string");
}
