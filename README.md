# DMX Hue 4 (hardware-validation beta)

A local Art-Net receiver for Raspberry Pi that translates Luminair DMX into Philips Hue API v2 commands, with optional Hue Entertainment v2 streaming.

**Luminair remains the editor for every color, scene, fade, and effect.** No Hue scenes are required. This rewrite is intended for testing before use during a service; automated tests do not replace a physical-light rehearsal.

## What's changed

- Failed writes remain pending and retry with backoff. Incoming DMX replaces obsolete pending targets.
- Fair individual-light scheduling, at most one outstanding control write, and no stale command backlog.
- Matching targets can use preselected Hue room/zone groups. Individual control resumes when values differ. Group commands are conservatively limited to one per second; individual writes are spaced at least 120 ms apart.
- Local mDNS rediscovery by bridge identity after IP changes. Pairing credentials survive reconnects.
- Stable fixture slots, including temporarily missing lights; existing numeric Hue IDs migrate to v2 resource IDs.
- Hue state events plus a full snapshot every ten seconds; discrepancies are retried after transition settling. Optional refresh (default 30 seconds) reasserts exact targets without color oscillations.
- Hardened Art-Net parsing, universe-aware poll replies, packet sequencing, and optional sender restriction.
- Standard / Entertainment / Mixed output modes. Entertainment packets continue even when incoming colors do not change.
- A small status page with bridge/input/fixture status and a **Reapply current look** button.
- Configuration backup before migration and an example systemd service.

## Install on the Pi

Requires **Node.js 22 or newer**, npm, and a Hue bridge supporting API v2. The application runs locally and does not need a Hue cloud account for operation.

```sh
git clone --branch rewrite/reliable-hue-v2 https://github.com/patrickmac110/dmx-hue.git
cd dmx-hue
npm ci
npm test
node bin/dmx-hue.js setup
node bin/dmx-hue.js
```

Stop the old receiver first: only one application should own UDP port 6454 or control this lighting rig. Run setup and the service as the **same operating-system user** so they use the same configuration. See [Pi installation and rollback](docs/RASPBERRY_PI.md).

Existing `dmx-hue` configuration is found using the original `conf` project name. A `.pre-v4.bak` copy is made before the first save. Do not delete this backup. `--config /absolute/path/config.json` selects an existing JSON configuration explicitly. Configuration files contain credentials; do not publish them.

On migration, keep the previous universe value. **Luminair's displayed universe and raw Art-Net numbering can differ.** This program uses the raw wire number, exactly as the old receiver did; do not assume the label “Universe 2” means wire value 2. Setup shows the current setting and patch addresses.

## Automatic grouping without Hue scenes

During setup choose existing Hue rooms/zones, or create a zone named **DMX Hue fixtures** with all patched fixtures. This is a one-time membership definition, not a stored lighting look. The application uses a group only when **every member has a known DMX target and the resulting Hue commands match**. It never groups an unpatched or actively streamed fixture.

You can retain 32 independent RGB fixtures in Luminair. When all targets match, the selected whole-rig zone gets one write. As targets diverge, the scheduler uses selected matching subgroups or individual writes. Commands already in progress finish before another write starts.

Standard-mode grouping improves cue coordination and reduces requests, but it is not intended for high-frequency effects. For fades generated in Luminair, use `--transition 0` to avoid adding a second fade. Group rate limits mean intermediate DMX colors may be skipped; the latest endpoint is retained.

## Entertainment mode (optional; physical validation required)

1. Create an Entertainment area in the Hue phone app, containing compatible lights. This does not move your scene programming out of Luminair.
2. Run `node bin/dmx-hue.js setup` and select **Entertainment** or **Mixed**.
3. If the old credentials have no Entertainment client key, setup asks for a one-time bridge-button pairing.
4. Select the area. Setup reports actual covered fixtures and channel count.

**Entertainment** requires the selected area to cover every configured fixture. **Mixed** streams the area and runs the remaining fixtures through standard control. On this version, one bridge and one selected Entertainment area are supported. It does not bypass the bridge's area capacity, create multiple simultaneous streams, or promise streaming for all 32 physical bulbs.

