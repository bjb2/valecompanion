# Market sync deployment — 2026-09-05

Production Worker: `valemarket-api` / `market-api.spiritvalers.com`.

- Deployed at 19:01 UTC (14:01 America/Chicago).
- Active version (ten-minute update, 19:28 UTC): `e0152c3c-692b-467e-8980-f8cc4c99ae02`.
- Immediate rollback target: `5e0452ec-de1a-4f67-bea6-77c304da1ed1`.
- Previous version / rollback target: `f2b24d3d-4ab8-4873-ada8-03f35198d838`.
- Source: the sibling `valemarket/server` directory.
- No database migrations, resource replacements, or desktop release.

The owner explicitly chose production deployment with rollback readiness instead
of staging. Local validation before deployment: 33 API tests, typechecking, and
Wrangler dry-run build; companion validation: 99 tests, typechecking, and build.

## Initial production checks

- `/health`: 200, protocol version 2.
- `/v2/markets/global/snapshot`: 200; 12,092 listings in the 19:00:16 UTC snapshot.
- Snapshot request with its ETag in `If-None-Match`: 304.
- `/v2/markets/global/stat-fingerprints`: 200.
- Deployment listing confirms the new version is active.

The 19:15:02 UTC publication added revision
`35c8428e-5dd1-44c0-951e-435b8951210b`. The ten-minute update was deployed
at 19:28 UTC and the 19:30:55 UTC publication produced revision
`1719cf41-fdcc-47bd-9bc2-cedbfc4d2042` with 14,536 listings.

The rebuilt local test client fetched that revision, persisted it, and a manual
refresh succeeded with no market warning. A live Bun check uncovered that
`redirect: "error"` rejects HTTP 304 in the installed runtime; the client now uses
`manual`, accepts 304, and continues rejecting actual redirects. A real HTTP
regression test covers both cases. Current validation: 102 companion tests,
33 API tests, both typechecks, Worker dry run, and desktop build.

Public snapshot/change responses now require revalidation; revision-keyed Cache
API entries retain a one-day TTL. Production checks confirmed the public domain
returns the new headers and unchanged revisions return empty 304 responses.
The configured publication schedule is every ten minutes, retaining twelve
transitions. The old cron string remains accepted during schedule propagation.

## Rollback

Run from the sibling `valemarket/server` directory:

```powershell
node node_modules/wrangler/bin/wrangler.js rollback 5e0452ec-de1a-4f67-bea6-77c304da1ed1 --yes --message "Revert ten-minute sync update"
```

Then check health, full snapshots, and fingerprints again. Rollback restores
Worker code, not R2 object contents. The full snapshot and manifest retain the
fields required by the previous Worker; the added metadata is backward compatible.
Preserve the published snapshot objects. Do not delete or reset the bucket as part
of a code rollback.

To restore the previous cadence too, set the configured publication cron back to
`*/15 * * * *` and deploy; a version rollback does not restore trigger settings.
