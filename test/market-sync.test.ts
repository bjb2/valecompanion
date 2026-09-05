import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MarketSnapshot } from "../src/backend/market-snapshot.ts";
import { applySnapshotDelta } from "../src/backend/market-sync.ts";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const NOW = Date.parse("2026-09-05T12:00:00Z");
const MIN = 60_000;
const row = (key: string, price: number) => ({ listingKey: key.repeat(64), itemId: "Ghost", unitPrice: price, stats: [], expiresAt: null });
const initial = { marketId: "global", generatedAt: new Date(NOW).toISOString(), revision: A, listings: [row("a", 100), row("b", 200)] };
const delta = { marketId: "global", generatedAt: new Date(NOW + 30 * MIN).toISOString(), fromRevision: A, revision: C,
  deltas: [
    { fromRevision: A, revision: B, operations: [{ upsert: row("a", 150) }, { upsert: row("c", 300) }] },
    { fromRevision: B, revision: C, operations: [{ remove: "b".repeat(64) }] },
  ] };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function file() {
  const directory = await mkdtemp(path.join(tmpdir(), "vale-sync-"));
  directories.push(directory);
  return path.join(directory, "cache.json");
}

test("missed revisions converge to a full snapshot without mutating the base", () => {
  expect(applySnapshotDelta(initial, delta)).toEqual({ ...initial, revision: C, generatedAt: delta.generatedAt, listings: [row("a", 150), row("c", 300)] });
  expect(initial.listings).toEqual([row("a", 100), row("b", 200)]);
});

test("rejects replayed, out-of-order, incomplete, and ambiguous changes", () => {
  const current = applySnapshotDelta(initial, delta);
  expect(() => applySnapshotDelta(current, delta)).toThrow();
  expect(() => applySnapshotDelta(initial, { ...delta, deltas: [...delta.deltas].reverse() })).toThrow();
  expect(() => applySnapshotDelta(initial, { ...delta, deltas: delta.deltas.slice(0, 1) })).toThrow();
  expect(() => applySnapshotDelta(initial, { ...delta, deltas: [{ fromRevision: A, revision: C, operations: [{ upsert: row("a", 150) }, { remove: "a".repeat(64) }] }] })).toThrow();
  expect(initial.listings).toEqual([row("a", 100), row("b", 200)]);
});

test("downloads full once, persists deltas and revision together, and conditionally refreshes after restart", async () => {
  const cachePath = await file();
  let clock = NOW;
  const calls: Array<{ url: string; etag: string | null }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, etag: new Headers(init?.headers).get("if-none-match") });
    if (calls.length === 1) return Response.json(initial, { headers: { etag: '"a"' } });
    if (calls.length === 2) return Response.json(delta, { headers: { etag: '"c"' } });
    return new Response(null, { status: 304, headers: { etag: '"c"' } });
  };
  const snapshot = await MarketSnapshot.load({ cachePath, now: () => new Date(clock), fetch });
  await snapshot.body();
  clock += 30 * MIN;
  await Promise.all([snapshot.body(), snapshot.body()]);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.url).toEndWith("/snapshot");
  expect(calls[1]!.url).toEndWith(`/changes?since=${A}`);
  expect(calls[1]!.etag).toBe('"a"');
  const persisted = JSON.parse(await readFile(cachePath, "utf8"));
  expect(persisted.body).toEqual(applySnapshotDelta(initial, delta));
  expect(persisted.etag).toBe('"c"');
  const restored = await MarketSnapshot.load({ cachePath, now: () => new Date(clock), fetch });
  expect(await restored.body()).toEqual(persisted.body);
  expect(calls).toHaveLength(2);
  clock += 15 * MIN;
  expect(await restored.body()).toEqual(persisted.body);
  expect(calls[2]!.url).toEndWith(`/changes?since=${C}`);
  expect(calls[2]!.etag).toBe('"c"');
  await restored.body();
  expect(calls).toHaveLength(3);
});

