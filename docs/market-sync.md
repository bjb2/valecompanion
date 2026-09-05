# Incremental market sync (issue #6)

Status: implemented for local validation; not deployed or released. The matching
Worker changes are in the sibling `valemarket/server` source. That server directory
was already untracked in its parent repository; do not mistake a companion commit
for a published or versioned API deployment.

## Protocol

The initial `/v2/markets/global/snapshot` response remains backward compatible and
adds an opaque UUID `revision`. Clients without a revision keep using the full
endpoint with `If-None-Match` when an ETag is available. There is no capability probe.

A revision-aware client requests `/v2/markets/global/changes?since=<revision>`:

- `304`: unchanged; retain the snapshot and renew its freshness deadline.
- `200` with `deltas`: apply the ordered chain to a new listing map. Each delta has
  `fromRevision`, `revision`, and `operations`. An operation is either
  `{ "upsert": <complete listing> }` or `{ "remove": <listingKey> }`.
- `200` with `listings`: full recovery in the same request when the revision is no
  longer retained or the delta chain would be larger. Replace the local snapshot.
- Errors: retain the last usable data and respect the shared retry deadline,
  including longer `Retry-After` guidance. A malformed chain schedules a full
  recovery after the cooldown, rather than immediately issuing more requests.

The response envelope includes `marketId`, `revision`, `generatedAt`, and, for a
delta chain, `fromRevision`. Clients verify chain continuity, listing identities,
duplicate operations, limits, and final revision before replacing state. The raw
snapshot, revision, ETag, and freshness timestamp share one atomic cache file.
Disk-write failures retain usable memory state; a restart can resume from the
previous complete on-disk revision.

## Cloudflare work

The existing 15-minute publisher reads D1 once per publication, using listing-key
pagination, and stages bounded pages in R2. It streams a merge of the previous and
current pages into an immutable delta object. It does not materialize two complete
market snapshots in memory. All public field changes, including observation
timestamps, count as changes; a listing absent from the next publication becomes
an explicit removal, including expiry and eligibility changes.

The manifest is published only after its snapshot and delta objects exist, using
conditional R2 publication to prevent competing publishers from overwriting each
other. The current snapshot pages and eight delta transitions are retained; old
pages, superseded snapshots, and deltas beyond the window are deleted. Eight
transitions normally cover two hours, not a guaranteed wall-clock retention period.

Normal sync requests perform no D1 queries and no diff computation:

| Request | Worker / R2 work |
| --- | --- |
| Already current | Rate-limit check, one small R2 manifest read, empty 304 |
| Behind, cached chain | Manifest read, Cache API lookup, cached response |
| Behind, uncached chain | Manifest read, up to eight streamed R2 delta reads, Cache API population |
| Unknown/expired revision or oversized chain | Manifest read, then cached or streamed full snapshot response |
| No published artifact | 503 with Retry-After; generation stays on the scheduled path |

Cache keys include both the starting and ending revisions, so clients on the same
revision share responses. The Cache API is a cache, not the authoritative store;
R2 holds the published deltas. Every poll still invokes the Worker and reads the
manifest. Publication adds R2 comparison reads, delta writes, and bounded retained
storage in exchange for smaller client responses. Chains whose stored sizes plus
an envelope allowance reach the full snapshot size use the full response instead.

The companion has one snapshot coordinator for Loot and Market, a normal
15-minute freshness interval, and up to 30 seconds of timer jitter. In-flight
requests are shared. Fingerprints have an independent 30-minute cache/ETag check,
so the Market view's 15-minute refresh does not double fingerprint API calls.

## Validation and release gate

Local tests cover full/delta equivalence, missed revisions, removals and expiry,
replayed or incomplete chains, concurrent readers, restarts, persistence failure,
conditional refresh, old API compatibility, and retry guidance.

A synthetic test with 10,000 listings, 1% replacements and 1% removals measured
4,960,934 full-response bytes versus 59,090 delta-object bytes (98.8% smaller,
uncompressed; the outer chain envelope adds a small amount). This is a controlled
bandwidth example, not a measurement of production CPU, billing, or actual churn.

Before releasing:

1. Review and version the API changes alongside the companion change.
2. Validate an isolated staging deployment at representative listing counts and
   churn. Record Worker CPU, R2 operations, response bytes, cache hits/misses, and
   requests per client-hour as simulated client counts increase. Verify D1 reads
   occur during publication only. Do not load-test production for these numbers.
3. Exercise publication failures, missed polls, removals, and full recovery.
4. Deploy the backward-compatible API first and allow a scheduled publication.
   Verify old full-snapshot clients still work and new clients acquire revisions.
5. Release the companion only after validation. No version tag, release, or
   production deployment is part of this implementation change.

References: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
