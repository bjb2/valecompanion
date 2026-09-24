import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain, screen, type Rectangle } from "electron";
import type { PickupNotification, PickupOverlayState } from "../shared/pickup-overlay.ts";
import { createDiagnosticLogger, formatError } from "../shared/diagnostics.ts";

const OVERLAY_WIDTH = 430;
const OVERLAY_HEIGHT = 680;
const SAVE_DELAY_MS = 350;
const MAX_PENDING_PICKUPS = 5;

type OverlayPreferences = {
  enabled: boolean;
  bounds?: { x: number; y: number };
};

export class PickupOverlayController {
  private readonly preferencesPath: string;
  private readonly diagnostics;
  private readonly smokeTest: boolean;
  private readonly mainWindow: () => BrowserWindow | undefined;
  private state: PickupOverlayState;
  private savedBounds: { x: number; y: number } | undefined;
  private overlayWindow: BrowserWindow | undefined;
  private applicationUrl = "";
  private rendererReady = false;
  private pendingPickups: PickupNotification[] = [];
  private saveTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: { data: string; mainWindow(): BrowserWindow | undefined; smokeTest: boolean }) {
    this.preferencesPath = path.join(options.data, "pickup-overlay.json");
    this.diagnostics = createDiagnosticLogger("pickup-overlay", path.join(options.data, "logs", "pickup-overlay.log"));
    this.smokeTest = options.smokeTest;
    this.mainWindow = options.mainWindow;
    const preferences: OverlayPreferences = this.smokeTest ? { enabled: false } : this.loadPreferences();
    this.state = { enabled: preferences.enabled, repositioning: false };
    this.savedBounds = preferences.bounds;

    ipcMain.handle("valeCompanion:pickup-overlay", async (event, command: unknown, value: unknown, ...extra: unknown[]) => {
      if (!this.isTrustedSender(event.sender, event.senderFrame)) {
        throw new Error("Pickup overlay requests must come from a Vale Companion renderer.");
      }
      if (extra.length > 0 || typeof command !== "string") throw new Error("Invalid pickup overlay request.");
      switch (command) {
        case "state":
          if (value !== undefined) throw new Error("Invalid pickup overlay request.");
          if (event.sender === this.overlayWindow?.webContents) {
            this.rendererReady = true;
            this.flushPendingPickups();
          }
          break;
        case "enabled":
          if (typeof value !== "boolean") throw new Error("Overlay enabled must be a boolean.");
          await this.setEnabled(value);
          break;
        case "reposition":
          if (value !== undefined) throw new Error("Invalid pickup overlay request.");
          await this.reposition();
          break;
        case "finish":
          if (value !== undefined) throw new Error("Invalid pickup overlay request.");
          this.finishReposition();
          break;
        case "reset":
          if (value !== undefined) throw new Error("Invalid pickup overlay request.");
          await this.resetPosition();
          break;
        default:
          throw new Error("Unknown pickup overlay request.");
      }
      return this.snapshot();
    });

    screen.on("display-added", this.clampToDisplays);
    screen.on("display-removed", this.clampToDisplays);
    screen.on("display-metrics-changed", this.clampToDisplays);
  }

  start(applicationUrl: string): void {
    this.applicationUrl = applicationUrl;
    if (this.state.enabled) this.ensureOverlayWindow();
    this.publishState();
  }

  async reload(applicationUrl: string): Promise<void> {
    this.applicationUrl = applicationUrl;
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
    await this.loadOverlay();
  }

  forwardPickup(pickup: PickupNotification): void {
    if (!this.state.enabled || this.disposed) return;
    const window = this.ensureOverlayWindow();
    if (!window || !this.rendererReady) {
      this.pendingPickups.push(pickup);
      if (this.pendingPickups.length > MAX_PENDING_PICKUPS) this.pendingPickups.shift();
      return;
    }
    window.webContents.send("valeCompanion:pickup-overlay-pickup", pickup);
  }

  dispose(): void {
    this.disposed = true;
    screen.removeListener("display-added", this.clampToDisplays);
    screen.removeListener("display-removed", this.clampToDisplays);
    screen.removeListener("display-metrics-changed", this.clampToDisplays);
    if (!this.smokeTest) this.flushPreferences();
    const window = this.overlayWindow;
    this.overlayWindow = undefined;
    if (window && !window.isDestroyed()) window.close();
  }

  private readonly clampToDisplays = (): void => {
    const window = this.overlayWindow;
    if (!window || window.isDestroyed()) return;
    const current = window.getBounds();
    const next = this.clampBounds(current);
    if (next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height) window.setBounds(next);
  };

  private async setEnabled(enabled: boolean): Promise<void> {
    if (this.smokeTest && enabled) throw new Error("Pickup overlay is disabled during the packaged smoke test.");
    if (this.state.enabled === enabled) return;
    this.state = { enabled, repositioning: false };
    if (!enabled) {
      this.pendingPickups = [];
      this.applyInputMode();
      this.overlayWindow?.hide();
    } else {
      const window = this.ensureOverlayWindow();
      if (window && this.rendererReady) window.showInactive();
    }
    this.scheduleSave();
    this.publishState();
  }

  private async reposition(): Promise<void> {
    if (!this.state.enabled) return;
    this.state = { enabled: true, repositioning: true };
    const window = this.ensureOverlayWindow();
    if (window) window.showInactive();
    this.applyInputMode();
    this.publishState();
  }

  private finishReposition(): void {
    if (!this.state.repositioning) return;
    this.state = { enabled: this.state.enabled, repositioning: false };
    this.applyInputMode();
    this.scheduleSave();
    this.publishState();
  }

  private async resetPosition(): Promise<void> {
    if (this.smokeTest) return;
    this.savedBounds = undefined;
    const window = this.state.enabled ? this.ensureOverlayWindow() : this.overlayWindow;
    if (window) {
      const bounds = this.defaultBounds();
      window.setPosition(bounds.x, bounds.y);
    }
    this.scheduleSave();
  }

  private ensureOverlayWindow(): BrowserWindow | undefined {
    if (this.disposed || !this.applicationUrl) return undefined;
    const existing = this.overlayWindow;
    if (existing && !existing.isDestroyed()) return existing;
    const bounds = this.initialBounds();
    const window = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.overlayWindow = window;
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on("move", () => this.saveMovedBounds());
    window.on("closed", () => {
      if (this.overlayWindow === window) {
        this.overlayWindow = undefined;
        this.rendererReady = false;
      }
    });
    this.configureNavigation(window);
    this.applyInputMode();
    void this.loadOverlay();
    return window;
  }

  private configureNavigation(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.diagnostics.warn("Blocked pickup overlay window request", { url });
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (url === this.overlayUrl()) return;
      this.diagnostics.warn("Blocked pickup overlay navigation", { url });
      event.preventDefault();
    });
    window.webContents.on("did-finish-load", () => {
      this.publishState();
      if (this.state.enabled) window.showInactive();
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      this.diagnostics.error("Pickup overlay failed to load", { code, description, url });
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      this.rendererReady = false;
      this.diagnostics.error("Pickup overlay renderer exited", { details });
    });
  }

  private async loadOverlay(): Promise<void> {
    const window = this.overlayWindow;
    if (!window || window.isDestroyed()) return;
    this.rendererReady = false;
    try {
      await window.loadURL(this.overlayUrl());
    } catch (error) {
      this.diagnostics.error("Pickup overlay URL load rejected", { error: formatError(error) });
    }
  }

  private overlayUrl(): string {
    return new URL("pickup-overlay.html", this.applicationUrl).toString();
  }

  private applyInputMode(): void {
    const window = this.overlayWindow;
    if (!window || window.isDestroyed()) return;
    window.setFocusable(this.state.repositioning);
    window.setIgnoreMouseEvents(!this.state.repositioning, { forward: true });
  }

  private publishState(): void {
    const state = this.snapshot();
    const send = (window: BrowserWindow | undefined): void => {
      if (window && !window.isDestroyed()) window.webContents.send("valeCompanion:pickup-overlay-state", state);
    };
    send(this.mainWindow());
    send(this.overlayWindow);
  }

  private flushPendingPickups(): void {
    const window = this.overlayWindow;
    if (!window || window.isDestroyed() || !this.rendererReady || !this.state.enabled) return;
    for (const pickup of this.pendingPickups) window.webContents.send("valeCompanion:pickup-overlay-pickup", pickup);
    this.pendingPickups = [];
  }

  private isTrustedSender(sender: Electron.WebContents, senderFrame: Electron.WebFrameMain | null): boolean {
    const trusted = [this.mainWindow(), this.overlayWindow];
    return trusted.some((window) => window && !window.isDestroyed()
      && sender === window.webContents && senderFrame === window.webContents.mainFrame);
  }

  private snapshot(): PickupOverlayState {
    return { ...this.state };
  }

  private initialBounds(): Rectangle {
    const candidate = this.savedBounds ? { ...this.savedBounds, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT } : this.defaultBounds();
    return this.clampBounds(candidate);
  }

  private defaultBounds(): Rectangle {
    const area = screen.getPrimaryDisplay().workArea;
    return this.clampBounds({
      x: Math.max(area.x, area.x + area.width - OVERLAY_WIDTH - 24),
      y: Math.max(area.y, area.y + 24),
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
  }

  private clampBounds(bounds: Rectangle): Rectangle {
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const area = display.workArea;
    const width = Math.min(OVERLAY_WIDTH, area.width);
    const height = Math.min(OVERLAY_HEIGHT, area.height);
    return {
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
      width,
      height,
    };
  }

  private saveMovedBounds(): void {
    const window = this.overlayWindow;
    if (!window || window.isDestroyed()) return;
    const { x, y } = window.getBounds();
    this.savedBounds = { x, y };
    this.scheduleSave();
  }

  private loadPreferences(): OverlayPreferences {
    try {
      const saved = JSON.parse(readFileSync(this.preferencesPath, "utf8")) as Record<string, unknown>;
      const bounds = saved.bounds;
      return {
        enabled: saved.enabled === true,
        ...(bounds && typeof bounds === "object" && Number.isSafeInteger((bounds as Record<string, unknown>).x)
          && Number.isSafeInteger((bounds as Record<string, unknown>).y)
          ? { bounds: { x: Number((bounds as Record<string, unknown>).x), y: Number((bounds as Record<string, unknown>).y) } }
          : {}),
      };
    } catch {
      return { enabled: false };
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flushPreferences();
    }, SAVE_DELAY_MS);
  }

  private flushPreferences(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    try {
      mkdirSync(path.dirname(this.preferencesPath), { recursive: true });
      const preferences: OverlayPreferences = { enabled: this.state.enabled, ...(this.savedBounds ? { bounds: this.savedBounds } : {}) };
      const temporary = `${this.preferencesPath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
      renameSync(temporary, this.preferencesPath);
    } catch (error) {
      this.diagnostics.warn("Could not save pickup overlay preferences", { error: formatError(error) });
    }
  }
}