test("interrupted delta retains the saved revision and recovers with a full snapshot after cooldown", async () => {
  const cachePath = await file();
  let clock = NOW;
  const calls: string[] = [];
  const snapshot = await MarketSnapshot.load({ cachePath, now: () => new Date(clock), fetch: async (url) => {
    calls.push(url);
    if (calls.length === 1) return Response.json(initial);
    if (calls.length === 2) return new Response('{"deltas":[');
    return Response.json(applySnapshotDelta(initial, delta));
  } });
  await snapshot.body();
  clock += 30 * MIN;
  expect(await snapshot.body()).toEqual(initial);
  expect(JSON.parse(await readFile(cachePath, "utf8")).body.revision).toBe(A);
  await snapshot.body();
  expect(calls).toHaveLength(2);
  clock += 2 * MIN;
  expect((await snapshot.body())!.revision).toBe(C);
  expect(calls[2]).toEndWith("/snapshot");
});

test("accepts same-request full fallback for expired revisions", async () => {
  const cachePath = await file();
  await writeFile(cachePath, JSON.stringify({ fetchedAt: new Date(NOW - 30 * MIN).toISOString(), body: initial }));
  let calls = 0;
  const snapshot = await MarketSnapshot.load({ cachePath, now: () => new Date(NOW), fetch: async () => {
    calls++;
    return Response.json(applySnapshotDelta(initial, delta));
  } });
  expect((await snapshot.body())!.revision).toBe(C);
  expect(calls).toBe(1);
});

test("failed persistence keeps a recoverable old cache while memory advances atomically", async () => {
  const cachePath = await file();
  let clock = NOW;
  const fetch = async (url: string) => Response.json(url.endsWith("/snapshot") ? initial : delta);
  const snapshot = await MarketSnapshot.load({ cachePath, now: () => new Date(clock), fetch });
  await snapshot.body();
  await rename(cachePath, `${cachePath}.saved`);
  await mkdir(cachePath);
  clock += 30 * MIN;
  expect((await snapshot.body())!.revision).toBe(C);
  expect(snapshot.view().warning).toBeUndefined();
  expect(snapshot.view().cacheWarning).toBeDefined();
  expect(JSON.parse(await readFile(`${cachePath}.saved`, "utf8")).body.revision).toBe(A);
  await rmdir(cachePath);
  await rename(`${cachePath}.saved`, cachePath);
  const restored = await MarketSnapshot.load({ cachePath, now: () => new Date(clock), fetch });
  expect(await restored.body()).toEqual(applySnapshotDelta(initial, delta));
});

test("legacy snapshots use ETags without probing an unsupported changes endpoint", async () => {
  const cachePath = await file();
  let clock = NOW;
  const urls: string[] = [];
  const { revision: _, ...legacy } = initial;
  const snapshot = await MarketSnapshot.load({ cachePath, now: () => new Date(clock), fetch: async (url, init) => {
    urls.push(url);
    if (urls.length === 1) return Response.json(legacy, { headers: { etag: '"legacy"' } });
    expect(new Headers(init?.headers).get("if-none-match")).toBe('"legacy"');
    return new Response(null, { status: 304 });
  } });
  await snapshot.body();
  clock += 15 * MIN;
  expect(await snapshot.body()).toEqual(legacy);
  expect(urls.every((url) => url.endsWith("/snapshot"))).toBe(true);
});

test("honors server retry guidance longer than the default cooldown", async () => {
  let clock = NOW;
  let calls = 0;
  const snapshot = await MarketSnapshot.load({ cachePath: await file(), now: () => new Date(clock), fetch: async () => {
    calls++;
    return new Response("limited", { status: 429, headers: { "retry-after": "600" } });
  } });
  await snapshot.body();
  clock += 2 * MIN;
  await snapshot.body();
  expect(calls).toBe(1);
  clock += 8 * MIN;
  await snapshot.body();
  expect(calls).toBe(2);
});
