import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";

class FakeWebContents extends EventEmitter {
  readonly mainFrame = {};
  readonly sent: Array<[string, ...unknown[]]> = [];
  loads = 0;
  url = "";

  setWindowOpenHandler(): void {}

  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, ...args]);
  }

  async loadURL(url: string): Promise<void> {
    this.loads += 1;
    this.url = url;
    this.emit("did-finish-load");
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  private destroyed = false;
  private visible = false;
  private bounds: { x: number; y: number; width: number; height: number };
  focusable = false;
  ignoresMouse = true;

  constructor(options: { x: number; y: number; width: number; height: number }) {
    super();
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    FakeBrowserWindow.instances.push(this);
  }

  loadURL(url: string): Promise<void> { return this.webContents.loadURL(url); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
  close(): void { this.destroy(); }
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  setFocusable(focusable: boolean): void { this.focusable = focusable; }
  setIgnoreMouseEvents(ignore: boolean): void { this.ignoresMouse = ignore; }
  showInactive(): void { this.visible = true; }
  hide(): void { this.visible = false; }
  getBounds() { return this.bounds; }
  setBounds(bounds: typeof this.bounds): void { this.bounds = bounds; }
  setPosition(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y };
    this.emit("move");
  }
  isVisible(): boolean { return this.visible; }
}

type IpcEvent = { sender: FakeWebContents; senderFrame: object };
type IpcHandler = (event: IpcEvent, command: unknown, value: unknown, ...extra: unknown[]) => unknown;

const handlers = new Map<string, IpcHandler>();
const ipcMain = {
  handle(channel: string, handler: IpcHandler): void { handlers.set(channel, handler); },
  removeHandler(channel: string): void { handlers.delete(channel); },
};
const shortcuts = new Map<string, () => void>();
const globalShortcut = {
  available: true,
  register(accelerator: string, callback: () => void): boolean {
    if (!this.available) return false;
    shortcuts.set(accelerator, callback);
    return true;
  },
  unregister(accelerator: string): void { shortcuts.delete(accelerator); },
};
const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }),
});
mock.module("electron", () => ({ BrowserWindow: FakeBrowserWindow, globalShortcut, ipcMain, screen }));
// The Electron module must be mocked before importing the controller under test.
const { PickupOverlayController } = await import("../src/electron/pickup-overlay.ts");

async function invoke(sender: FakeWebContents, command: string, value?: unknown, ...extra: unknown[]): Promise<unknown> {
  const handler = handlers.get("valeCompanion:pickup-overlay");
  if (!handler) throw new Error("Pickup overlay IPC handler was not registered.");
  return handler({ sender, senderFrame: sender.mainFrame }, command, value, ...extra);
}

function componentWindow(component: string): FakeBrowserWindow {
  const window = FakeBrowserWindow.instances.find((candidate) => !candidate.isDestroyed() && candidate.webContents.url.length > 0
    && new URL(candidate.webContents.url).searchParams.get("component") === component);
  if (!window) throw new Error(`Missing ${component} overlay window.`);
  return window;
}

test("F5 edits every component from a disabled master and restores locked visibility", async () => {
  FakeBrowserWindow.instances = [];
  shortcuts.clear();
  globalShortcut.available = true;
  const data = mkdtempSync(path.join(tmpdir(), "pickup-overlay-test-"));
  writeFileSync(path.join(data, "pickup-overlay.json"), JSON.stringify({ enabled: false, bounds: { x: 300, y: 200 } }));
  const mainWindow = new FakeBrowserWindow({ x: 0, y: 0, width: 1_280, height: 760 });
  const controller = new PickupOverlayController({ data, mainWindow: () => mainWindow as unknown as BrowserWindow, smokeTest: false });
  try {
    controller.start("http://127.0.0.1:43210/");
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(await invoke(mainWindow.webContents, "state")).toEqual({
      enabled: false,
      repositioning: false,
      components: { pickups: true, weight: false, items: false, gold: false },
      trackedItems: [],
      hotkeyAvailable: true,
    });

    shortcuts.get("F5")?.();
    await Promise.resolve();
    expect(FakeBrowserWindow.instances).toHaveLength(5);
    for (const component of ["pickups", "weight", "items", "gold"]) {
      const window = componentWindow(component);
      expect(window.isVisible()).toBe(true);
      expect(window.focusable).toBe(true);
      expect(window.ignoresMouse).toBe(false);
    }
    componentWindow("pickups").setPosition(310, 210);
    componentWindow("weight").setPosition(320, 220);
    componentWindow("items").setPosition(330, 230);
    componentWindow("gold").setPosition(340, 240);

    shortcuts.get("F5")?.();
    await Promise.resolve();
    for (const component of ["pickups", "weight", "items", "gold"]) {
      const window = componentWindow(component);
      expect(window.isVisible()).toBe(false);
      expect(window.focusable).toBe(false);
      expect(window.ignoresMouse).toBe(true);
    }
  } finally {
    controller.dispose();
    const saved = JSON.parse(readFileSync(path.join(data, "pickup-overlay.json"), "utf8"));
    expect(saved.bounds).toEqual({
      pickups: { x: 310, y: 210 },
      weight: { x: 320, y: 220 },
      items: { x: 330, y: 230 },
      gold: { x: 340, y: 240 },
    });
    expect(shortcuts.has("F5")).toBe(false);
    expect(handlers.has("valeCompanion:pickup-overlay")).toBe(false);
    rmSync(data, { recursive: true, force: true });
  }
});

