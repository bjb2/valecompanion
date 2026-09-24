interface Window {
  readonly valeCompanion?: {
    updates: import("../shared/updates.ts").UpdateAPI;
    pickupOverlay: import("../shared/pickup-overlay.ts").PickupOverlayAPI;
    onAlert(listener: (name: string) => void): () => void;
  };
}