Channel membership is read from the bridge, including Entertainment service-to-device/light relationships. No fixture-count limit is inferred from a product name. Gradient channels belonging to a single patched light receive that light's DMX color; independently patched gradient segments are not implemented.

The Pi sends HueStream **v2** packets over DTLS/UDP 2100, using the stored client key. Default rate is 25 frames/second (`--stream-fps 1..50`). This is the transmission rate, not a guaranteed physical refresh rate. Multiple channel records are packed together (up to 20 records per packet). Exact colors are continuously retransmitted. RGB is streamed at 16-bit precision derived from the existing 8-bit DMX values; this does not manufacture additional source resolution.

Streaming keeps a local transition interpolator. Set transition to zero when Luminair drives fades. Legacy RGB+white fixture layout and RGB=1 colorloop are not supported in streaming mode.

The program refuses an already active selected area, checks session ownership, and releases its own stream before standard fallback. If another app is streaming a fixture, standard writes to it are suppressed. An interrupted connection is retried; fallback is visibly reported. Hold-last-look continues streaming the last complete target after DMX stops; stop the service to release control to the Hue app. A bridge reboot or loss of power can still interrupt output.

## Status and options

```sh
node bin/dmx-hue.js --help
node bin/dmx-hue.js status
node bin/dmx-hue.js --dashboard-host 0.0.0.0
```

The status page defaults to `http://127.0.0.1:8080`. Use `--dashboard-host 0.0.0.0` to visit `http://<Pi-address>:8080` from the church iPad. It has no login and is intended only for a trusted lighting LAN. It exposes no pairing keys, rejects cross-origin commands, and requires a per-process request token for reapply. Do not forward its port to the internet.

- `--host`: Art-Net bind address; default `0.0.0.0` accepts local broadcast.
- `--source-ip`: optionally accept only a particular DMX sender. Otherwise the first active source owns input until three seconds of silence.
- `-u`, `-a`, `-t`, `-w`: universe, DMX address, transition, legacy five-channel white layout.
- `--refresh-ms 0`: disable periodic reassertion (retries/reconciliation remain enabled).
- `--no-dashboard`: disable the HTTP status listener.
- Runtime flags override settings for this run, without rewriting saved patch settings.

The default is **hold last look** on signal loss. There is no automatic blackout. No stored look is replayed on cold startup: the application waits for a complete live target for each light. Runtime/latest-color state is not persisted across power loss.

## Known compatibility changes

- Requires Node 22+, replaces the unmaintained `node-hue-api` dependency.
- Legacy `--no-limit` is intentionally not implemented: bridge rate limits stay in force.
- Legacy RGB=1 automatic colorloop must be explicitly disabled during migration; use Luminair effects instead.
- Missing fixtures retain slots. To repatch or add new lights after initial migration, stop the service and edit `fixtures` deliberately; setup does not silently reassign existing addresses.
- Certificate identity/fingerprint is checked before credentials are transmitted. IP changes do not require pairing, but a changed certificate requires physical verification and `setup --force`. Initial migration of an old unpinned credential trusts the configured local bridge connection once.
- Bridge state is **not an optical acknowledgement** that every bulb physically changed. A faulty/offline bulb or poor Zigbee link can still fail; the dashboard and reconciliation help diagnose/recover.

## Validation

```sh
npm test
npm run format:check
```

Tests exercise scheduler failures, latest-target races, group/individual ordering, live UDP Art-Net reception, malformed packets, stable patch migration, rediscovery, v2 packet encoding, and simulated streaming lifecycle/fallback. See [acceptance checklist](docs/ACCEPTANCE.md) before using the release live.

Protocol references: [Hue API v2](https://developers.meethue.com/new-hue-api/), [Hue discovery](https://developers.meethue.com/develop/get-started-2/), [v2 streaming reference implementation](https://github.com/michielpost/Q42.HueApi), [Art-Net](https://art-net.org.uk/), and [Luminair manual](https://support.luminair.app/hc/en-us/article_attachments/4411741402388).

MIT license; original project by Yohan Lasorsa. This rewrite preserves the original license.