test("component preferences, tracked item validation, and IPC trust are enforced", async () => {
  FakeBrowserWindow.instances = [];
  shortcuts.clear();
  globalShortcut.available = false;
  const data = mkdtempSync(path.join(tmpdir(), "pickup-overlay-test-"));
  const mainWindow = new FakeBrowserWindow({ x: 0, y: 0, width: 1_280, height: 760 });
  const controller = new PickupOverlayController({ data, mainWindow: () => mainWindow as unknown as BrowserWindow, smokeTest: false });
  try {
    controller.start("http://127.0.0.1:43210/");
    const pickups = componentWindow("pickups");
    const state = await invoke(mainWindow.webContents, "component", "weight", true);
    expect(state).toMatchObject({ hotkeyAvailable: false, components: { pickups: true, weight: true, items: false, gold: false } });
    expect(componentWindow("weight").isVisible()).toBe(true);

    await expect(invoke(mainWindow.webContents, "tracked", [
      { itemId: "iron", kind: "material", name: "Iron", icon: null },
      { itemId: "iron", kind: "material", name: "Duplicate", icon: null },
    ])).rejects.toThrow("unique");
    await expect(invoke(mainWindow.webContents, "tracked", [
      { itemId: "a", kind: "material", name: "A", icon: null },
      { itemId: "b", kind: "material", name: "B", icon: null },
      { itemId: "c", kind: "material", name: "C", icon: null },
      { itemId: "d", kind: "material", name: "D", icon: null },
    ])).rejects.toThrow("at most three");
    await expect(invoke(new FakeWebContents(), "enabled", true)).rejects.toThrow("must come from");
    await expect(invoke(mainWindow.webContents, "component", "unknown", true)).rejects.toThrow("invalid");
    const handler = handlers.get("valeCompanion:pickup-overlay");
    await expect(handler!({ sender: mainWindow.webContents, senderFrame: {} }, "state", undefined)).rejects.toThrow("must come from");

    await invoke(mainWindow.webContents, "enabled", false);
    await invoke(pickups.webContents, "state");
    const pickup = { sequence: 1, name: "Hidden", icon: null, quantity: 2, color: "#ffffff", tag: null, refine: 0, lines: [] };
    controller.forwardPickup(pickup);
    expect(pickups.webContents.sent).not.toContainEqual(["valeCompanion:pickup-overlay-pickup", pickup]);
  } finally {
    controller.dispose();
    const saved = JSON.parse(readFileSync(path.join(data, "pickup-overlay.json"), "utf8"));
    expect(saved.components).toEqual({ pickups: true, weight: true, items: false, gold: false });
    rmSync(data, { recursive: true, force: true });
  }
});

test("an active pickup renderer is replaced after exit and retains the ready handshake", async () => {
  FakeBrowserWindow.instances = [];
  shortcuts.clear();
  globalShortcut.available = true;
  const data = mkdtempSync(path.join(tmpdir(), "pickup-overlay-test-"));
  const mainWindow = new FakeBrowserWindow({ x: 0, y: 0, width: 1_280, height: 760 });
  const controller = new PickupOverlayController({ data, mainWindow: () => mainWindow as unknown as BrowserWindow, smokeTest: false });
  try {
    controller.start("http://127.0.0.1:43210/");
    const firstOverlay = componentWindow("pickups");
    await invoke(firstOverlay.webContents, "state");
    firstOverlay.webContents.emit("render-process-gone", {}, { reason: "crashed" });

    await invoke(mainWindow.webContents, "enabled", true);
    expect(firstOverlay.isDestroyed()).toBe(true);
    const recoveredOverlay = componentWindow("pickups");
    expect(recoveredOverlay).not.toBe(firstOverlay);
    await invoke(recoveredOverlay.webContents, "state");
    const pickup = { sequence: 1, name: "Recovered pickup", icon: null, quantity: 2, color: "#ffffff", tag: null, refine: 0, lines: [] };
    controller.forwardPickup(pickup);
    expect(recoveredOverlay.webContents.sent).toContainEqual(["valeCompanion:pickup-overlay-pickup", pickup]);
  } finally {
    controller.dispose();
    rmSync(data, { recursive: true, force: true });
  }
});
