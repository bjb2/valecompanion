import { render } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { PickupNotification, PickupOverlayState } from "../shared/pickup-overlay.ts";
import { statLabel } from "../shared/stat-labels.ts";

const MAX_NOTIFICATIONS = 5;
const EXPIRY_MS = 5_000;
const SAMPLE_PICKUP: PickupNotification = {
  sequence: -1,
  name: "Move this pickup overlay",
  icon: null,
  quantity: 1,
  color: "#c8a961",
  tag: "POSITION",
  refine: 0,
  lines: [],
};

type TimedPickup = PickupNotification & { id: number; expiresAt: number };

function PickupOverlay(): JSX.Element {
  const [state, setState] = useState<PickupOverlayState>({ enabled: false, repositioning: false });
  const [pickups, setPickups] = useState<TimedPickup[]>([]);
  const stackRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const overlay = window.valeCompanion?.pickupOverlay;
    if (!overlay) return;
    let nextId = 0;
    void overlay.getState().then(setState).catch(() => undefined);
    const stopState = overlay.onState((next) => {
      setState(next);
      if (!next.enabled) setPickups([]);
    });
    const stopPickup = overlay.onPickup((pickup) => {
      const id = nextId++;
      setPickups((current) => [...current, { ...pickup, id, expiresAt: Date.now() + EXPIRY_MS }].slice(-MAX_NOTIFICATIONS));
    });
    return () => {
      stopState();
      stopPickup();
    };
  }, []);

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
  }, [pickups, state.repositioning]);

  const visiblePickups = pickups.length > 0 ? pickups : state.repositioning ? [{ ...SAMPLE_PICKUP, id: -1, expiresAt: Infinity }] : [];
  return <main class={`pickup-overlay ${state.repositioning ? "repositioning" : "locked"}`} aria-live="polite" aria-relevant="additions">
    {state.repositioning && <header class="position-controls">
      <div class="drag-handle" aria-label="Drag to move pickup overlay" title="Drag to move pickup overlay"><span aria-hidden="true">⠿</span> Drag to position</div>
      <button class="done-button" type="button" onClick={() => { void window.valeCompanion?.pickupOverlay?.finishReposition(); }}>Done</button>
    </header>}
    <section ref={stackRef} class="pickup-stack" aria-label="Recent item pickups">
      {visiblePickups.map((pickup) => <PickupCard key={pickup.id} pickup={pickup} sample={pickup.id === -1} />)}
    </section>
  </main>;
}

function PickupCard({ pickup, sample }: { pickup: TimedPickup; sample: boolean }): JSX.Element {
  const quantity = pickup.quantity > 0 ? `+${pickup.quantity}` : `${pickup.quantity}`;
  return <article class={`pickup-card ${sample ? "sample" : ""}`} style={{ "--pickup-color": pickup.color }}>
    <div class="rule-edge" />
    <div class="pickup-heading">
      {pickup.icon ? <img class="pickup-icon" src={`/v1/icons/${encodeURIComponent(pickup.icon)}`} alt="" /> : <span class="pickup-icon fallback" aria-hidden="true">◆</span>}
      <div class="pickup-copy"><strong>{pickup.refine > 0 ? `+${pickup.refine} ` : ""}{pickup.name}</strong>{pickup.tag && <span class="pickup-tag">{pickup.tag}</span>}</div>
      <span class="pickup-quantity">{quantity}</span>
    </div>
    {pickup.lines.length > 0 && <dl class="pickup-stats">
      {pickup.lines.map((line, index) => <div key={index} class={line.over ? "over" : line.rollPct >= 100 ? "perfect" : ""}>
        <dt>{statLabel(line.stat)}{line.isChaos && <small>Chaos</small>}</dt>
        <dd><strong>{line.printed ?? "—"}</strong><span>{Math.round(line.rollPct)}% roll</span></dd>
      </div>)}
    </dl>}
  </article>;
}

render(<PickupOverlay />, document.getElementById("app")!);
