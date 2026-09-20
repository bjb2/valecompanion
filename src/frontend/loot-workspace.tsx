import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  type AlertHistoryView,
  type DesktopState,
  type LootItemView,
  type MarketValueView,
  type ProfileCommand,
} from "../shared/contracts.ts";
import { statLabel } from "../shared/stat-labels.ts";
import { exactMoney, shortMoney } from "./format.ts";

const apiRoot = window.location.origin;
type Surface = "bag" | "storage" | "filters" | "history";
type BagOrder = "name" | "value";

const INVENTORY_CATEGORIES: Array<[LootItemView["kind"], string]> = [
  ["equipment", "Equipment"], ["artifact", "Artifacts"], ["card", "Cards"], ["gem", "Gems"],
  ["material", "Materials"], ["consumable", "Consumables"], ["cosmetic", "Cosmetics"], ["grimoire", "Grimoires"],
];
interface InventoryGrouping {
  enabled: boolean;
  collapsed: string[];
  setEnabled(value: boolean): void;
  toggle(kind: string): void;
}
function readGrouping(): { enabled: boolean; collapsed: string[] } {
  try {
    const value = JSON.parse(localStorage.getItem("valecompanion.inventory-grouping") ?? "null");
    return { enabled: value?.enabled !== false, collapsed: Array.isArray(value?.collapsed) ? value.collapsed.filter((kind: unknown) => typeof kind === "string" && INVENTORY_CATEGORIES.some(([key]) => key === kind)) : [] };
  } catch { return { enabled: true, collapsed: [] }; }
}

export interface LootWorkspaceProps {
  state: DesktopState | undefined;
  connectionError: string | undefined;
  refreshState(): Promise<void>;
  onFindInMarket(item: LootItemView): void;
}

