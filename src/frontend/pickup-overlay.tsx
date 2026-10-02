import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  OVERLAY_COMPONENTS,
  type OverlayComponent,
  type OverlayData,
  type PickupNotification,
  type PickupOverlayState,
  type TrackedOverlayItem,
} from "../shared/pickup-overlay.ts";
import { statLabel } from "../shared/stat-labels.ts";

const MAX_NOTIFICATIONS = 5;
const EXPIRY_MS = 5_000;
const SAMPLE_PICKUP: PickupNotification = {
  sequence: -1, name: "Move this pickup overlay", icon: null, quantity: 1, color: "#c8a961", tag: "POSITION", refine: 0, lines: [],
};
const COMPONENT_LABELS: Record<OverlayComponent, string> = { pickups: "Pickups", weight: "Bag weight", items: "Tracked items", gold: "Gold / hour" };

type TimedPickup = PickupNotification & { id: number; expiresAt: number };

function emptyState(): PickupOverlayState {
  return { enabled: false, repositioning: false, components: { pickups: true, weight: false, items: false, gold: false }, trackedItems: [], hotkeyAvailable: true };
}

function componentFromLocation(): OverlayComponent {
  const component = new URLSearchParams(window.location.search).get("component");
  return OVERLAY_COMPONENTS.includes(component as OverlayComponent) ? component as OverlayComponent : "pickups";
}

