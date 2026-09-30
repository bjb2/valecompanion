# Releasing Vale Companion

The release workflow builds Windows x64 NSIS and portable executables on Windows, and Linux x64 AppImage, DEB and RPM on Ubuntu 22.04. Native builds are required because `src/build.ts` copies the host Bun executable into the collector bundle.

Before release validation, run `bun run sync:catalog` to regenerate the bundled catalog and artwork from the published SpiritValers exports. For a local copy of the deployed site, use `bun run sync:catalog ../spiritvale-deploy`. Review the reported category counts and added/removed/changed entries, then commit the generated data with the release. `assets/cosmetics.json` remains the supplemental cosmetic input; every runtime consumer uses the unified category-keyed `assets/catalog.json`. Builds never fetch mutable website data, so CI and corresponding-source builds reproduce the committed catalog.

The capture/items/market/logging libraries are local source workspaces under `packages/`, not registry downloads. Preserve this directory, its licenses, and `packages/upstream.json` in every source archive and clean build context. `bun run check` validates the canonical `packages/capture/data/rpc-map.json` as well as typechecking and tests. For a game patch, follow README's protocol-maintenance procedure: export a rollback copy, validate and review the candidate map, import it, rebuild, and verify login, bag updates, storage, market decoding, and mid-session attachment in game. A structurally valid map is not evidence of live compatibility. Do not enable community contribution for an unverified map or silently change item/roll data provenance when only the RPC map changed.

Run `bun run check`, then `bun run package:win` or `bun run package:linux` on the matching platform. `bun run src/verify-release.ts` checks that all expected artifacts exist and the generated updater metadata matches their version and SHA-512 checksums. Do not rename updater assets after building.

The workflow can be run manually to produce downloadable Actions artifacts without creating a release. Pushing a `v<package.json version>` tag builds both platforms and assembles a **draft** GitHub release only after both jobs pass. It refuses to modify an already published release. The workflow never publishes a draft automatically. Replace the template release notes and publish the complete draft when approved.

GitHub Releases hosts the update feed; no client token is embedded. Keep `latest.yml`, `latest-linux.yml`, all referenced artifacts and generated blockmaps together. Stable clients ignore prereleases and downgrades. Never overwrite an already published version; ship a higher patch version for fixes.

## Portable extraction lifetime

Each Windows portable launch must extract into its own temporary directory. With a shared per-build directory, a second launch can pass Electron's single-instance handoff, exit, and delete the first instance's icons, renderer files, and collector entrypoint while its loaded code keeps running. Bag data can continue updating even though every icon request returns 404.

The pinned electron-builder **26.15.3** implementation requires `portable.unpackDirName: true` to omit `UNPACK_DIR_NAME` and use NSIS's per-launch `$PLUGINSDIR`. Its option documentation incorrectly describes `false` for this behavior; follow the verified launcher behavior, not that description. Recheck this when upgrading electron-builder.

The packaged smoke now decodes game artwork from each catalog category in the actual renderer. For Windows portable builds, it also launches the same executable a second time, waits for single-instance handoff and launcher cleanup, and decodes fresh, cache-busted icon URLs again. Windows smoke uses isolated settings with capture, contribution, and sounds disabled. Run `bun run check` and packaged smoke **sequentially**: both deliberately reserve legacy port 47832 during their startup checks.

## Signing

Set repository secrets `WINDOWS_CSC_LINK` (electron-builder certificate input, such as a base64 PFX) and `WINDOWS_CSC_KEY_PASSWORD` to sign Windows builds. Without these the packages are unsigned and Windows can show an unknown-publisher warning. The updater verifies artifact hashes and uses electron-updater's Windows signature verification when a publisher is configured; hashes alone do not establish publisher identity. Do not disable certificate verification to bypass an update failure.

## Before the first updater-enabled release

Bump `package.json` to a new version before tagging and add version-specific notes under `docs/release-notes/`. Never overwrite an existing published version.

- Preview the local application and review Settings → Updates.
- Run the workflow manually and test its Windows installer and Linux packages. CI launches Windows portable and installed NSIS builds plus Linux AppImage and installed DEB. The Docker procedure below also tests RPM on Fedora.
- Test two packaged versions through a controlled update feed on Windows and Linux. Verify **Update and restart**, preserved settings/profiles/sounds/gold history, collector restart, AppImage path, and DEB/RPM capture capabilities after upgrade.
- Confirm checking alone never downloads, closing normally never installs, skipped versions stay quiet, disabled checks stay disabled, and failed/offline downloads allow retry.
- Test Linux authorization cancellation, unwritable AppImages, interrupted downloads, and normal exit during download.
- Verify the source offer and signing status in release notes, then publish the complete draft after approval.

The production updater is disabled in development and packaged smoke tests. Unit tests use a fake updater to exercise consent and failure paths without fetching or executing binaries. Full installed-version upgrade tests require two separately built versions and a test release feed; a launch smoke test does not substitute for them.

## Linux package tests with Docker

Run from the repository root with Docker Desktop's Linux engine (or Docker on Linux):

```sh
docker build -f assets/linux/test.Dockerfile -t valecompanion-linux-test:local .
docker run --rm --cap-add NET_ADMIN --security-opt seccomp=unconfined valecompanion-linux-test:local
docker build -f assets/linux/test-rpm.Dockerfile -t valecompanion-rpm-test:local .
docker run --rm --cap-add NET_ADMIN --security-opt seccomp=unconfined valecompanion-rpm-test:local
```

The Ubuntu 22.04 build creates all three x64 packages using a native Linux Bun runtime, runs the complete test suite, and verifies updater metadata and checksums. Artifact names use the platform's architecture spelling: `linux-x86_64.AppImage`, `linux-amd64.deb`, and `linux-x86_64.rpm`.

The Ubuntu smoke tests launch AppImage with configured dumpcap, install DEB with apt dependency resolution, launch DEB with direct libpcap, and reinstall DEB after removing its collector capabilities to verify the installer restores them. The Fedora 43 container performs equivalent checks for RPM. Both native-package tests also validate the desktop entry, executable registration, icon cache, and uninstall cleanup. The Linux executable is named `valecompanion`; the displayed application name remains `Vale Companion`.

Desktop launches run as a non-root user under Xvfb, with Electron's sandbox enabled. Capture must actually open and reach `waiting-for-game`; opening the window alone is insufficient. Every launch checks the collector API, renderer, and update settings bridge. Test settings disable community contribution and all update network checks. Linux capture permissions and seccomp relaxation apply only to the isolated test container; no host filesystem or host network is mounted.

Docker tests use AppImage's extract-and-run mode because they do not mount FUSE. They cannot validate the host's FUSE setup, real desktop integration, game/Proton attribution, or an interactive authorization prompt. Reinstallation is a package lifecycle check, not a substitute for a version-to-version in-app update test.

## Data and migration

Keep the app ID and product name stable. Normal installations continue using the existing `Vale Companion` application-data directory. Update preferences live in `updates.json` beside other application data. AppImage replacement preserves the portable data folder beside it.

Windows portable executables remain manual-update downloads. Users with `.valecompanion-portable` should either continue replacing the portable executable beside their existing `data` folder or, with the app closed, back up and copy that folder's contents to `%APPDATA%\Vale Companion` before launching the installed edition. Do not overwrite an existing destination without reconciling its data. Switching formats does not automatically move portable data.