export function LootWorkspace({ state, connectionError, refreshState, onFindInMarket }: LootWorkspaceProps) {
  const [groupPreference, setGroupPreference] = useState(readGrouping);
  useEffect(() => {
    try { localStorage.setItem("valecompanion.inventory-grouping", JSON.stringify(groupPreference)); } catch { /* Keep the preference for this session when storage is unavailable. */ }
  }, [groupPreference]);
  const grouping: InventoryGrouping = {
    ...groupPreference,
    setEnabled: (enabled) => setGroupPreference((previous) => ({ ...previous, enabled })),
    toggle: (kind) => setGroupPreference((previous) => ({ ...previous, collapsed: previous.collapsed.includes(kind) ? previous.collapsed.filter((key) => key !== kind) : [...previous.collapsed, kind] })),
  };
  const [surface, setSurface] = useState<Surface>("filters");
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState("");
  const [matchesOnly, setMatchesOnly] = useState(false);
  const [order, setOrder] = useState<BagOrder>("name");
  const [selectedUid, setSelectedUid] = useState<string>();
  const [filterText, setFilterText] = useState("");
  const [filterDirty, setFilterDirty] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [history, setHistory] = useState<AlertHistoryView[]>([]);
  const [editorScroll, setEditorScroll] = useState(0);



  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(`${apiRoot}/v1/history`, { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response));
      const value = await response.json() as { history?: AlertHistoryView[] } | AlertHistoryView[];
      setHistory(Array.isArray(value) ? value : value.history ?? []);
    } catch (error) {
      setActionError(`Alert history could not be loaded: ${errorMessage(error)}`);
    }
  }, []);



  useEffect(() => {
    if (!filterDirty && state) setFilterText(state.filter.text);
  }, [filterDirty, state?.filter.text]);



  useEffect(() => {
    if (surface === "history") void loadHistory();
  }, [loadHistory, surface]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedUid(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    return window.valeCompanion?.onAlert((name) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) return;
      const audio = new Audio(`${apiRoot}/v1/sounds/${encodeURIComponent(name)}.wav`);
      void audio.play().catch((error) => {
        setActionError(`Alert sound could not be played: ${errorMessage(error)}`);
      });
    });
  }, []);

  const inventory = surface === "storage" ? state?.storage : state?.bag;
  const selected = inventory?.find((item) => item.uid === selectedUid);
  useEffect(() => { setSelectedUid(undefined); }, [surface]);
  const filteredBag = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const items = (inventory ?? []).filter((item) => {
      // Both spellings are searchable: "Attack Speed" as displayed, "AtkSpd" as written in rules.
      const searchable = [item.name, item.type, item.itemId, ...item.lines.flatMap((line) => [line.stat, statLabel(line.stat)]), item.match?.rule, item.match?.tag]
        .filter((part): part is string => Boolean(part))
        .join(" ").toLocaleLowerCase();
      return (!matchesOnly || item.match !== null) && (!needle || searchable.includes(needle));
    });
    return order === "value" ? items.sort((left, right) => (right.value?.low ?? -1) - (left.value?.low ?? -1)) : items;
  }, [matchesOnly, order, query, inventory]);

  const invoke = async (label: string, request: () => Promise<Response>) => {
    setBusy(label);
    setActionError(undefined);
    try {
      const response = await request();
      if (!response.ok) throw new Error(await responseError(response));
      await refreshState();
    } catch (error) {
      setActionError(`${label}: ${errorMessage(error)}`);
    } finally {
      setBusy(undefined);
    }
  };


  const saveFilter = () => invoke("Filter was not saved", async () => {
    const response = await fetch(`${apiRoot}/v1/filter`, {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: filterText,
    });
    if (response.ok) setFilterDirty(false);
    return response;
  });

  const profile = (command: ProfileCommand) => invoke("Profile change failed", async () => {
    const response = await fetch(`${apiRoot}/v1/profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    if (response.ok && command.action !== "activate") setProfileName("");
    return response;
  });

  const clearHistory = () => invoke("History could not be cleared", async () => {
    const response = await fetch(`${apiRoot}/v1/history`, { method: "DELETE" });
    if (response.ok) setHistory([]);
    return response;
  });


  const lineNumbers = filterText.split("\n");

  return (
    <div class="loot-module">
      <header class="module-toolbar">
        <div>
          <div class="eyebrow">ValeLoot · local inventory intelligence</div>
          <strong>Loot filter</strong>
        </div>
        <nav class="module-tabs" aria-label="Loot workspace sections">
          <NavButton current={surface} value="filters" label="Rules" detail={state ? String(state.filter.errors.length) : ""} onSelect={setSurface} />
          <NavButton current={surface} value="bag" label="Bag" detail={String(state?.bag.length ?? 0)} onSelect={setSurface} />
          <NavButton current={surface} value="storage" label="Storage" detail={state?.storageGeneratedAt ? String(state.storage.length) : ""} onSelect={setSurface} />
          <NavButton current={surface} value="history" label="History" detail={String(history.length || state?.history.length || 0)} onSelect={setSurface} />
        </nav>
        <div class="module-status" title={state?.detail ?? "Connecting to local collector"}>
          <span class={`state-light ${state?.phase ?? "offline"}`} aria-hidden="true" />
          <span>{state?.phase === "capturing" ? "Live" : state?.phase === "waiting-for-game" ? "Waiting" : state ? "Paused" : "Connecting"}</span>
        </div>
      </header>
      <main class="loot-workspace">
        {actionError && <div class="notice error" role="alert"><span>{actionError}</span><button type="button" onClick={() => setActionError(undefined)} aria-label="Dismiss error">×</button></div>}
        {state?.warning && <div class="notice warning" role="status">{state.warning}</div>}
        {(surface === "bag" || surface === "storage") && <BagSurface grouping={grouping} storage={surface === "storage"} state={state} error={connectionError} query={query} matchesOnly={matchesOnly} items={filteredBag} selected={selected} busy={busy} onQuery={setQuery} onMatchesOnly={setMatchesOnly} order={order} onOrder={setOrder} onSelect={setSelectedUid} onRetry={() => void refreshState()} />}
        {surface === "filters" && <FiltersSurface grouping={grouping} state={state} text={filterText} dirty={filterDirty} scroll={editorScroll} lineNumbers={lineNumbers} profileName={profileName} selected={selected} busy={busy} onText={(value) => { setFilterText(value); setFilterDirty(true); }} onScroll={setEditorScroll} onSave={() => void saveFilter()} onProfileName={setProfileName} onProfile={profile} onSelect={setSelectedUid} />}
        {surface === "history" && <HistorySurface history={history} loading={!state && !connectionError} busy={busy} onClear={() => void clearHistory()} onReload={() => void loadHistory()} />}
        {surface !== "history" && selected && <ItemInspector item={selected} onClose={() => setSelectedUid(undefined)} onFindInMarket={onFindInMarket} />}
      </main>
    </div>
  );
}

function NavButton({ current, value, label, detail, onSelect }: { current: Surface; value: Surface; label: string; detail: string; onSelect(value: Surface): void }) {
  return <button class={`module-tab ${current === value ? "active" : ""}`} type="button" aria-current={current === value ? "page" : undefined} onClick={() => onSelect(value)}><span>{label}</span>{detail && <small>{detail}</small>}</button>;
}

function BagSurface({ grouping, storage = false, state, error, query, matchesOnly, items, selected, busy, onQuery, onMatchesOnly, order, onOrder, onSelect, onRetry }: {
  grouping: InventoryGrouping; storage?: boolean; state: DesktopState | undefined; error: string | undefined; query: string; matchesOnly: boolean; items: LootItemView[]; selected: LootItemView | undefined; busy: string | undefined; onQuery(value: string): void; onMatchesOnly(value: boolean): void; order: BagOrder; onOrder(value: BagOrder): void; onSelect(uid: string): void; onRetry(): void;
}) {
  const inventory = (storage ? state?.storage : state?.bag) ?? [];
  const generatedAt = storage ? state?.storageGeneratedAt : state?.bagGeneratedAt;
  const label = storage ? "storage" : "bag";
  const coverage = storage ? (generatedAt ? "Last observed storage; open storage in-game to refresh" : "Storage has not been observed this session") : state?.bagCoverage;
  const heading = storage ? "Storage" : state?.phase === "capturing" ? "Live bag" : "Bag ledger";
  const bagTotal = inventory.reduce((sum, item) => sum + (item.value?.low ?? 0), 0);
  const prices = state?.marketPrices.generatedAt
    ? <span class="bag-total" title={state.marketPrices.warning ?? state.marketPrices.cacheWarning ?? `${state.marketPrices.listings.toLocaleString()} ValeMarket listings, asking prices`}>{label}{" \u2248 "}{shortMoney(bagTotal)}{storage ? " (priced items)" : ""}{" \u00b7 "}prices {relativeTime(state.marketPrices.generatedAt)}{state.marketPrices.warning ? " (stale)" : ""}</span>
    : undefined;
  return <>
    <SurfaceHeader eyebrow="Inventory · passive observation" title={heading} freshness={generatedAt ? `Last observed ${relativeTime(generatedAt)}` : coverage ?? "Local collector"} live={!storage && state?.phase === "capturing"}>{prices}</SurfaceHeader>
    <div class="ledger-tools">
      <label class="search-field"><span class="visually-hidden">Search {label}</span><span aria-hidden="true">⌕</span><input type="search" value={query} placeholder="Search item, trait, rule, or tag" onInput={(event) => onQuery(event.currentTarget.value)} />{query && <button type="button" onClick={() => onQuery("")} aria-label={`Clear ${label} search`}>×</button>}</label>
      <div class="segmented order" aria-label={`${label} order`}><button class={order === "name" ? "selected" : ""} type="button" aria-pressed={order === "name"} onClick={() => onOrder("name")}>Name</button><button class={order === "value" ? "selected" : ""} type="button" aria-pressed={order === "value"} onClick={() => onOrder("value")}>Value</button></div>
      <div class="segmented" aria-label={`${label} scope`}><button class={!matchesOnly ? "selected" : ""} type="button" aria-pressed={!matchesOnly} onClick={() => onMatchesOnly(false)}>All <span>{inventory.length}</span></button><button class={matchesOnly ? "selected" : ""} type="button" aria-pressed={matchesOnly} onClick={() => onMatchesOnly(true)}>Matches <span>{inventory.filter((item) => item.match).length ?? 0}</span></button></div>
      <GroupingControl grouping={grouping} />
      <span class="coverage">{coverage ?? "Waiting for a local snapshot"}</span>
    </div>
    <section class="ledger" aria-label={`Observed ${label}`} aria-live="polite">
      <div class="ledger-head"><span>Item</span><span>Notable rolls</span><span>Rule</span><span>Rolls</span></div>
      {error && !state ? <Empty title="Collector unavailable" detail={`ValeLoot could not reach its local service. ${error}`} action="Reconnect" onAction={onRetry} />
        : !state ? <Empty title="Connecting to collector" detail="Waiting for the local capture service to report its inventory state." />
        : storage && !generatedAt ? <Empty title="Waiting for storage" detail="Open personal storage in the game. If no contents appear, move an item between your bag and storage to send a complete update. Capture must be enabled." />
        : storage && inventory.length === 0 ? <Empty title="Storage is empty" detail="The last complete storage snapshot contained no items." />
        : !storage && state.phase === "capture-unavailable" ? <Empty title={`${state.capture.backend} is needed to observe the bag`} detail={`Open Settings to review the ${state.capture.backend} status, then install or repair the capture backend before restarting capture.`} />
        : !storage && state.phase === "disabled" ? <Empty title="Capture is paused" detail="Enable passive capture in Settings to watch the next bag snapshot." />
        : inventory.length === 0 ? <Empty title="Waiting for the first bag snapshot" detail={state.phase === "waiting-for-game" ? "Launch Spirit Vale, enter a character, then switch maps once to trigger a complete inventory snapshot." : "Switch maps once to trigger a complete inventory snapshot. Changing inventory can also make the game send one."} />
        : items.length === 0 ? <Empty title="No items match this view" detail={matchesOnly ? "No current item matches your active filter. Switch to All to inspect these items." : "Try a shorter search term or clear the search."} action={matchesOnly && !query ? "Show all" : "Clear search"} onAction={() => { if (matchesOnly && !query) onMatchesOnly(false); else onQuery(""); }} />
        : <InventoryGrid items={items} grouping={grouping} selected={selected} onSelect={onSelect} searching={Boolean(query.trim()) || matchesOnly} />}
    </section>
    {busy && <div class="busy-note" role="status">{busy}</div>}
  </>;
}

function SurfaceHeader({ eyebrow, title, freshness, live = false, children }: { eyebrow: string; title: string; freshness: string; live?: boolean; children?: JSX.Element | undefined }) {
  return <header class="surface-header"><div><div class="eyebrow">{eyebrow}</div><h1>{title}</h1></div><div class="header-detail"><span class={`capture-pulse ${live ? "live" : ""}`} aria-hidden="true" /><span>{freshness}</span>{children}</div></header>;
}

function GroupingControl({ grouping }: { grouping: InventoryGrouping }) {
  return <label class="inventory-group-control">Group <select aria-label="Group inventory" value={grouping.enabled ? "category" : "none"} onChange={(event) => grouping.setEnabled(event.currentTarget.value === "category")}><option value="none">None</option><option value="category">Category</option></select></label>;
}

function InventoryGrid({ items, grouping, selected, onSelect, preview = false, searching = false }: {
  items: LootItemView[]; grouping: InventoryGrouping; selected: LootItemView | undefined; onSelect(uid: string): void; preview?: boolean; searching?: boolean;
}) {
  const renderItem = (item: LootItemView) => <ItemRow key={item.uid} item={item} selected={selected?.uid === item.uid} onSelect={onSelect} />;
  return <div class={preview ? "preview-grid" : "ledger-body"}>{!grouping.enabled ? items.map(renderItem) : INVENTORY_CATEGORIES.flatMap(([kind, label]) => {
    const members = items.filter((item) => item.kind === kind);
    if (!members.length) return [];
    const priced = members.filter((item) => item.value !== undefined);
    const total = priced.reduce((sum, item) => sum + item.value!.low, 0);
    // Searching temporarily opens sections so remembered collapses cannot hide results.
    const collapsed = !searching && grouping.collapsed.includes(kind);
    return [
      <button key={`category-${kind}`} class="inventory-category" type="button" aria-expanded={!collapsed} disabled={searching} onClick={() => grouping.toggle(kind)}>
        <span class="category-chevron" aria-hidden="true">{collapsed ? ">" : "v"}</span><strong>{label}</strong><span class="category-count">{members.length} {members.length === 1 ? "item" : "items"}</span>
        {priced.length > 0 && <span class="category-value" title={`${exactMoney(total)} estimated total for ${priced.length} of ${members.length} displayed items; includes stack quantities`}>{"\u2248 "}{shortMoney(total)}{priced.length < members.length ? " priced" : ""}</span>}
      </button>,
      ...(collapsed ? [] : members.map(renderItem)),
    ];
  })}</div>;
}

function ItemRow({ item, selected, onSelect }: { item: LootItemView; selected: boolean; onSelect(uid: string): void }) {
  const name = `${item.refine > 0 ? `+${item.refine} ` : ""}${item.name || item.itemId}`;
  const approx = item.value !== undefined && approximate(item.value);
  const bestLines = item.lines.filter((line) => line.over || line.rollPct >= 90).slice(0, 2);
  const style = item.match ? { "--rule-color": item.match.color } as JSX.CSSProperties : undefined;
  const treatment = item.match ? `matched highlight-${item.match.highlight} background-${item.match.background} ${item.match.border ? "" : "border-off"}` : "";
  return <button class={`item-row ${selected ? "selected" : ""} ${treatment}`} style={style} title={name} aria-pressed={selected} type="button" onClick={() => onSelect(item.uid)}>
    <span class="item-cell">{item.icon ? <img class="item-icon" src={iconUrl(item.icon)} alt="" loading="lazy" decoding="async" /> : <span class={`item-sigil ${item.kind}`}>{item.kind.charAt(0).toUpperCase()}</span>}<span><strong>{name}</strong>{item.count > 1 && <small class="item-quantity">{`\u00d7${item.count}`}</small>}</span></span>
    <span class="roll-summary">{bestLines.length ? bestLines.map((line) => <span key={line.stat} title={line.stat}>{statLabel(line.stat)} <b>{formatPct(line.rollPct)}</b></span>) : <em>{item.kind === "card" ? `${item.count} owned` : item.hasChaos ? "Chaos item" : "No high roll"}</em>}</span>
    <span class="rule-cell">{item.match ? <><i /><span>{item.match.tag || item.match.rule}</span></> : <em>�</em>}</span>
    <span class="roll-count">{item.topRolls ? `${item.topRolls} top ` : ""}{item.highRolls ? `${item.highRolls} high` : ""}{item.value ? <small class={`value ${approx ? "approx" : ""}`} title={valueDetail(item.value, item.count)}>{approx ? "~" : ""}{shortMoney(item.value.tier === "unit" ? item.value.low / Math.max(1, item.count) : item.value.low)}{item.value.tier === "unit" ? " each" : ""}</small> : <small>{item.avgRollPct === null ? "�" : formatPct(item.avgRollPct)}</small>}</span>
  </button>;
}

function ItemInspector({ item, onClose, onFindInMarket }: { item: LootItemView; onClose(): void; onFindInMarket(item: LootItemView): void }) {
  const approx = item.value !== undefined && approximate(item.value);
  return <aside class="inspector" aria-label="Selected item" style={item.match ? { "--rule-color": item.match.color } as JSX.CSSProperties : undefined}>
    <header>{item.icon && <img class="inspector-icon" src={iconUrl(item.icon)} alt="" />}<div><div class="eyebrow">{item.kind} · {item.itemId}</div><h2>{item.name || item.itemId}</h2><p>{item.type}{item.refine > 0 ? ` · Refine +${item.refine}` : ""}</p></div><button type="button" class="close-button" onClick={onClose} aria-label="Close item inspector">×</button></header>
    <section class="inspector-summary"><div><small>Average roll</small><strong>{item.avgRollPct === null ? "—" : formatPct(item.avgRollPct)}</strong></div><div><small>High rolls</small><strong>{item.highRolls}</strong></div><div><small>Chaos</small><strong>{item.hasChaos ? "Yes" : "No"}</strong></div></section>
    <section class="inspector-section"><div class="section-kicker">Observed stats</div><dl class="stat-list">{item.lines.length ? item.lines.map((line) => <div key={`${line.stat}:${line.printed ?? ""}`} class={line.over ? "over" : ""}><dt title={`${line.stat} in rules`}>{statLabel(line.stat)}{line.isChaos && <span> Chaos</span>}</dt><dd>{line.printed === null ? "—" : line.printed}<b>{formatPct(line.rollPct)}</b></dd></div>) : <p class="muted">No stat lines were decoded for this item.</p>}</dl></section>
    <section class="inspector-section"><div class="section-kicker">Filter result</div>{item.match ? <div class="match-detail"><span class="match-swatch" /><strong>{item.match.rule}</strong><p><b>{item.match.tag || "Untagged"}</b> · {item.match.highlight} {item.match.background}{item.match.border ? " border" : ""}{item.match.sound ? ` · ${item.match.sound} sound` : " · no sound"}</p></div> : <p class="muted">This item does not match an active rule.</p>}</section>
    <section class="inspector-section"><div class="section-kicker">Market value</div>{item.value
      ? <div class="market-value"><strong class={approx ? "approx" : ""}>{approx ? "~" : ""}{item.value.tier === "unit" ? `${shortMoney(item.value.low)} stack value` : valueRange(item.value)}</strong><p>{valueDetail(item.value, item.count)}</p></div>
      : <p class="muted">{["material", "consumable", "cosmetic"].includes(item.kind) ? "Market estimates are not available for this item category." : "Nothing of this item is listed on ValeMarket right now."}</p>}</section>
    <section class="inspector-section item-meta"><div><span>UID</span><code>{item.uid}</code></div><div><span>Favorite</span><b>{item.favorite ? "Yes" : "No"}</b></div></section>
    <section class="inspector-section inspector-actions"><button class="quiet-action" type="button" onClick={() => onFindInMarket(item)}>Find in market</button><small>Opens ValeMarket on this item, filtered to rolls at least as good as yours.</small></section>
  </aside>;
}

function FiltersSurface({ grouping, state, text, dirty, scroll, lineNumbers, profileName, selected, busy, onText, onScroll, onSave, onProfileName, onProfile, onSelect }: {
  grouping: InventoryGrouping;   state: DesktopState | undefined; text: string; dirty: boolean; scroll: number; lineNumbers: string[]; profileName: string; selected: LootItemView | undefined; busy: string | undefined; onText(value: string): void; onScroll(value: number): void; onSave(): void; onProfileName(value: string): void; onProfile(command: ProfileCommand): void; onSelect(uid: string): void;
}) {
  const active = state?.profiles.find((profile) => profile.active);
  const activeName = active?.name ?? "";
  const validName = profileName.trim();
  const matched = state?.bag.filter((item) => item.match).length ?? 0;
  const ruleCount = state?.filter.ruleCount ?? 0;
  return <>
    <SurfaceHeader eyebrow="ValeLoot · filter" title="Text" freshness={state ? `${ruleCount} active rule${ruleCount === 1 ? "" : "s"} · ${state.filter.errors.length ? `${state.filter.errors.length} parse issue${state.filter.errors.length === 1 ? "" : "s"}` : `${state.profiles.length} profile${state.profiles.length === 1 ? "" : "s"}`} · ${state.bag.length} items` : "Waiting for filter state"} />
    <div class="filter-layout">
      <section class="rule-editor-section" aria-labelledby="rule-text-title">
        <div class="section-heading"><div><div class="section-kicker">Rules · text</div><h2 id="rule-text-title">{active?.name ?? "Default rules"}{dirty && <span class="dirty-mark">Unsaved</span>}</h2></div><button class="primary-action" type="button" disabled={!state || !dirty || busy !== undefined} onClick={onSave}>{busy === "Filter was not saved" ? "Saving…" : "Save to the game"}</button></div>
        <div class="editor-frame"><div class="line-numbers" aria-hidden="true" style={{ transform: `translateY(-${scroll}px)` }}>{lineNumbers.map((_, index) => <span key={index}>{index + 1}</span>)}</div><textarea aria-label="Filter rule text" spellcheck={false} value={text} onInput={(event) => onText(event.currentTarget.value)} onScroll={(event) => onScroll(event.currentTarget.scrollTop)} /></div>
        <p class="editor-note">{state && ruleCount === 0 ? "No rules are active. Roll percentages are item data and do not paint or match an item." : "Every active rule is shown above. Save to parse the text and repaint the observed bag."}</p>
      </section>
      <section class="filter-bag-preview" aria-label="Bag as painted by the filter">
        <div class="preview-head"><div class="section-kicker">{ruleCount === 0 ? "Inventory preview · no rules active" : "Your bag, as the filter paints it"}</div><div class="preview-tally"><span><b>{matched}</b> rule match{matched === 1 ? "" : "es"}</span><span><b>{Math.max(0, (state?.bag.length ?? 0) - matched)}</b> unmatched</span><span><b>{state?.bag.length ?? 0}</b> seen this session</span></div></div>
        <div class="preview-grouping"><GroupingControl grouping={grouping} /></div>
        {!state || state.bag.length === 0
          ? <Empty title="Waiting for the bag" detail="Enter a character, then switch maps once to trigger the first complete inventory snapshot. That snapshot becomes the silent baseline." />
          : <InventoryGrid items={state.bag} grouping={grouping} selected={selected} onSelect={onSelect} preview />}
      </section>
      <aside class="filter-side">
        <section class="side-section"><div class="section-kicker">High-roll threshold</div><output class="threshold-value">{state ? `${state.filter.threshold}%` : "—"}</output><p>Defines the HighRolls item metric. It never highlights an item without a matching Show rule.</p></section>
        <section class="side-section parse-section" aria-live="polite"><div class="section-kicker">Parser</div>{!state ? <p>Waiting for the local filter state.</p> : state.filter.errors.length ? <ul class="parse-errors">{state.filter.errors.map((error) => <li key={`${error.line}:${error.message}`}><b>Line {error.line}</b><code>{error.text}</code><span>{error.message}</span></li>)}</ul> : ruleCount === 0 ? <p class="parse-ok">No rules are active. The preview remains unpainted.</p> : <p class="parse-ok">{ruleCount} active rule{ruleCount === 1 ? "" : "s"}. Every applied rule is visible in the editor.</p>}</section>
        <section class="side-section"><div class="section-kicker">Profiles</div><div class="profile-list">{state?.profiles.map((entry) => <button key={entry.name} type="button" class={entry.active ? "active-profile" : ""} aria-pressed={entry.active} disabled={busy !== undefined || entry.active || dirty} title={dirty && !entry.active ? "Save or discard the current edits before switching profiles" : undefined} onClick={() => onProfile({ action: "activate", name: entry.name })}><span>{entry.name}</span>{entry.active && <small>Active</small>}</button>)}</div><label class="profile-field"><span>New profile name</span><input value={profileName} placeholder="Profile name" onInput={(event) => onProfileName(event.currentTarget.value)} /></label><div class="profile-actions"><button type="button" disabled={!validName || busy !== undefined} onClick={() => onProfile({ action: "create", name: validName, text })}>Create</button><button type="button" disabled={!validName || !activeName || busy !== undefined} onClick={() => onProfile({ action: "duplicate", name: validName, source: activeName })}>Duplicate</button><button type="button" disabled={!validName || !activeName || busy !== undefined} onClick={() => onProfile({ action: "rename", name: validName, source: activeName })}>Rename</button></div></section>
      </aside>
    </div>
  </>;
}

function HistorySurface({ history, loading, busy, onClear, onReload }: { history: AlertHistoryView[]; loading: boolean; busy: string | undefined; onClear(): void; onReload(): void }) {
  return <>
    <SurfaceHeader eyebrow="Alerts · local session log" title="History" freshness={`${history.length} recorded alert${history.length === 1 ? "" : "s"}`}><button class="quiet-action" type="button" onClick={onReload}>Reload</button></SurfaceHeader>
    <section class="history-ledger" aria-label="Local alert history"><div class="history-head"><span>When</span><span>Item</span><span>Rule</span><span>Sound outcome</span></div>{loading ? <Empty title="Loading local alert history" detail="Reading the current local session record." /> : history.length === 0 ? <Empty title="No alerts recorded" detail="Matched items appear here after a complete bag snapshot adds their UID. Initial snapshots stay silent." /> : <div class="history-body">{history.map((entry) => <article class="history-row" key={entry.sequence}><time dateTime={entry.at}>{relativeTime(entry.at)}</time><div><strong>{entry.name}</strong><small>{entry.type} · {entry.uid}</small></div><div><b>{entry.tag || entry.rule}</b><small>{entry.note}</small></div><div class={`sound-outcome ${entry.soundPlayed ? "played" : ""}`}><strong>{entry.soundPlayed ? `${entry.sound ?? "Alert"} played` : entry.soundWinner ? "Sound suppressed" : "No sound"}</strong><small>{entry.soundWinner ? "Winning matched rule" : "Non-winning match"}</small></div></article>)}</div>}</section>
    <footer class="surface-footer"><span>History is kept for this app session and can be cleared at any time.</span><button class="danger-action" type="button" disabled={history.length === 0 || busy !== undefined} onClick={onClear}>{busy === "History could not be cleared" ? "Clearing…" : "Clear history"}</button></footer>
  </>;
}


function Empty({ title, detail, action, onAction }: { title: string; detail: string; action?: string; onAction?: () => void }) {
  return <div class="empty-state"><span class="empty-rune" aria-hidden="true">◇</span><h2>{title}</h2><p>{detail}</p>{action && onAction && <button type="button" onClick={onAction}>{action}</button>}</div>;
}


function iconUrl(name: string): string { return `${apiRoot}/v1/icons/${encodeURIComponent(name)}`; }
function formatPct(value: number): string { return `${Math.round(value)}%`; }
function valueRange(value: MarketValueView): string {
  return value.listings >= 3 && value.median > value.low ? `${exactMoney(value.low)} – ${exactMoney(value.median)}` : exactMoney(value.low);
}
function approximate(value: MarketValueView): boolean { return value.tier === "same-lines" || value.tier === "other-lines"; }
function valueDetail(value: MarketValueView, count: number): string {
  const listings = `${value.listings} listing${value.listings === 1 ? "" : "s"}`;
  switch (value.tier) {
    case "comparable": return `Asks for rolls at least as good as yours, cheapest to median · ${listings}`;
    case "same-lines": return `Asks with the same stat lines, values differ · ${listings}`;
    case "other-lines": return `Asks for this item, stat lines differ · ${listings}`;
    case "unit": return `${exactMoney(value.low / Math.max(1, count))} each \u00d7 ${Math.max(1, count)} = ${exactMoney(value.low)} stack value. Based on P25 asking price; median ${exactMoney(value.median / Math.max(1, count))} each. ${listings}`;
  }
}
function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
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
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

