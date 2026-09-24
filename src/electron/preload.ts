import { contextBridge, ipcRenderer } from "electron";
import type { PickupNotification, PickupOverlayAPI, PickupOverlayState } from "../shared/pickup-overlay.ts";
import type { UpdateAPI, UpdateState } from "../shared/updates.ts";

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
  return Boolean(value) && typeof value === "object"
    && typeof (value as PickupOverlayState).enabled === "boolean"
    && typeof (value as PickupOverlayState).repositioning === "boolean";
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