function PickupOverlay(): JSX.Element {
  const component = componentFromLocation();
  const [state, setState] = useState<PickupOverlayState>(emptyState);
  const [data, setData] = useState<OverlayData>();
  const [dataError, setDataError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pickups, setPickups] = useState<TimedPickup[]>([]);
  const stackRef = useRef<HTMLElement>(null);
  const editing = state.repositioning;
  const visible = editing || (state.enabled && state.components[component]);

  useEffect(() => {
    const overlay = window.valeCompanion?.pickupOverlay;
    if (!overlay) return;
    let nextId = 0;
    void overlay.getState().then(setState).catch((cause) => setActionError(errorMessage(cause)));
    const stopState = overlay.onState((next) => {
      setState(next);
      if (!next.enabled || !next.components.pickups) setPickups([]);
    });
    const stopPickup = overlay.onPickup((pickup) => {
      const id = nextId++;
      setPickups((current) => [...current, { ...pickup, id, expiresAt: Date.now() + EXPIRY_MS }].slice(-MAX_NOTIFICATIONS));
    });
    return () => { stopState(); stopPickup(); };
  }, []);

  useEffect(() => {
    if (!visible || component === "pickups") return;
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        const response = await fetch("/v1/overlay", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Overlay data unavailable (${response.status})`);
        const next = await response.json() as OverlayData;
        if (!disposed) { setData(next); setDataError(undefined); }
      } catch (cause) {
        if (!disposed && !(cause instanceof DOMException && cause.name === "AbortError")) setDataError(errorMessage(cause));
      } finally {
        if (!disposed) timer = window.setTimeout(poll, 2_000);
      }
    };
    void poll();
    return () => { disposed = true; controller?.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [visible, component]);

  useEffect(() => {
    if (pickups.length === 0) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setPickups((current) => current.filter((pickup) => pickup.expiresAt > now));
    }, Math.max(0, pickups[0]!.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pickups]);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack || pickups.length < 2) return;
    const fit = () => {
      const cards = Array.from(stack.children);
      const gap = Number.parseFloat(getComputedStyle(stack).rowGap) || 0;
      let used = 0;
      let keep = 0;
      for (let index = cards.length - 1; index >= 0; index--) {
        const height = (cards[index] as HTMLElement).offsetHeight + (keep ? gap : 0);
        if (keep > 0 && used + height > stack.clientHeight) break;
        used += height;
        keep++;
      }
      if (keep < cards.length) setPickups((current) => current.slice(-keep));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(stack);
    fit();
    return () => observer.disconnect();
  }, [pickups, editing]);

  const update = async (action: () => Promise<PickupOverlayState>) => {
    setBusy(true);
    setActionError(undefined);
    try { setState(await action()); } catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const visiblePickups = pickups.length > 0 ? pickups : editing ? [{ ...SAMPLE_PICKUP, id: -1, expiresAt: Infinity }] : [];

  return <main class={`pickup-overlay ${editing ? "repositioning" : "locked"} component-${component} ${visible ? "visible" : "hidden"}`} aria-live="polite" aria-relevant="additions">
    {editing && <header class="position-controls">
      <div class="drag-handle" aria-label={`Drag to move ${COMPONENT_LABELS[component]}`} title="Drag to position"><span aria-hidden="true">⠿</span> Drag to position</div>
      <label class="component-toggle"><input type="checkbox" checked={state.components[component]} disabled={busy} onChange={(event) => { const enabled = event.currentTarget.checked; const api = window.valeCompanion?.pickupOverlay; if (api) void update(() => api.setComponentEnabled(component, enabled)); }} /> Show</label>
      <button class="done-button" type="button" disabled={busy} onClick={() => { const api = window.valeCompanion?.pickupOverlay; if (api) void update(() => api.finishReposition()); }}>Done</button>
    </header>}
    {actionError && editing && <div class="overlay-error" role="alert">{actionError}</div>}
    {visible && <OverlayComponentView component={component} data={data} dataError={dataError} state={state} pickups={visiblePickups} stackRef={stackRef} editing={editing} busy={busy} onTrackedItems={(items) => { const api = window.valeCompanion?.pickupOverlay; if (api) void update(() => api.setTrackedItems(items)); }} />}
  </main>;
}

function OverlayComponentView({ component, data, dataError, state, pickups, stackRef, editing, busy, onTrackedItems }: {
  component: OverlayComponent; data: OverlayData | undefined; dataError: string | undefined; state: PickupOverlayState; pickups: TimedPickup[]; stackRef: { current: HTMLElement | null }; editing: boolean; busy: boolean; onTrackedItems(items: TrackedOverlayItem[]): void;
}): JSX.Element {
  if (component === "pickups") return <section ref={stackRef} class="pickup-stack" aria-label="Recent item pickups">{pickups.map((pickup) => <PickupCard key={pickup.id} pickup={pickup} sample={pickup.id === -1} />)}</section>;
  if (dataError) return <StatusCard title={COMPONENT_LABELS[component]} message="Disconnected — waiting for overlay data" />;
  if (!data) return <StatusCard title={COMPONENT_LABELS[component]} message="Connecting to overlay data…" />;
  if (component === "items") return <ItemsCard data={data} state={state} editing={editing} busy={busy} onTrackedItems={onTrackedItems} />;
  if (component === "gold") return <GoldCard data={data} />;
  if (!data.gameDetected) return <StatusCard title={COMPONENT_LABELS[component]} message="Waiting for Spirit Vale" />;
  return <WeightCard data={data} />;
}

function StatusCard({ title, message }: { title: string; message: string }): JSX.Element {
  return <section class="component-card component-status"><span>{title}</span><strong>{message}</strong></section>;
}

function WeightCard({ data }: { data: OverlayData }): JSX.Element {
  const { current, total, reason } = data.bagWeight;
  if (current === null) return <StatusCard title="Bag weight" message={reason || "Waiting for bag inventory"} />;
  const percent = total !== null && total > 0 ? Math.max(0, current / total * 100) : null;
  return <section class="component-card weight-card" title={reason}><div class="component-heading"><span>Bag weight</span>{percent !== null && <b>{Math.round(percent)}%</b>}</div><strong>{formatNumber(current)} <small>/ {total === null ? "—" : formatNumber(total)}</small></strong>{percent !== null ? <div class="usage-track" aria-label={`${Math.round(percent)} percent full`}><i style={{ width: `${Math.min(100, percent)}%` }} /></div> : <span class="gold-session">Capacity not yet available</span>}</section>;
}

function ItemsCard({ data, state, editing, busy, onTrackedItems }: { data: OverlayData; state: PickupOverlayState; editing: boolean; busy: boolean; onTrackedItems(items: TrackedOverlayItem[]): void }): JSX.Element {
  const [query, setQuery] = useState("");
  const selected = state.trackedItems;
  const inventory = useMemo(() => {
    const items: TrackedOverlayItem[] = [];
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const item of data.bag) {
      const key = `${item.kind}:${item.itemId}`;
      counts.set(key, (counts.get(key) ?? 0) + item.count);
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ itemId: item.itemId, kind: item.kind, name: item.name, icon: item.icon });
      }
    }
    return { items, counts };
  }, [data.bag]);
  const choices = inventory.items.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || item.kind.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const select = (item: TrackedOverlayItem) => { if (selected.length < 3 && !selected.some((entry) => sameItem(entry, item))) onTrackedItems([...selected, item]); };
  const remove = (item: TrackedOverlayItem) => onTrackedItems(selected.filter((entry) => !sameItem(entry, item)));
  return <section class="component-card items-card"><div class="component-heading"><span>Tracked items</span><b>{selected.length}/3</b></div>
    {!data.gameDetected && <span class="empty-copy">Waiting for Spirit Vale · last observed bag</span>}
    <div class="tracked-list">{selected.length === 0 ? <span class="empty-copy">Choose up to three items while editing.</span> : selected.map((item) => <div class="tracked-item" key={`${item.kind}:${item.itemId}`}><ItemIcon item={item} /><strong>{item.name}</strong><b>{data.bagGeneratedAt === null ? "—" : formatNumber(inventory.counts.get(`${item.kind}:${item.itemId}`) ?? 0)}</b>{editing && <button type="button" class="icon-button" disabled={busy} onClick={() => remove(item)} aria-label={`Stop tracking ${item.name}`}>×</button>}</div>)}</div>
    {editing && <div class="item-picker"><input value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="Search current bag" aria-label="Search bag items" />{selected.length < 3 && <div class="item-options">{choices.filter((item) => !selected.some((entry) => sameItem(entry, item))).map((item) => <button type="button" key={`${item.kind}:${item.itemId}`} disabled={busy} onClick={() => select(item)}><ItemIcon item={item} /><span>{item.name}<small>{item.kind}</small></span><b>{formatNumber(inventory.counts.get(`${item.kind}:${item.itemId}`) ?? 0)}</b></button>)}{choices.length === 0 && <span class="empty-copy">No matching bag items.</span>}</div>}</div>}
  </section>;
}

function GoldCard({ data }: { data: OverlayData }): JSX.Element {
  const gold = data.gold;
  if (gold.status === "waiting") return <StatusCard title="Gold / hour" message="Waiting for gold activity" />;
  return <section class="component-card gold-card"><div class="component-heading"><span>Gold / hour</span><b>{gold.status === "paused" ? "Paused · session" : "Gross · session"}</b></div><strong>{formatNumber(gold.goldPerHour)}<small> / hr</small></strong><span class="gold-session">Session gross {formatNumber(gold.earned)}</span></section>;
}

function ItemIcon({ item }: { item: TrackedOverlayItem }): JSX.Element { return item.icon ? <img class="tracked-icon" src={`/v1/icons/${encodeURIComponent(item.icon)}`} alt="" /> : <span class="tracked-icon fallback" aria-hidden="true">◆</span>; }
function sameItem(a: Pick<TrackedOverlayItem, "kind" | "itemId">, b: Pick<TrackedOverlayItem, "kind" | "itemId">): boolean { return a.kind === b.kind && a.itemId === b.itemId; }
function formatNumber(value: number): string { return value.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function PickupCard({ pickup, sample }: { pickup: TimedPickup; sample: boolean }): JSX.Element {
  const quantity = pickup.quantity > 0 ? `+${pickup.quantity}` : `${pickup.quantity}`;
  return <article class={`pickup-card ${sample ? "sample" : ""}`} style={{ "--pickup-color": pickup.color }}><div class="rule-edge" /><div class="pickup-heading">{pickup.icon ? <img class="pickup-icon" src={`/v1/icons/${encodeURIComponent(pickup.icon)}`} alt="" /> : <span class="pickup-icon fallback" aria-hidden="true">◆</span>}<div class="pickup-copy"><strong>{pickup.refine > 0 ? `+${pickup.refine} ` : ""}{pickup.name}</strong>{pickup.tag && <span class="pickup-tag">{pickup.tag}</span>}</div><span class="pickup-quantity">{quantity}</span></div>{pickup.lines.length > 0 && <dl class="pickup-stats">{pickup.lines.map((line, index) => <div key={index} class={line.over ? "over" : line.rollPct >= 100 ? "perfect" : ""}><dt>{statLabel(line.stat)}{line.isChaos && <small>Chaos</small>}</dt><dd><strong>{line.printed ?? "—"}</strong><span>{Math.round(line.rollPct)}% roll</span></dd></div>)}</dl>}</article>;
}

render(<PickupOverlay />, document.getElementById("app")!);
