import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("market refreshes reuse fingerprints and conditionally revalidate on their own cadence", async () => {
  const html = readFileSync(new URL("../src/frontend/market.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("let fingerprintCache ="), html.indexOf("function publicVariant("));
  let clock = Date.parse("2026-09-05T12:00:00Z");
  let calls = 0;
  const body = { marketId: "global", modelVersion: 1, generatedAt: new Date(clock).toISOString(), items: [] };
  const fetchFingerprints = runInNewContext(`${source}\nfetchStatFingerprints`, {
    API: "https://market.test",
    Date: class extends Date { static override now() { return clock; } },
    fetch: async (_url: string, init: RequestInit) => {
      calls++;
      if (calls === 1) return Response.json(body, { headers: { etag: '"fingerprints"' } });
      expect(new Headers(init.headers).get("if-none-match")).toBe('"fingerprints"');
      if (calls === 2) return new Response(null, { status: 304 });
      return new Response("down", { status: 503 });
    },
  }) as () => Promise<unknown>;
  expect(await fetchFingerprints()).toEqual(body);
  clock += 15 * 60_000;
  expect(await fetchFingerprints()).toEqual(body);
  expect(calls).toBe(1);
  clock += 15 * 60_000;
  expect(await fetchFingerprints()).toEqual(body);
  expect(calls).toBe(2);
  clock += 15 * 60_000;
  await fetchFingerprints();
  expect(calls).toBe(2);
  clock += 15 * 60_000;
  expect(await fetchFingerprints()).toEqual(body);
  expect(calls).toBe(3);
  await fetchFingerprints();
  expect(calls).toBe(3);
});
