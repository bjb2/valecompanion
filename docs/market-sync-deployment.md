# Market sync deployment — 2026-09-05

Production Worker: `valemarket-api` / `market-api.spiritvalers.com`.

- Deployed at 19:01 UTC (14:01 America/Chicago).
- Active version: `5e0452ec-de1a-4f67-bea6-77c304da1ed1`.
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

That snapshot was generated before deployment and has no revision yet. The first
successful new scheduled publication adds a revision; the following one creates
the first reusable delta. The normal schedule is every 15 minutes. Scheduled
publication and real delta delivery were not yet verified in these initial checks.
Do not interpret successful legacy endpoint checks as proof of the new publisher.

## Rollback

Run from the sibling `valemarket/server` directory:

```powershell
node node_modules/wrangler/bin/wrangler.js rollback f2b24d3d-4ab8-4873-ada8-03f35198d838 --yes --message "Revert incremental market sync"
```

Then check health, full snapshots, and fingerprints again. Rollback restores
Worker code, not R2 object contents. The full snapshot and manifest retain the
fields required by the previous Worker; the added metadata is backward compatible.
Preserve the published snapshot objects. Do not delete or reset the bucket as part
of a code rollback.
