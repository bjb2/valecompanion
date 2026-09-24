import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";

class FakeWebContents extends EventEmitter {
  readonly mainFrame = {};
  readonly sent: Array<[string, ...unknown[]]> = [];
  loads = 0;

  setWindowOpenHandler(): void {}

  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, ...args]);
  }

  async loadURL(_url: string): Promise<void> {
    this.loads += 1;
    this.emit("did-finish-load");
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  private destroyed = false;
  private visible = false;
  private bounds = { x: 0, y: 0, width: 430, height: 680 };

  constructor(bounds: { x: number; y: number; width: number; height: number }) {
    super();
    this.bounds = bounds;
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
  setFocusable(): void {}
  setIgnoreMouseEvents(): void {}
  showInactive(): void { this.visible = true; }
  hide(): void { this.visible = false; }
  getBounds() { return this.bounds; }
  setBounds(bounds: typeof this.bounds): void { this.bounds = bounds; }
  setPosition(x: number, y: number): void { this.bounds = { ...this.bounds, x, y }; }
  isVisible(): boolean { return this.visible; }
}

type IpcEvent = { sender: FakeWebContents; senderFrame: object };
type IpcHandler = (event: IpcEvent, command: unknown, value: unknown, ...extra: unknown[]) => unknown;

const handlers = new Map<string, IpcHandler>();
const ipcMain = {
  handle(channel: string, handler: IpcHandler): void { handlers.set(channel, handler); },
};
const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }),
});
mock.module("electron", () => ({ BrowserWindow: FakeBrowserWindow, ipcMain, screen }));
// The Electron module must be mocked before importing the controller under test.
const { PickupOverlayController } = await import("../src/electron/pickup-overlay.ts");

async function invoke(sender: FakeWebContents, command: string, value?: unknown): Promise<unknown> {
  const handler = handlers.get("valeCompanion:pickup-overlay");
  if (!handler) throw new Error("Pickup overlay IPC handler was not registered.");
  return handler({ sender, senderFrame: sender.mainFrame }, command, value);
}

test("enabling an already-enabled overlay replaces a renderer that exited", async () => {
  FakeBrowserWindow.instances = [];
  const data = mkdtempSync(path.join(tmpdir(), "pickup-overlay-test-"));
  const mainWindow = new FakeBrowserWindow({ x: 0, y: 0, width: 1_280, height: 760 });
  // The fake implements only the BrowserWindow methods exercised by this controller.
  const electronMainWindow = mainWindow as unknown as BrowserWindow;
  const controller = new PickupOverlayController({ data, mainWindow: () => electronMainWindow, smokeTest: false });
  try {
    controller.start("http://127.0.0.1:43210/");
    const firstOverlay = FakeBrowserWindow.instances[1]!;
    await invoke(firstOverlay.webContents, "state");
    firstOverlay.webContents.emit("render-process-gone", {}, { reason: "crashed" });

    await invoke(mainWindow.webContents, "enabled", true);

    expect(firstOverlay.isDestroyed()).toBe(true);
    const recoveredOverlay = FakeBrowserWindow.instances[2]!;
    expect(recoveredOverlay).not.toBe(firstOverlay);
    expect(recoveredOverlay.isVisible()).toBe(true);

    await invoke(recoveredOverlay.webContents, "state");
    const pickup = { sequence: 1, name: "Recovered pickup", icon: null, quantity: 2, color: "#ffffff", tag: null, refine: 0, lines: [] };
    controller.forwardPickup(pickup);
    expect(recoveredOverlay.webContents.sent).toContainEqual(["valeCompanion:pickup-overlay-pickup", pickup]);
    recoveredOverlay.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    const repositioned = await invoke(mainWindow.webContents, "reposition");

    expect(recoveredOverlay.isDestroyed()).toBe(true);
    const repositionedOverlay = FakeBrowserWindow.instances[3]!;
    expect(repositionedOverlay).not.toBe(recoveredOverlay);
    expect(repositionedOverlay.isVisible()).toBe(true);
    expect(repositioned).toEqual({ enabled: true, repositioning: true });
  } finally {
    controller.dispose();
    rmSync(data, { recursive: true, force: true });
  }
});
