import { ChartNoAxesCombined, Command, Coins, Radio, Settings, Store, X } from "lucide-preact";
import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  type CaptureDevice,
  type DesktopSettingsUpdate,
  type DesktopState,
  type LinuxCaptureMode,
  type LootItemView,
} from "../shared/contracts.ts";
import { LootWorkspace } from "./loot-workspace.tsx";
import { GoldWorkspace } from "./gold-workspace.tsx";
import { MarketWorkspace } from "./market-workspace.tsx";
import { bagSignature, marketOpenRequest, type MarketBridgeMessage } from "./market-bridge.ts";
import { companionModules, isModuleId, type ModuleId } from "./modules.ts";
import { UpdateNotice, UpdateSettings, useUpdates, type UpdatesModel } from "./updates.tsx";
import type { PickupOverlayState } from "../shared/pickup-overlay.ts";

const apiRoot = window.location.origin;

function App() {
  const updates = useUpdates();
  const [activeModule, setActiveModule] = useState<ModuleId>(() => {
    const stored = window.localStorage.getItem("valecompanion.active-module");
    return stored && isModuleId(stored) ? stored : "loot";
  });
  const [state, setState] = useState<DesktopState>();
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [connectionError, setConnectionError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const marketFrame = useRef<HTMLIFrameElement>(null);
  const sentBag = useRef<string>();
  const [marketLoads, setMarketLoads] = useState(0);

  const loadState = useCallback(async () => {
    try {
      const response = await fetch(`${apiRoot}/v1/state`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      setState(await response.json() as DesktopState);
      setConnectionError(undefined);
    } catch (error) {
      setState(undefined);
      setConnectionError(errorMessage(error));
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetch(`${apiRoot}/v1/devices`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const value = await response.json() as { devices?: CaptureDevice[] } | CaptureDevice[];
      setDevices(Array.isArray(value) ? value : value.devices ?? []);
    } catch (error) {
      setSettingsError(`Network adapters could not be listed: ${errorMessage(error)}`);
    }
  }, []);

  useEffect(() => {
    void loadState();
    const timer = window.setInterval(() => void loadState(), 2_000);
    return () => window.clearInterval(timer);
  }, [loadState]);

  useEffect(() => {
    if (state?.capture.availability === "ready") void loadDevices();
  }, [loadDevices, state?.capture.availability]);

  useEffect(() => {
    window.localStorage.setItem("valecompanion.active-module", activeModule);
  }, [activeModule]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setSwitcherOpen((open) => !open);
        return;
      }
      if (event.ctrlKey && (event.key === "1" || event.key === "2" || event.key === "3")) {
        event.preventDefault();
        const module = companionModules.find((entry) => entry.shortcut === event.key);
        if (module) setActiveModule(module.id);
        setSwitcherOpen(false);
        return;
      }
      if (event.key === "Escape") {
        setSwitcherOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source === window) return;
      if (typeof event.data !== "object" || event.data === null) return;
      const message = event.data as { type?: unknown; module?: unknown };
      if (message.type === "valecompanion:switcher") {
        setSwitcherOpen(true);
      } else if (message.type === "valecompanion:module" && typeof message.module === "string" && isModuleId(message.module)) {
        setActiveModule(message.module);
        setSwitcherOpen(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);


  const updateSettings = async (update: DesktopSettingsUpdate) => {
    setSettingsBusy(true);
    setSettingsError(undefined);
    try {
      const response = await fetch(`${apiRoot}/v1/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setState(await response.json() as DesktopState);
    } catch (error) {
      setSettingsError(errorMessage(error));
    } finally {
      setSettingsBusy(false);
    }
  };

  const restartCapture = async () => {
    setSettingsBusy(true);
    setSettingsError(undefined);
    try {
      const response = await fetch(`${apiRoot}/v1/capture/restart`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      setState(await response.json() as DesktopState);
    } catch (error) {
      setSettingsError(errorMessage(error));
    } finally {
      setSettingsBusy(false);
    }
  };

  const activateModule = (id: ModuleId) => {
    setActiveModule(id);
    setSwitcherOpen(false);
  };

  const postToMarket = (message: MarketBridgeMessage) => {
    marketFrame.current?.contentWindow?.postMessage(message, window.location.origin);
  };

  const findInMarket = (item: LootItemView) => {
    activateModule("market");
    postToMarket(marketOpenRequest(item));
  };

  useEffect(() => {
    if (activeModule !== "market" || !state) return;
    const signature = `${marketLoads}:${bagSignature(state.bag)}`;
    if (signature === sentBag.current) return;
    sentBag.current = signature;
    postToMarket({ type: "valecompanion:bag", bag: state.bag });
  }, [activeModule, marketLoads, state?.bag]);

  return (
    <div class="suite-shell">
      <aside class="suite-dock" aria-label="Vale Companion modules">
        <div class="suite-mark" aria-label="Vale Companion">V</div>
        <nav class="dock-modules">
          {companionModules.map((module) => {
            const Icon = module.id === "loot" ? Coins : module.id === "market" ? Store : ChartNoAxesCombined;
            return <button class={`dock-button ${activeModule === module.id ? "active" : ""}`} type="button" aria-label={module.name} aria-current={activeModule === module.id ? "page" : undefined} data-tooltip={module.name} onClick={() => activateModule(module.id)}><Icon size={21} strokeWidth={1.7} /><kbd>⌃{module.shortcut}</kbd></button>;
          })}
        </nav>
        <div class="dock-spacer" />
        <button class="dock-button" type="button" aria-label="Switch module" data-tooltip="Switch module" onClick={() => setSwitcherOpen(true)}><Command size={20} strokeWidth={1.7} /><kbd>⌃K</kbd></button>
        <button class={`dock-button ${settingsOpen ? "active" : ""}`} type="button" aria-label="Settings" data-tooltip="Settings" onClick={() => setSettingsOpen((open) => !open)}><Settings size={20} strokeWidth={1.7} /></button>
        <div class="dock-capture" title={state?.detail ?? "Connecting to collector"}><span class={`state-light ${state?.phase ?? "offline"}`} /><Radio size={13} /><span class="visually-hidden">{state?.detail ?? "Connecting to collector"}</span></div>
      </aside>

      <div class="module-stage">
        <section class={`module-pane ${activeModule === "loot" ? "active" : ""}`} aria-hidden={activeModule !== "loot"}>
          <LootWorkspace state={state} connectionError={connectionError} refreshState={loadState} onFindInMarket={findInMarket} />
        </section>
        <section class={`module-pane ${activeModule === "market" ? "active" : ""}`} aria-hidden={activeModule !== "market"}>
          <MarketWorkspace frameRef={marketFrame} onLoad={() => setMarketLoads((count) => count + 1)} />
        </section>
        <section class={`module-pane ${activeModule === "gold" ? "active" : ""}`} aria-hidden={activeModule !== "gold"}>
          <GoldWorkspace state={state} connectionError={connectionError} refreshState={loadState} />
        </section>
      </div>

      {switcherOpen && <div class="overlay-scrim" onMouseDown={() => setSwitcherOpen(false)}><section class="module-switcher" role="dialog" aria-modal="true" aria-labelledby="switcher-title" onMouseDown={(event) => event.stopPropagation()}><header><div><div class="eyebrow">Vale Companion</div><h2 id="switcher-title">Switch module</h2></div><button type="button" onClick={() => setSwitcherOpen(false)} aria-label="Close module switcher"><X size={17} /></button></header><div>{companionModules.map((module) => { const Icon = module.id === "loot" ? Coins : module.id === "market" ? Store : ChartNoAxesCombined; return <button class={activeModule === module.id ? "active" : ""} type="button" onClick={() => activateModule(module.id)}><Icon size={19} /><span><strong>{module.name}</strong><small>{module.description}</small></span><kbd>Ctrl {module.shortcut}</kbd></button>; })}</div></section></div>}

      {!settingsOpen && <UpdateNotice updates={updates} onDetails={() => setSettingsOpen(true)} />}
      {settingsOpen && <GlobalSettings updates={updates} state={state} devices={devices} busy={settingsBusy} error={settingsError} onClose={() => setSettingsOpen(false)} onUpdate={updateSettings} onRestart={restartCapture} />}
    </div>
  );
}

function GlobalSettings({ updates, state, devices, busy, error, onClose, onUpdate, onRestart }: {
  updates: UpdatesModel;
  state: DesktopState | undefined;
  devices: CaptureDevice[];
  busy: boolean;
  error: string | undefined;
  onClose(): void;
  onUpdate(update: DesktopSettingsUpdate): void;
  onRestart(): void;
}) {
  const linuxCapture = state ? ["libpcap", "libpcap (direct)", "dumpcap"].includes(state.capture.backend) : false;
  const [soundVolume, setSoundVolume] = useState(state?.soundVolume ?? 100);
  useEffect(() => { setSoundVolume(state?.soundVolume ?? 100); }, [state?.soundVolume]);
  return <aside class="settings-drawer" aria-label="Settings">
    <header><div><div class="eyebrow">Vale Companion</div><h2>Settings</h2></div><button type="button" onClick={onClose} aria-label="Close settings"><X size={17} /></button></header>
    <div class="settings-scroll">
      <UpdateSettings updates={updates} />
      {error && <div class="settings-error" role="alert">{error}</div>}
      <section><div class="settings-heading"><span>Capture</span><button type="button" disabled={!state || busy} onClick={onRestart}>{busy ? "Working…" : "Restart"}</button></div>
        <label class="switch-row"><span><strong>Passive capture</strong><small>Observe local Spirit Vale traffic for enabled modules.</small></span><input type="checkbox" role="switch" checked={state?.enabled ?? false} disabled={!state || busy} onChange={(event) => onUpdate({ enabled: event.currentTarget.checked })} /></label>
        <label class="settings-field"><span>Network adapter</span><select value={state?.deviceName ?? ""} disabled={!state || busy || state.capture.availability !== "ready"} onChange={(event) => onUpdate({ deviceName: event.currentTarget.value || null })}><option value="">Automatic</option>{devices.filter((device) => !device.loopback).map((device) => <option key={device.name} value={device.name}>{device.description || device.name}</option>)}</select><small>{state?.captureAdapter ? `Using ${state.captureAdapter.description}` : "Uses the active default-route adapter."}</small></label>
        {linuxCapture && <label class="settings-field"><span>Linux capture method</span><select value={state?.linuxCaptureMode ?? "auto"} disabled={!state || busy} onChange={(event) => onUpdate({ linuxCaptureMode: event.currentTarget.value as LinuxCaptureMode })}><option value="auto">Automatic</option><option value="dumpcap">dumpcap helper</option><option value="libpcap">Direct libpcap</option></select></label>}
      </section>
      <section><div class="settings-heading"><span>Modules</span></div>
        <label class="switch-row"><span><strong>Loot alerts</strong><small>Play sounds for matching inventory rules.</small></span><input type="checkbox" role="switch" checked={state?.soundsEnabled ?? false} disabled={!state || busy} onChange={(event) => onUpdate({ soundsEnabled: event.currentTarget.checked })} /></label>
        <label class="switch-row"><span><strong>Market contribution</strong><small>Upload normalized listings. Raw packets never leave this device.</small></span><input type="checkbox" role="switch" checked={state?.contributionEnabled ?? false} disabled={!state || busy} onChange={(event) => onUpdate({ contributionEnabled: event.currentTarget.checked })} /></label>
      </section>
      <section>
        <div class="settings-heading"><span>Loot sounds</span></div>
        <label class="settings-field">
          <span>Alert volume <output>{soundVolume}%</output></span>
          <input type="range" aria-label="Alert volume" min="0" max="100" step="1"
            value={soundVolume} disabled={!state || busy}
            onInput={(event) => setSoundVolume(Number(event.currentTarget.value))}
            onChange={(event) => onUpdate({ soundVolume: Number(event.currentTarget.value) })} />
          <small>Applies to built-in and custom sounds. 0% mutes audio without hiding pickup history.</small>
        </label>
        <div class="settings-copy">
          <strong>Custom alert folder</strong>
          <p>Drop <code>.wav</code> files here. Vale Companion detects them automatically; use <code>Sound filename</code> in a rule, with or without the extension.</p>
          <code class="settings-path">{state?.soundsDirectory ?? "Loading sounds folder…"}</code>
        </div>
        <div class="settings-copy">
          <strong>Available sounds</strong>
          <p class="sound-list">{(state?.sounds ?? []).join(", ") || "Loading…"}</p>
        </div>
      </section>
      <PickupOverlaySettings />
      <section>
        <div class="settings-heading"><span>Diagnostics</span></div>
        {state?.warning && <div class="diagnostic-warning">{state.warning}</div>}
        <div class="diagnostic-state">
          <strong>{state?.capture.availability === "ready" ? "Capture backend ready" : state?.capture.availability === "missing" ? "Capture backend missing" : state?.capture.availability === "error" ? "Capture backend unavailable" : "Checking capture backend"}</strong>
          <p>{state?.capture.detail ?? "Waiting for the local collector."}</p>
          {state?.capture.version && <code>{state.capture.backend} {state.capture.version}</code>}
          {state?.captureAdapter && <p>{state.captureAdapter.selection === "automatic" ? "Automatic" : "Manual"} adapter · {state.captureAdapter.description}{state.automaticCaptureRestarts ? ` · ${state.automaticCaptureRestarts} route restart${state.automaticCaptureRestarts === 1 ? "" : "s"}` : ""}</p>}
        </div>
        <dl class="diagnostic-grid">
          <div><dt>Packets observed</dt><dd>{(state?.packetsObserved ?? 0).toLocaleString()}</dd></div>
          <div><dt>Loot snapshots</dt><dd>{(state?.snapshotsDecoded ?? 0).toLocaleString()}</dd></div>
          <div><dt>Partial snapshots</dt><dd>{(state?.partialSnapshots ?? 0).toLocaleString()}</dd></div>
          <div><dt>Duplicate snapshots</dt><dd>{(state?.duplicateSnapshots ?? 0).toLocaleString()}</dd></div>
          <div><dt>Market listings decoded</dt><dd>{(state?.market.listingsDecoded ?? 0).toLocaleString()}</dd></div>
          <div><dt>Market queue</dt><dd>{state ? `${state.market.queuedBatches} batches` : "—"}</dd></div>
        </dl>
        <div class="settings-copy">
          <strong>Diagnostic logs</strong>
          <p>Desktop, collector, capture, connection, warning, and shutdown events stay local in this folder.</p>
          <code class="settings-path">{state?.logsDirectory ?? "Loading log folder…"}</code>
        </div>
      </section>
      <section class="runtime-summary"><div class="settings-heading"><span>Runtime</span></div><dl><div><dt>Status</dt><dd><span class={`state-light ${state?.phase ?? "offline"}`} />{state?.detail ?? "Connecting"}</dd></div><div><dt>Last traffic</dt><dd>{state?.lastAttributedPacketAt ? new Date(state.lastAttributedPacketAt).toLocaleString() : "Not observed"}</dd></div><div><dt>Version</dt><dd>{state ? `v${state.version}` : "—"}</dd></div></dl></section>
    </div>
  </aside>;
}

function PickupOverlaySettings() {
  const api = window.valeCompanion?.pickupOverlay;
  const [state, setState] = useState<PickupOverlayState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!api) return;
    let active = true;
    const unsubscribe = api.onState((next) => { if (active) setState(next); });
    void api.getState().then(
      (next) => { if (active) setState(next); },
      (cause) => { if (active) setError(errorMessage(cause)); },
    );
    return () => { active = false; unsubscribe(); };
  }, [api]);

  const update = async (action: () => Promise<PickupOverlayState>) => {
    setBusy(true);
    setError(undefined);
    try { setState(await action()); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };

  return <section>
    <div class="settings-heading"><span>Pickup overlay</span></div>
    {error && <div class="settings-error" role="alert">{error}</div>}
    <label class="switch-row">
      <span><strong>On-screen pickups</strong><small>Show matched loot with icons, quantities, and rule colors.</small></span>
      <input type="checkbox" role="switch" checked={state?.enabled ?? false} disabled={!api || !state || busy}
        onChange={(event) => { const enabled = event.currentTarget.checked; if (api) void update(() => api.setEnabled(enabled)); }} />
    </label>
    <div class="overlay-settings-actions">
      <button type="button" disabled={!api || !state?.enabled || busy}
        onClick={() => { if (api) void update(() => state?.repositioning ? api.finishReposition() : api.reposition()); }}>
        {state?.repositioning ? "Lock position" : "Reposition"}
      </button>
      <button type="button" disabled={!api || !state || busy}
        onClick={() => { if (api) void update(() => api.resetPosition()); }}>Reset position</button>
    </div>
    <div class="settings-copy"><p>{api
      ? "Up to five pickups fade after five seconds. Click-through while locked; drag the handle in Reposition mode, then choose Done. Position is remembered. Best with borderless or windowed gameplay; exclusive fullscreen may hide the overlay."
      : "The pickup overlay is available in the desktop application."}</p></div>
  </section>;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status} ${response.statusText}`;
  try {
    const value = JSON.parse(text) as { error?: unknown };
    if (typeof value.error === "string") return value.error;
  } catch {}
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

render(<App />, document.getElementById("app")!);
