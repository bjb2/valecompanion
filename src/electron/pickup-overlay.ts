import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from "electron";
import {
  OVERLAY_COMPONENTS,
  type OverlayComponent,
  type PickupNotification,
  type PickupOverlayState,
  type TrackedOverlayItem,
} from "../shared/pickup-overlay.ts";
import { createDiagnosticLogger, formatError } from "../shared/diagnostics.ts";

const SAVE_DELAY_MS = 350;
const MAX_PENDING_PICKUPS = 5;
const OVERLAY_SIZE: Record<OverlayComponent, { width: number; height: number }> = {
  pickups: { width: 420, height: 500 },
  weight: { width: 340, height: 150 },
  items: { width: 360, height: 500 },
  gold: { width: 340, height: 150 },
};
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

type SavedBounds = Partial<Record<OverlayComponent, { x: number; y: number }>>;

type OverlayPreferences = {
  enabled: boolean;
  components: Record<OverlayComponent, boolean>;
  trackedItems: TrackedOverlayItem[];
  bounds?: SavedBounds;
};

const defaultComponents = (): Record<OverlayComponent, boolean> => ({
  pickups: true,
  weight: false,
  items: false,
  gold: false,
});

export class PickupOverlayController {
  private readonly preferencesPath: string;
  private readonly diagnostics;
  private readonly smokeTest: boolean;
  private readonly mainWindow: () => BrowserWindow | undefined;
  private state: PickupOverlayState;
  private savedBounds: SavedBounds;
  private readonly overlayWindows: Partial<Record<OverlayComponent, BrowserWindow>> = {};
  private readonly rendererReady = new Set<OverlayComponent>();
  private readonly rendererFailed = new Set<OverlayComponent>();
  private applicationUrl = "";
  private pendingPickups: PickupNotification[] = [];
  private saveTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: { data: string; mainWindow(): BrowserWindow | undefined; smokeTest: boolean }) {
    this.preferencesPath = path.join(options.data, "pickup-overlay.json");
    this.diagnostics = createDiagnosticLogger("pickup-overlay", path.join(options.data, "logs", "pickup-overlay.log"));
    this.smokeTest = options.smokeTest;
    this.mainWindow = options.mainWindow;
    const preferences = this.smokeTest
      ? { enabled: false, components: defaultComponents(), trackedItems: [], bounds: {} }
      : this.loadPreferences();
    this.state = {
      enabled: preferences.enabled,
      repositioning: false,
      components: preferences.components,
      trackedItems: preferences.trackedItems,
      hotkeyAvailable: false,
    };
    this.savedBounds = preferences.bounds ?? {};

    ipcMain.handle("valeCompanion:pickup-overlay", async (event, command: unknown, value: unknown, ...extra: unknown[]) => {
      if (!this.isTrustedSender(event.sender, event.senderFrame)) {
        throw new Error("Pickup overlay requests must come from a Vale Companion renderer.");
      }
      if (typeof command !== "string") throw new Error("Invalid pickup overlay request.");
      switch (command) {
        case "state": {
          if (value !== undefined || extra.length !== 0) throw new Error("Invalid pickup overlay request.");
          const component = this.componentForSender(event.sender);
          if (component) {
            this.rendererReady.add(component);
            if (component === "pickups") this.flushPendingPickups();
          }
          break;
        }
        case "enabled":
          if (typeof value !== "boolean" || extra.length !== 0) throw new Error("Overlay enabled must be a boolean.");
          await this.setEnabled(value);
          break;
        case "component":
          if (!isOverlayComponent(value) || typeof extra[0] !== "boolean" || extra.length !== 1) {
            throw new Error("Overlay component request is invalid.");
          }
          await this.setComponentEnabled(value, extra[0]);
          break;
        case "tracked":
          if (extra.length !== 0) throw new Error("Invalid pickup overlay request.");
          await this.setTrackedItems(value);
          break;
        case "reposition":
          if (value !== undefined || extra.length !== 0) throw new Error("Invalid pickup overlay request.");
          await this.reposition();
          break;
        case "finish":
          if (value !== undefined || extra.length !== 0) throw new Error("Invalid pickup overlay request.");
          this.finishReposition();
          break;
        case "reset":
          if (value !== undefined || extra.length !== 0) throw new Error("Invalid pickup overlay request.");
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
    this.registerShortcut();
    this.updateWindows();
    this.publishState();
  }

  async reload(applicationUrl: string): Promise<void> {
    this.applicationUrl = applicationUrl;
    await Promise.all(OVERLAY_COMPONENTS.map(async (component) => {
      const window = this.overlayWindows[component];
      if (window && !window.isDestroyed()) await this.loadOverlay(component, window);
    }));
  }

  forwardPickup(pickup: PickupNotification): void {
    if (!this.state.enabled || !this.state.components.pickups || this.disposed) return;
    const window = this.ensureOverlayWindow("pickups");
    if (!window || !this.rendererReady.has("pickups")) {
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
    ipcMain.removeHandler("valeCompanion:pickup-overlay");
    try {
      globalShortcut.unregister("F5");
    } catch (error) {
      this.diagnostics.warn("Could not unregister pickup overlay shortcut", { error: formatError(error) });
    }
    if (!this.smokeTest) this.flushPreferences();
    for (const component of OVERLAY_COMPONENTS) {
      const window = this.overlayWindows[component];
      delete this.overlayWindows[component];
      if (window && !window.isDestroyed()) window.close();
    }
    this.rendererReady.clear();
    this.rendererFailed.clear();
    this.pendingPickups = [];
  }

  private readonly clampToDisplays = (): void => {
    for (const component of OVERLAY_COMPONENTS) {
      const window = this.overlayWindows[component];
      if (!window || window.isDestroyed()) continue;
      const current = window.getBounds();
      const next = this.clampBounds(component, current);
      if (next.x !== current.x || next.y !== current.y || next.width !== current.width || next.height !== current.height) {
        window.setBounds(next);
      }
    }
  };

  private async setEnabled(enabled: boolean): Promise<void> {
    if (this.smokeTest && enabled) throw new Error("Pickup overlay is disabled during the packaged smoke test.");
    if (this.state.enabled === enabled && (!this.state.repositioning || enabled)) {
      this.updateWindows();
      return;
    }
    this.state = { ...this.state, enabled, repositioning: false };
    if (!enabled) this.pendingPickups = [];
    this.updateWindows();
    this.scheduleSave();
    this.publishState();
  }

  private async setComponentEnabled(component: OverlayComponent, enabled: boolean): Promise<void> {
    if (this.state.components[component] === enabled) {
      this.updateWindows();
      return;
    }
    this.state = { ...this.state, components: { ...this.state.components, [component]: enabled } };
    if (component === "pickups" && !enabled) this.pendingPickups = [];
    this.updateWindows();
    this.scheduleSave();
    this.publishState();
  }

  private async setTrackedItems(value: unknown): Promise<void> {
    const trackedItems = this.validateTrackedItems(value);
    this.state = { ...this.state, trackedItems };
    this.scheduleSave();
    this.publishState();
  }

  private async reposition(): Promise<void> {
    if (this.disposed) return;
    this.state = { ...this.state, repositioning: true };
    this.updateWindows();
    this.publishState();
  }

  private finishReposition(): void {
    if (!this.state.repositioning) return;
    this.state = { ...this.state, repositioning: false };
    this.updateWindows();
    this.scheduleSave();
    this.publishState();
  }

  private async resetPosition(): Promise<void> {
    if (this.smokeTest) return;
    this.savedBounds = {};
    for (const component of OVERLAY_COMPONENTS) {
      const window = this.overlayWindows[component];
      if (!window || window.isDestroyed()) continue;
      const bounds = this.defaultBounds(component);
      window.setPosition(bounds.x, bounds.y);
    }
    this.scheduleSave();
  }

  private toggleReposition(): void {
    if (this.state.repositioning) {
      this.finishReposition();
      return;
    }
    void this.reposition().catch((error) => {
      this.diagnostics.error("Could not enter pickup overlay reposition mode", { error: formatError(error) });
    });
  }

  private registerShortcut(): void {
    try {
      const hotkeyAvailable = globalShortcut.register("F5", () => this.toggleReposition());
      this.state = { ...this.state, hotkeyAvailable };
    } catch (error) {
      this.state = { ...this.state, hotkeyAvailable: false };
      this.diagnostics.warn("Could not register pickup overlay shortcut", { error: formatError(error) });
    }
  }

  private updateWindows(): void {
    for (const component of OVERLAY_COMPONENTS) {
      const visible = this.isComponentVisible(component);
      const window = visible ? this.ensureOverlayWindow(component) : this.overlayWindows[component];
      if (!window || window.isDestroyed()) continue;
      this.applyInputMode(window);
      if (visible && this.rendererReady.has(component)) window.showInactive();
      if (!visible) window.hide();
    }
  }

  private isComponentVisible(component: OverlayComponent): boolean {
    return this.state.repositioning || (this.state.enabled && this.state.components[component]);
  }

  private ensureOverlayWindow(component: OverlayComponent): BrowserWindow | undefined {
    if (this.disposed || !this.applicationUrl) return undefined;
    const existing = this.overlayWindows[component];
    if (existing && !existing.isDestroyed()) {
      if (!this.rendererFailed.has(component)) return existing;
      delete this.overlayWindows[component];
      existing.destroy();
    }
    this.rendererFailed.delete(component);
    const bounds = this.initialBounds(component);
    const window = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      focusable: this.state.repositioning,
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
    this.overlayWindows[component] = window;
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on("move", () => this.saveMovedBounds(component, window));
    window.on("closed", () => {
      if (this.overlayWindows[component] === window) {
        delete this.overlayWindows[component];
        this.rendererReady.delete(component);
      }
    });
    this.configureNavigation(component, window);
    this.applyInputMode(window);
    void this.loadOverlay(component, window);
    return window;
  }

  private configureNavigation(component: OverlayComponent, window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.diagnostics.warn("Blocked pickup overlay window request", { url });
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (url === this.overlayUrl(component)) return;
      this.diagnostics.warn("Blocked pickup overlay navigation", { url });
      event.preventDefault();
    });
    window.webContents.on("did-finish-load", () => {
      if (this.overlayWindows[component] !== window) return;
      this.rendererFailed.delete(component);
      this.publishState();
      if (this.isComponentVisible(component)) window.showInactive();
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      if (this.overlayWindows[component] === window) {
        this.rendererReady.delete(component);
        this.rendererFailed.add(component);
      }
      this.diagnostics.error("Pickup overlay failed to load", { component, code, description, url });
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      if (this.overlayWindows[component] === window) {
        this.rendererReady.delete(component);
        this.rendererFailed.add(component);
      }
      this.diagnostics.error("Pickup overlay renderer exited", { component, details });
    });
  }

  private async loadOverlay(component: OverlayComponent, window: BrowserWindow): Promise<void> {
    if (window.isDestroyed()) return;
    this.rendererReady.delete(component);
    try {
      await window.loadURL(this.overlayUrl(component));
    } catch (error) {
      if (this.overlayWindows[component] === window) this.rendererFailed.add(component);
      this.diagnostics.error("Pickup overlay URL load rejected", { component, error: formatError(error) });
    }
  }

  private overlayUrl(component: OverlayComponent): string {
    const url = new URL("pickup-overlay.html", this.applicationUrl);
    url.searchParams.set("component", component);
    return url.toString();
  }

  private applyInputMode(window: BrowserWindow): void {
    window.setFocusable(this.state.repositioning);
    window.setIgnoreMouseEvents(!this.state.repositioning, { forward: true });
  }

  private publishState(): void {
    const state = this.snapshot();
    const send = (window: BrowserWindow | undefined): void => {
      if (window && !window.isDestroyed()) window.webContents.send("valeCompanion:pickup-overlay-state", state);
    };
    send(this.mainWindow());
    for (const component of OVERLAY_COMPONENTS) send(this.overlayWindows[component]);
  }

  private flushPendingPickups(): void {
    const window = this.overlayWindows.pickups;
    if (!window || window.isDestroyed() || !this.rendererReady.has("pickups")
      || !this.state.enabled || !this.state.components.pickups) return;
    for (const pickup of this.pendingPickups) window.webContents.send("valeCompanion:pickup-overlay-pickup", pickup);
    this.pendingPickups = [];
  }

  private componentForSender(sender: Electron.WebContents): OverlayComponent | undefined {
    return OVERLAY_COMPONENTS.find((component) => {
      const window = this.overlayWindows[component];
      return window && !window.isDestroyed() && sender === window.webContents;
    });
  }

  private isTrustedSender(sender: Electron.WebContents, senderFrame: Electron.WebFrameMain | null): boolean {
    const trusted = [this.mainWindow(), ...OVERLAY_COMPONENTS.map((component) => this.overlayWindows[component])];
    return trusted.some((window) => window && !window.isDestroyed()
      && sender === window.webContents && senderFrame === window.webContents.mainFrame);
  }

  private snapshot(): PickupOverlayState {
    return {
      ...this.state,
      components: { ...this.state.components },
      trackedItems: this.state.trackedItems.map((item) => ({ ...item })),
    };
  }

  private initialBounds(component: OverlayComponent): Rectangle {
    const saved = this.savedBounds[component];
    const size = OVERLAY_SIZE[component];
    const candidate = saved ? { ...saved, ...size } : this.defaultBounds(component);
    return this.clampBounds(component, candidate);
  }

  private defaultBounds(component: OverlayComponent): Rectangle {
    const area = screen.getPrimaryDisplay().workArea;
    const { width, height } = OVERLAY_SIZE[component];
    const x = component === "items"
      ? area.x + 24
      : area.x + area.width - width - 24;
    const y = component === "pickups" || component === "items"
      ? area.y + 24
      : component === "weight"
        ? area.y + OVERLAY_SIZE.pickups.height + 48
        : area.y + OVERLAY_SIZE.pickups.height + OVERLAY_SIZE.weight.height + 72;
    return this.clampBounds(component, { x, y, width, height });
  }

  private clampBounds(component: OverlayComponent, bounds: Rectangle): Rectangle {
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const area = display.workArea;
    const size = OVERLAY_SIZE[component];
    const width = Math.min(size.width, area.width);
    const height = Math.min(size.height, area.height);
    return {
      x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
      width,
      height,
    };
  }

  private saveMovedBounds(component: OverlayComponent, window: BrowserWindow): void {
    if (window.isDestroyed() || this.overlayWindows[component] !== window) return;
    const { x, y } = window.getBounds();
    this.savedBounds = { ...this.savedBounds, [component]: { x, y } };
    this.scheduleSave();
  }

  private loadPreferences(): OverlayPreferences {
    try {
      const parsed = JSON.parse(readFileSync(this.preferencesPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { enabled: true, components: defaultComponents(), trackedItems: [] };
      }
      const saved = parsed as {
        enabled?: unknown;
        components?: unknown;
        trackedItems?: unknown;
        bounds?: unknown;
      };
      const components = defaultComponents();
      if (saved.components && typeof saved.components === "object" && !Array.isArray(saved.components)) {
        const savedComponents = saved.components as Partial<Record<OverlayComponent, unknown>>;
        for (const component of OVERLAY_COMPONENTS) {
          if (typeof savedComponents[component] === "boolean") components[component] = savedComponents[component];
        }
      }
      const bounds: SavedBounds = {};
      if (isBounds(saved.bounds)) {
        bounds.pickups = saved.bounds;
      } else if (saved.bounds && typeof saved.bounds === "object" && !Array.isArray(saved.bounds)) {
        const savedBounds = saved.bounds as Partial<Record<OverlayComponent, unknown>>;
        for (const component of OVERLAY_COMPONENTS) {
          if (isBounds(savedBounds[component])) bounds[component] = savedBounds[component];
        }
      }
      return {
        enabled: saved.enabled !== false,
        components,
        trackedItems: this.loadTrackedItems(saved.trackedItems),
        ...(Object.keys(bounds).length > 0 ? { bounds } : {}),
      };
    } catch {
      return { enabled: true, components: defaultComponents(), trackedItems: [] };
    }
  }

  private loadTrackedItems(value: unknown): TrackedOverlayItem[] {
    if (!Array.isArray(value)) return [];
    const items: TrackedOverlayItem[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
      if (items.length === 3) break;
      const item = this.parseTrackedItem(candidate);
      if (!item || seen.has(`${item.kind}:${item.itemId}`)) continue;
      seen.add(`${item.kind}:${item.itemId}`);
      items.push(item);
    }
    return items;
  }

  private validateTrackedItems(value: unknown): TrackedOverlayItem[] {
    if (!Array.isArray(value) || value.length > 3) throw new Error("Tracked overlay items must contain at most three items.");
    const items: TrackedOverlayItem[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
      const item = this.parseTrackedItem(candidate);
      if (!item) throw new Error("Tracked overlay items are invalid.");
      const key = `${item.kind}:${item.itemId}`;
      if (seen.has(key)) throw new Error("Tracked overlay items must be unique.");
      seen.add(key);
      items.push(item);
    }
    return items;
  }

  private parseTrackedItem(value: unknown): TrackedOverlayItem | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const candidate = value as { itemId?: unknown; kind?: unknown; name?: unknown; icon?: unknown };
    const { itemId, kind, name, icon } = candidate;
    if (!isSafeText(itemId, 256) || !isSafeText(kind, 32)
      || !Object.hasOwn(TRACKED_ITEM_KINDS, kind) || !isSafeText(name, 512)
      || (icon !== null && !isSafeText(icon, 4_096))) return undefined;
    return { itemId, kind: kind as TrackedOverlayItem["kind"], name, icon: icon as string | null };
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
      const preferences: OverlayPreferences = {
        enabled: this.state.enabled,
        components: this.state.components,
        trackedItems: this.state.trackedItems,
        ...(Object.keys(this.savedBounds).length > 0 ? { bounds: this.savedBounds } : {}),
      };
      const temporary = `${this.preferencesPath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
      renameSync(temporary, this.preferencesPath);
    } catch (error) {
      this.diagnostics.warn("Could not save pickup overlay preferences", { error: formatError(error) });
    }
  }
}

function isOverlayComponent(value: unknown): value is OverlayComponent {
  return typeof value === "string" && OVERLAY_COMPONENTS.includes(value as OverlayComponent);
}

function isBounds(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bounds = value as { x?: unknown; y?: unknown };
  return Number.isSafeInteger(bounds.x) && Number.isSafeInteger(bounds.y);
}

function isSafeText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}
