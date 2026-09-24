# Vale Companion

Vale Companion is the preferred desktop companion for **Spirit Vale**. It combines the ValeLoot live bag and rule-based alerts, live gold-session analytics, and the ValeMarket browser with passive community contribution in one application.

![Vale Companion interface](readme-img.png)
<img width="1894" height="1128" alt="image" src="https://github.com/user-attachments/assets/7c09b582-f769-4f82-bf6f-3411a5d8274b" />
<img width="430" height="219" alt="image" src="https://github.com/user-attachments/assets/15bc81ad-b6e8-4d02-9bd2-2132c0ba2bda" />


- No DLL injection, BepInEx, runtime patching, or game-file modification
- No gameplay automation, input simulation, buying, selling, dismantling, or item movement
- Passive, process-scoped network observation through Npcap on Windows or libpcap/dumpcap on Linux
- Local loot rules, profiles, alert history, and sounds
- Equipment, artifacts, gems, and stack-aware card tracking
- Live inventory updates for drops, dismantling, selling, and personal-storage transfers
- Live gross and net gold rates, spending, earning events, and recorded-kill efficiency
- Current market listings and seven-day observed asking-price summaries
- Optional market contribution; raw packets never leave the device

> **Download:** Get the latest build from [GitHub Releases](https://github.com/bjb2/valecompanion/releases/latest). Do not use GitHub's source-code ZIP as an application installer.

## Install

### Windows

Requirements:

- Windows 10 or 11, x64
- [Npcap](https://npcap.com/#download), installed separately
- Spirit Vale

1. Install Npcap using its default options.
2. Download `ValeCompanion-<version>-windows-x64-setup.exe` from the [latest release](https://github.com/bjb2/valecompanion/releases/latest).
3. Run the installer as your normal user. It installs for your account and supports in-app updates. The executable without `-setup` is an optional portable download with manual replacement.
4. Start Spirit Vale. Vale Companion automatically selects the active network adapter and begins observing the game connection.

Npcap is not bundled. Without it, Vale Companion still opens its market browser and settings, but cannot observe inventory or contribute market listings.

Windows builds are currently unsigned, so Windows may show an unknown-publisher warning. Verify that the download came from this repository and compare its SHA-256 checksum with the release's `SHA256SUMS.txt` file.

### Linux

Requirements:

- Linux x64
- Spirit Vale running natively or through Proton
- libpcap
- `dumpcap` from Wireshark, recommended, or `CAP_NET_RAW` and `CAP_NET_ADMIN` on the packaged collector runtime

Native `.deb` and `.rpm` packages configure the collector's packet-capture capabilities during installation. Run Vale Companion as your normal user; do not run the desktop application with `sudo`.

The AppImage is portable but cannot retain Linux file capabilities. AppImage users should configure their distribution's `dumpcap` package for non-root capture. On Debian or Ubuntu, install `libpcap0.8` and `wireshark-common`, allow non-superusers to capture when prompted, add your account to the `wireshark` group, then sign out and back in.

## Updates

Vale Companion checks for stable releases shortly after startup and every six hours. An in-app notice offers release details, **Later**, and **Update and restart**. Settings includes **Check for updates**, **Skip this version**, and a toggle to disable automatic checks.

Nothing downloads or installs until you choose **Update and restart**. That action downloads and verifies the update, saves the current session, stops capture, installs, and restarts. Closing the app normally never installs a pending update. Windows installer and Linux AppImage builds support this flow; DEB/RPM updates may request system authorization. AppImages must be in a writable folder. Windows portable builds link to GitHub Releases for manual replacement.

Older releases need one manual download to acquire this updater. Normal application data stays in place. If you use `.valecompanion-portable` on Windows, keep replacing the portable executable beside its `data` folder, or close the app, back up that folder, and copy its contents into `%APPDATA%\Vale Companion` before opening the installed edition. Reconcile any existing destination data first.

See [release maintenance](docs/releases.md) for the build workflow and upgrade validation.

## Loot workspace

Vale Companion maintains a live view of the character bag from authoritative server inventory updates. It tracks:

- Equipment and artifacts, including substats, roll percentages, chaos lines, refinement, and favorites
- Gems and refinement levels
- Cards and stack quantities
- Additions and removals caused by drops, sales, dismantling, and personal-storage transfers

Loot alerts run when a complete inventory update arrives, not on a town-entry timer. Fragmented updates are reassembled across UDP datagrams even when their fragments occupy different merged-envelope positions. Character-shaped updates are also checked when an otherwise unhandled RPC name comes from an outdated bundled map. The first observed inventory seeds the bag silently; subsequent matching additions alert once, and an unchanged map-entry snapshot does not repeat them.

A fresh installation includes a focused starter ruleset in [`docs/starter-ruleset.txt`](docs/starter-ruleset.txt). Rules are evaluated from top to bottom: **the first matching rule wins**. A `Show` rule paints the item and can alert; a `Hide` rule claims the item but draws nothing, plays nothing, and produces no loot row. An item that matches no rule remains unpainted and silent. Rules only change presentation and local alerts—they never act on an item.

Printed substat decoding uses the live **0.32.0 Early Access, Steam build 25433400** pool snapshot in [`assets/substat-pools.json`](assets/substat-pools.json): all nine roll pools and the resolved pool for 726 equipment definitions, including explicit item overrides. Market contributions use this same authoritative item-to-pool mapping so every decodable stat carries its printed value. Eyewear and Back use Headgear; Shield uses Chest; equipment without a special default or override uses Accessory. Scaling follows the client's single-precision arithmetic and rounds ties away from zero. Revalidate this snapshot when game roll pools change. After a decoder update, restart Companion and switch maps in game to capture a fresh inventory; reloading only the window does not restart the collector.

### Writing filters

A rule starts at the left margin with `Show "rule name"` or `Hide "rule name"`. Indent its directives. Ordinary directives in one rule are ANDed: an item must satisfy all of them. A parser error rejects the **entire block**, rather than quietly dropping the bad line and widening the match.

```text
Threshold 90

# Specific item, printed +3 STR, and a STR roll in the top 10%.
Show "Master Sword"
    Name      "Master Sword"
    Stat      Str >= 3
    Stat      Str >= 90%
    Tag       KEEP
    Color     #35e87a
    Highlight mark
    Sound     chime

# Each AnyOf is an OR group; separate groups and other lines still use AND.
Show "artifact primary plus vitality"
    Type Artifact
    RequireStat Vit >= 3
    AnyOf
        Stat Str >= 3
        Stat Int >= 3
        Stat Agi >= 3
    TopRolls >= 2

# Put a deliberate catch-all last. An empty Hide must be named exactly "everything".
Hide "everything"
```

#### Filter-wide lines

| Directive | Valid form and meaning |
| --- | --- |
| `Threshold` | `Threshold 1` through `Threshold 100`. Sets the shared raw-roll percentage cutoff used by every `HighRolls` condition; it does not affect `TopRolls`. |
| `AlwaysShow` / `AlwaysHide` | Accepted top-level comma-separated lists, for example `AlwaysShow "Spirit Ward", "Windborne Rune"`, but **not applied by Vale Companion**: the parser records overrides and no current runtime consumes them. Use `Name` in a `Show` or `Hide` block instead. |

#### Match directives

Use the comparison operators `=`, `>`, `>=`, `<`, and `<=`. Strict comparisons are genuinely exclusive. Counts and displayed roll percentages are integral; use whole numbers for them. For `Stat`, the `%` suffix changes the unit:

```text
Stat Agi >= 3       # the printed stat value: "+3 AGI"
Stat Agi >= 90%     # the line's roll quality: top 10% of its legal range
```

| Directive | Valid form | Match |
| --- | --- | --- |
| `Name` | `Name Kunai, "Master Sword"` | Case-insensitive substring match. A comma-separated list is ORed, so either name fragment matches. Quote names containing commas; unquoted multi-word fragments are also accepted. |
| `Type` | `Type Chest, Feet, Shield` | Exact item-type match; the comma-separated alternatives are ORed. `Artifact` is a category alias for Rune, Jewel, Scroll, and Relic; those subtype spellings remain available for narrower rules. |
| `Stat` | `Stat Agi >= 3` or `Stat Agi >= 90%` | Adds a candidate substat. Without a percent sign it compares the printed value; with `%` it compares that line's roll quality. Listed `Stat` lines require all matches by default. Stat names ignore case; friendly aliases such as `AttackSpeed`, `MagicDamage`, `MovementSpeed`, and `Multistrike` are accepted. |
| `AllStats` / `AnyStat` | no value | Make the listed `Stat` lines require all (the default) or at least one, respectively. Do not combine either with `StatMatches`. |
| `StatMatches` | `StatMatches >= 2` | Requires a whole-number count of matching listed `Stat` lines. It replaces `AllStats`/`AnyStat` aggregation and requires at least one `Stat` line in the block. Multiple bounds can define a range. |
| `RequireStat` | `RequireStat Vit >= 3` | A stat that must match independently of `StatMatches`, `AnyStat`, and `AllStats`. Multiple `RequireStat` lines all must match. |
| `AnyOf` | `AnyOf` followed by further-indented `Stat` lines | One or more alternatives: at least one child `Stat` must match. Each `AnyOf` group must match, so two groups express `(A OR B) AND (C OR D)`. |
| `AvgRollPct` | `AvgRollPct >= 85` | The item's average roll percentage, as the game compares its whole-percent average. `AvgRoll` is accepted as an alias. |
| `TopRolls` | `TopRolls >= 2` | Number of lines that print their legal maximum value. This is independent of `Threshold`. |
| `HighRolls` | `HighRolls >= 2` | Number of hidden raw rolls at or above `Threshold`. |
| `Refine` | `Refine >= 3` | Minimum refinement level. |
| `SharedStats` | `SharedStats >= 2` | Parsed as a minimum count of item stats also used by worn gear, but the current Companion supplies no worn-gear context, so a rule containing it cannot match. |
| `Chaos` / `NoChaos` | no value | Restrict to items with, or known not to have, a Chaos effect. |
| `OverRoll` / `NoOverRoll` | no value | Restrict to items with, or without, a line above its normal maximum. |
| `Favorite` / `NotFavorite` | no value | Restrict to items marked favourite in game, or not marked favourite. `Favourite` spellings are also accepted. |
| `Unknown` / `Known` | no value | Restrict to items absent from the catalog, or known to it. |
| `Verdict` | `Verdict upgrade, better-rolls` | Parsed upgrade-comparison result. Valid values are `upgrade`, `better-rolls`, `sidegrade`, and `worse`; the list is ORed. The current Companion supplies no comparison verdicts, so a rule containing it cannot match. |

#### Display directives for `Show`

| Directive | Valid form | Effect |
| --- | --- | --- |
| `Color` | `Color #35e87a` | Six-digit RGB colour for the tag, border, and optional background. (`Colour` is accepted.) |
| `Tag` | `Tag KEEP` | Short label, limited to 12 characters; the rule name is used when omitted. |
| `Highlight` | `Highlight dot`, `mark`, or `glow` | Quiet dot, keep mark, or animated/pulsing glow. `dot` is the default. |
| `Background` | `Background border`, `fill`, or `holo` | Border-only default, solid fill, or hue-rotating fill. |
| `Border` | `Border on` or `Border off` | Shows or removes the selection frame; it is on by default. |
| `Sound` | `Sound chime` | Plays once when a matching item arrives, never on every bag rescan. Built-ins are `blip`, `chime`, `ding`, `alert`, and `thud`. For a custom alert, drop a `.wav` file into the custom alert folder in Settings and use its plain filename, with or without `.wav`; names may contain letters, digits, `.`, `-`, or `_`. |

`Hide` accepts the same match directives but cannot use `Highlight`, a non-`border` `Background`, `Border off`, or `Sound`; it is deliberately silent. `Keep` remains an accepted spelling of `Show`, and `Mute` or `Dismantle` of `Hide`, but new filters should use `Show` and `Hide`. `Flash` remains an accepted compatibility spelling of `Highlight glow`; `Protect` is rejected.

Lines beginning with `#` are comments. A `#rrggbb` colour remains a value, and an inline comment after it is valid. Lists are comma-separated; double quotes preserve spaces and allow a rule name, tag, or list entry to be written as one value.

The in-app editor offers context-sensitive completions while typing unfinished names and keywords. Numeric values are suggested only when explicitly requested, and moving the caret does not open suggestions. Press **Ctrl+Space** to request completions; use **Arrow Up/Down** to choose, **Enter** or **Tab** to accept, and **Escape** to dismiss. Clicking a suggestion preserves editor focus and places the caret after the insertion. Accepting a completion only changes the unsaved editor text—select **Save to the game** to parse, persist, and apply the active profile.

Profiles are named saved filter texts. You can create, duplicate, rename, and activate them; profile names must begin with a letter or number and may then contain letters, numbers, spaces, underscores, and hyphens (up to 64 characters). The editor prevents switching profiles while edits are unsaved, so save or discard those edits first. Saving validates the filter, stores it in the active profile, and repaints the observed bag; an invalid filter is not saved.

### Alert volume and pickup overlay

**Settings → Loot sounds → Alert volume** controls built-in and custom sounds from 0–100% and is saved across restarts. Existing installations start at 100%. Setting 0% mutes audio without suppressing loot history or visual notifications.

**Settings → Pickup overlay → On-screen pickups** is enabled by default for a transparent, always-on-top desktop overlay. Matching pickups show their icon, name, newly acquired quantity, and rule color/tag. Equipment and artifacts also show decoded substat values, roll percentages, Chaos markers, and refinement. The overlay shows up to five recent pickups, keeping fewer when expanded cards need more room; cards fade after five seconds. Hidden/unmatched items, the initial inventory baseline, full character/map-load inventories, and silent storage transfers do not produce notifications. Subsequent pickup updates still notify normally.

Choose **Reposition**, drag the overlay's header, then choose **Done** or **Lock position**. Locked overlays pass clicks through to the game. Position and enabled state are saved locally; **Reset position** returns it to the primary display. Borderless/windowed gameplay is recommended: exclusive fullscreen and Linux window-manager policies may prevent a desktop overlay from appearing above the game.

The overlay starts enabled unless you previously turned it off; its saved on/off choice is respected. If the overlay renderer fails, **Reposition** recreates it without restarting the app.

## Gold analytics

The Gold workspace starts a local session from the first authoritative coin total sent by the game server. It separates positive and negative balance changes, then reports gross gold per hour and minute, net gold per hour, a rolling 15-minute pace, earning and spending events, and a one-hour five-minute-bucket chart. Large values use compact notation with the exact amount available on hover.

**Finish session** saves the run's yield, spend, rates, and kill efficiency in the previous-sessions ledger, then keeps the current balance as the next baseline. Finished sessions and the active session are stored locally and survive application restarts; the most recent 100 finished sessions are retained. Each saved session can be deleted independently, or the entire history can be cleared.

Gold per confirmed kill uses the cumulative kill count included in character snapshots, paired at each observed gold balance update. Kills received after the latest balance update remain visible as pending instead of distorting the ratio.

## Market workspace

The market browser loads the current public listing snapshot from [market.spiritvalers.com](https://market.spiritvalers.com/). Item inspectors show a rolling seven-day series of hourly observed asking-price quartiles. These are listing observations, not completed-sale history.

Market contribution is enabled on fresh installations and can be disabled under **Settings → Market contribution**. The contributor observes market result traffic already delivered to the game client, normalizes supported listing fields, suppresses duplicates, and uploads bounded batches to the public service.

Uploads require browsing market listings in the game; the companion does not query the game server itself. Accepted observations appear in the public listings API before the next ten-minute snapshot publication. A fresh but empty snapshot is different from a download error: inspect decoded-listing and upload activity as well as snapshot freshness. The capture, item, and market decoder packages must stay compatible with the current game's RPC map.

## Privacy and game boundary

Vale Companion is passive:

- It sends no gameplay RPCs or packets.
- It never clicks, types, moves, equips, buys, sells, dismantles, or picks up items.
- It does not inject code into Spirit Vale or modify the game installation.
- Loot inventory, gold analytics, filters, profiles, sounds, and alert history stay local.
- Raw captured packets are not persisted or uploaded.
- Market contribution sends normalized listing observations, not account credentials, character identity, seller identity, buyer identity, or raw packet payloads.

Capture can be disabled entirely, and market contribution has a separate toggle.

## Data and diagnostics

Settings and structured logs use the operating system's application-data directory. To keep data beside the executable or AppImage, place an empty `.valecompanion-portable` file beside it before launch.

Diagnostics cover application startup, capture selection, packet decoding, and contribution lifecycle events. They exclude raw packets, installation tokens, listing payloads, and player identity.

## Build from source

Prerequisites:

- Windows x64 or Linux x64
- [Bun](https://bun.sh/) 1.4 or newer
- Platform capture dependencies described above

```sh
git clone https://github.com/bjb2/valecompanion.git
cd valecompanion
bun install
bun run check
bun run dev
```

Useful commands:

```text
bun run dev           Build and launch a development window
bun run check         Type-check and run the complete test suite
bun run build         Prepare the Electron application
bun run package:win   Build Windows installer and portable executable; smoke-test portable
bun run package:linux Build Linux AppImage, deb, and rpm artifacts
```

## Project layout

```text
src/backend/       Capture lifecycle, local API, persistence, and market contribution
src/core/          Character decoding, inventory projection, loot rules, and gold analytics
src/electron/      Desktop shell and collector supervision
src/frontend/      Companion navigation, settings, loot, and gold workspaces
prototype/         Local market UI development server
test/              Decoder, capture, filter, and session contract tests
docs/              Starter ruleset and supporting assets
```

## License

Vale Companion is licensed under the GNU Affero General Public License, version 3 or later. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [SOURCE-OFFER.txt](SOURCE-OFFER.txt).

Spirit Vale is a third-party game. Vale Companion is an independent community project and is not endorsed by or affiliated with the game's developer or publisher.
