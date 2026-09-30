# CZone ↔ Signal K — Combined Handover

**Date:** 1 October 2026
**Owner:** Matthew Duckett (Cleagh Marine Electrical)
**Supersedes:** `HANDOVER-NOTES.md` (27 Feb 2026) and `czone-current-monitoring-handover.md` (28 Feb 2026)

This document brings together:

- the February 2026 work on our own plugin (`signalk-czone-switch-control`, "CZone Control");
- the September/October 2026 bench work with Matt Mitchell's plugins (`signalk-czone-circuits` and `signalk-czone`);
- what we are building next, and how it goes back to the author.

---

## 1. Where we are (summary)

| Area | Status |
|---|---|
| Circuit control from Signal K (author's `signalk-czone-circuits`) | **Working on bench** (beta.15): commands hold, state feedback from plugin, display and physical switch |
| Root cause of the "turns off after ~10 s" fault | **Found and fixed**: command trailer byte must be `0x08` (see §3) |
| ZCF circuit parser | **New structural parser written and validated** on 5 vessels against the CZone Configuration Tool (§4). Delivered as `zcf-circuit-parser.zip`, not yet merged by author |
| Per-circuit current (`signalk-czone`) | Decoding works, but **circuit mapping is wrong** because it uses the old ZCF parser (§6) |
| Monitoring + trending in the author's webapp | **Planned** (§8). Reuses the February design and storage format |
| Victron GX Switches pane | **Planned**: optional `electrical.switches.*` mirror (§9) |

---

## 2. Systems and locations

### Bench

| Item | Detail |
|---|---|
| GX | Cerbo GX `einstein`, `192.168.1.226` / `venus.local`, Venus OS Large |
| Signal K | 2.27.0, Node v24.18.1, config dir `/data/conf/signalk` |
| NMEA 2000 | CZone backbone on `vecan0`; Signal K canboatjs source address `0x65` |
| CZone bench modules | Output Interface `0x01`, Signal Interface `0x02`, Meter Interface `0x04`, Display `0x10` |
| Bench circuits | Buzzer `0x05`, Light 1–5 `0x06`–`0x0A` (IDs proven live) |
| Bench ZCF | `TestBench.zcf` (also in the author's repo as a test fixture) |

### Repositories

| Repo | Purpose |
|---|---|
| `github.com/mattsmitchell/signalk-czone-circuits` | Author's circuit **control** plugin + webapp (beta.15 installed on bench) |
| `github.com/mattsmitchell/signalk-czone` | Author's read-only **current** plugin (PGN 130822/130817) |
| Our fork (to create) | `signalk-czone-circuits`, branch `monitoring` |

### February plugin (ours, retired as a separate plugin)

- Name: `signalk-czone-switch-control`, display name "CZone Control", icon: "CZ" logo.
- Files: `index.js`, `public/index.html`, `public/icons.js`, `public/icon.png`, `schema.json`, plus `/data/rc.local` for the SD card remount.
- Features worth carrying forward: Monitor tab, SD card trending, trend chart window, path auto-discovery, favourites tabs, themes, icon library.

---

## 3. CZone protocol — proven facts

All commands are proprietary PGN **65280** (`0xFF00`), payload `27 99 …` (BEP/CZone manufacturer code).

### Command frame

```
27 99 <circuitId> 00 <value> <deviceId> <operation> <trailer>
```

| Byte | Meaning |
|---|---|
| `circuitId` | Circuit's runtime ID from the ZCF circuit table |
| `value` | Level % for `FC` (dimmer level), else `00` |
| `deviceId` | Sending device's CZone **dipswitch** address (a display sends its own, e.g. bench display `0x10`) |
| `operation` | `F1` ON, `F2` OFF, `40` completion/release, `FC` level, dimmer: `F5 95 43` = ON, `F5 95 42` = OFF |
| `trailer` | **`0x08`** = command holds regardless of sender. `0x00` = holds only while the device named in `deviceId` is live on the bus |

Sequences:

- **Switch:** `F1` (or `F2`) followed by `40` completion.
- **Dimmer:** `F5`, `95`, `43` (ON) or `F5`, `95`, `42` (OFF), then `FC` for level.
- **Mode activation:** `27 99 <modeId> 00 00 <deviceId> F1 <trailer>`.

### The 10-second revert — proven on the bench (30 Sep 2026)

| Byte 5 (sender) | Sender live on bus? | Trailer | Result |
|---|---|---|---|
| `08`, `24`, `65` | No | `00` | Reverts after ~10.4 s |
| `10` (bench display) | **Yes** | `00` | Holds |
| `10`, `65`, `24` | either | `08` | Holds |
| `24`, circuit with switch-input control only | No | `08` | Holds |
| SugarShack `24` (its Wireless Interface) | Yes | `00` | Held 39 s and 81 s (log capture) |

The author's plugin had hard-coded `0x24` (SugarShack's WI 01) and `0x08` (SugarShack's Touch 10). They were live on his boat, so `00` worked there and nowhere else. Beta.13+ uses trailer `08` and picks an unused dipswitch from the ZCF (bench: `0x03`).

### Other PGNs

| PGN | Meaning (proven) |
|---|---|
| 65281 (`0xFF01`) | **Command acknowledgement** from the output module, e.g. `27 99 00 41 01 51 28 00`. *Not* current data (Feb hypothesis retired) |
| 65284 (`0xFF04`) | **Circuit on/off status bitmap**: `27 99 <module> <moduleType> <b4 b5 b6 b7>`, bytes 4–7 = uint32 LE. Bench OI: bit = channel. *Not* serial/firmware (Feb label retired) |
| 65288 / 65294 | Display presence broadcasts (`27 99 00 10 …`, `27 99 64 00 00 10 02 40`). Not needed for control |
| 130822 / 130817 | Per-circuit **DC / AC current**, fast packet, broadcast without polling. Decoded by `signalk-czone` |
| 65290 / 130816 / 65291 | Configuration read (claim / DataBlock / ack), used by "Read From Network" |
| 130825 | Ruled out as a current source (Feb) |

No polling is needed for current. The February plan to capture a display's "poll request" is **no longer required**.

---

## 4. ZCF format findings

### Module table (after the vessel name)

`u32 tableLength | u8 count | 00 | 05 | record × count`, record = `[dipswitch][type][flags][nameLen (bit 7 = flag)][name] + 1 byte`.
Dipswitch strings read **LSB-first**: `10000000` = `0x01`, `00000001` = `0x80`, `11000000` = `0x03`.

### Circuit table (structural parser, `lib/zcf-circuits.js`)

```
u32 tableLength | u16 recordCount | u8[4] header | record × recordCount
record:
  u8  circuitId
  u32 flags        0x0400 logic block ("LB …"), 0x0100 Mode
  u16 category     0x0020 DC, 0x0040 AC, 0x0010 lighting, 0x0001 electronics; 0 on Modes
  u8  nameLen, name (UTF-8, stored with trailing spaces)
  u32 controlsLen, u16 controlCount, controls (skipped by length)
  u32 outputsLen,  u16 outputCount, outputs: ch, module, u16 level (0.1 %), u8, +9 bytes if level & 0x0400
```

Record kinds: `circuit`, `mode`, `logic`, and `internal` (a zero-control circuit sharing a name with a controllable one, e.g. Meitaki "Audible Alarm" `0x01`/`0x02` beside the real `0x20`).

**Channel numbering**

| Module | Mapping |
|---|---|
| CXP | A.1–A.4 = 0–3, B.1–B.10 = 4–13, C.1–C.6 = 14–19 |
| COI | DC5–DC16 = 0–11, DC1–DC4 = 12–15 |
| ACOI | ACn = n − 1 |
| Output Interface, Contact 6 | n − 1 |
| Virtual switches | VSn = `0x1F` + n |

**Validation against the Configuration Tool**

| Vessel | Old parser | New parser | Result |
|---|---|---|---|
| TestBench | 5 | 6 | Exact; IDs proven live |
| Compass Rose | 21 | 35 | Exact; 26 loads' module + channel correct |
| Sel Citron (02.04.25 file) | 100 | 102 | All common names match; 76/76 modules correct |
| The Pad (04.08.26) | 53 | 76 + 2 modes | Exact; 53/53 modules correct. **Customer file, not in the author's repo** |
| Meitaki | 103 | 107 + 8 modes | Exact name list; 38/38 module + channel correct |
| SugarShack | 108 | 110 + 4 modes | Mode IDs match live captures |

Old-parser defects the new one fixes:

- circuits missing;
- **each circuit given the previous circuit's module and channel**;
- circuit ID 0 for names picked up from other tables;
- Modes not separated from circuits.

### Load table (status masks)

The TestBench file carries a per-load 32-bit mask before each name, then output number and module. The masks match the 65284 bitmap exactly (Light 1 `0x01` … Light 5 `0x10`, Buzzer `0x20`; Light 5 drives both, hence `0x30`). The author implemented this in beta.15.

### Meters and Inputs tables (not yet parsed)

Located in The Pad's ZCF:

- **Inputs/sensors:** tanks and temperatures with calibration curves, and digital inputs (BMS Alarm, Watermaker Running …).
- **Meters:** name + instance-like number (Start Battery - Port `02`, House Battery `03`, Start Battery - STBD `04`, 12V House `09`, Solar `05` …).

Needs ground truth from the Configuration Tool Meters and Inputs tabs before parsing (§10, step 2).

---

## 5. Author's plugin — current state (beta.15) and open items

Working on the bench:

- control, with trailer `08` and an automatically chosen device ID;
- webapp and PUT paths send the same full sequences;
- dimmer ON is `F5 95 43`;
- module table parse;
- load-mask status: the UI follows the plugin, the display and physical switches.

Open items for the author:

1. **Adopt the structural circuit parser** (`zcf-circuit-parser.zip`): adds the missing circuits (e.g. bench Buzzer), fixes module/channel, drops circuit-ID-0 entries, separates Modes. SugarShack group circuits (All Lights On, Welcome Home, Wireless Relay Buttons) are ordinary multi-output circuits in the file.
2. **Same parser fix in `signalk-czone`** (§6).
3. Bench tests read `/mnt/data/TestBench.zcf`; point them at `test/fixtures/`.
4. Module table: header byte = device count and each record has 1 trailing byte. Could read exactly instead of resyncing (works as is).
5. Optional `electrical.switches.*` mirror (§9).

---

## 6. `signalk-czone` current mapping bug

On Compass Rose, **21 of 21** current mappings point at the previous circuit's output (e.g. Anchor Light reads AFT Outlets' current: module 1 / ch 17 instead of module 2 / ch 5).

**To confirm before raising with the author:** on Compass Rose, switch on only AFT Outlets and see which `electrical.czone.*.current` path moves. If it's `Anchor_Light.current`, the bug is confirmed.

Fix: use the structural parser's `outputs[].module/channel`.

---

## 7. February 2026 learnings — what carries forward

### Carry forward

- **SD card storage.** The SD card is `/dev/mmcblk0p1` on `/run/media/mmcblk0p1` (vfat); `mmcblk1` is the internal eMMC. Detection = scan `mount` for `mmcblk0`, exclude system paths, fall back to `/run/media/*`, `/media/*` and known paths. Never write trends to `/data` (flash wear).
- **SD permissions.** Signal K runs as a non-root user, so the card needs remounting `rw,umask=0000` at boot via `/data/rc.local`:
  ```sh
  if mount | grep -q mmcblk0p1; then
    umount /run/media/mmcblk0p1 2>/dev/null
    mount -o rw,umask=0000 /dev/mmcblk0p1 /run/media/mmcblk0p1
  fi
  ```
- **Trend file format.** `<SD>/signalk-czone/trends/<path_with_unsafe_chars_replaced>/<YYYY-MM-DD>.csv`, lines `timestamp_ms,value`. **Keep identical** so existing data carries over.
- **Trend API.** `GET …/api/trend?path=&range=1h|24h|7d|31d`, downsampled (targets ≈ 300/350/400 points); `GET …/api/trend/status` for availability. Retention 31 days (make it configurable).
- **Monitor UI.** Category sections, reading cards with warn/danger bars, trend modal (canvas, multi-series, fullscreen, crosshair tooltip, min/max/avg). Landing tab = Monitor.
- **Path auto-discovery.** Batteries, solar, alternators, inverters, tanks, environment/propulsion temps, GPS. Keep it for non-CZone data (Victron).
- **Gotcha:** the `.hidden { display:none !important; }` class was missing and broke the trend modal. Check class names when porting.

### Retired or superseded

| February approach | Replaced by |
|---|---|
| Switch control via PGN 127502 / `electrical.switches.bank.*` | Native CZone 65280 commands (author's plugin) |
| Anti-oscillation hysteresis on switch state | Real state from 65284 |
| Polling a display for circuit current | Broadcast PGNs 130822/130817 |
| Trend sampling via HTTP to `localhost:3000` | In-process Signal K values (works with security on, no HTTP per path) |
| Appending to every CSV every 30 s | Buffered, batched writes (≈ 1 min) |
| Manually configured monitor items | ZCF Meters/Inputs discovery + path discovery; manual add kept for extras |

### Parked from February (later pull requests)

Favourites tabs with backgrounds, theme presets, icon library and management, sequential switch type, GPS toggle, drag-to-reorder, custom trend date range, valve/position feedback graphics.

---

## 8. What we are building next

**Goal:** a **Monitor** section in the author's webapp (left sidebar) that automatically lists everything the CZone config monitors (meters and inputs), plus per-circuit current, with 31-day trending on the SD card. Built in parallel with the author and contributed as a pull request.

### Design

| Piece | Location (our files) | Notes |
|---|---|---|
| ZCF Meters/Inputs parser | `lib/monitor/zcf-meters.js` | Names, types, instances; validated like the circuit parser |
| Path mapping | `lib/monitor/paths.js` | Meter/input → existing Signal K paths (`electrical.batteries.<inst>.*`, `tanks.<type>.<inst>.*`, temperatures), plus `electrical.czone.<circuit>.current`; February path discovery for non-CZone items |
| Trend storage | `lib/trends/` | Port of the February SD code: same folder/CSV format, batched writes, retention setting, "no SD card" status |
| Routes | `lib/monitor/routes.js` | `/monitor/items`, `/monitor/values`, `/trend`, `/trend/status` under the plugin's router |
| UI | `public/monitor.js` + small CSS block | Monitor view: cards by category, trend modal ported from February |

**Touch points in the author's code: two lines.** One router mount in `index.js`, one nav entry in `public/index.html` (his nav is a plain list of `[view, icon, title, count]`).

### Git workflow

1. Fork `signalk-czone-circuits`; work on branch `monitoring`.
2. Rebase onto each of his betas (the minimal touch points keep conflicts rare).
3. Tests go in `test/`, using fixtures already in his repo (never customer ZCFs such as The Pad).
4. Open a pull request when happy; he reviews, merges and ships it in his next beta.

---

## 9. Victron GX Switches pane (separate, small)

- Plugin setting (off by default): "Also publish circuits as standard Signal K switches".
- Publishes `electrical.switches.czone_<slug>.state` (+ `dimmingLevel` 0–1), with `meta.displayName`, and PUT handlers that call the same send code. Circuits only: no modes, logic or internal records.
- Victron side: the `signalk-to-venus` plugin auto-discovers `electrical.switches.*` and syncs both ways. **Its README says switch support is untested.** Bench-test first: publish one test switch from Node-RED and check the Switches pane.
- Fallback if that fails: Node-RED virtual switch nodes (one per circuit, shared logic), or the plugin registering a Venus switch service itself.

---

## 10. Next steps

| # | Step | Who | Needs |
|---|---|---|---|
| 1 | Send `zcf-circuit-parser.zip` + findings to the author (§4–5) | Matthew | Done (zip delivered) |
| 2 | Screenshots of **Meters** and **Inputs** tabs, fully expanded, for The Pad and Compass Rose | Matthew | Configuration Tool |
| 3 | Confirm the `signalk-czone` mapping bug on Compass Rose (AFT Outlets test, §6), then raise with author | Matthew | Compass Rose |
| 4 | Create fork + `monitoring` branch; share the repo link | Matthew | GitHub account |
| 5 | Write + validate ZCF Meters/Inputs parser against step 2 | Claude | Step 2 |
| 6 | Port SD detection + trend storage; confirm SD detection on the bench Cerbo (`/run/media/mmcblk0p1`) | Claude + Matthew | SD card in bench Cerbo, `rc.local` |
| 7 | Monitor view in the author's webapp + trend modal | Claude | Steps 5–6 |
| 8 | Bench test on Cerbo, then Compass Rose | Matthew | — |
| 9 | Pull request to author | Matthew | Steps 5–8 |
| 10 | Switches-pane test (`signalk-to-venus`), then propose the mirror setting | Matthew / author | — |
| 11 | Later PRs: favourites, themes, icons, other parked items (§7) | — | — |

---

## 11. Useful commands (bench)

**Install or update the author's plugin (clean pull):**
```sh
cd /data/conf/signalk
rm -rf node_modules/signalk-czone-circuits
npm install https://github.com/mattsmitchell/signalk-czone-circuits/tarball/main
svc -t /service/signalk-server
```
Then hard-refresh the admin page (Ctrl+Shift+R). Ignore `npm audit` warnings; don't run `npm audit fix`.

**Capture CZone commands + status:**
```sh
candump -td vecan0,00FF0000:03FFFF00,00FF0400:03FFFF00
```

**Capture all CZone proprietary traffic:**
```sh
candump -td vecan0,00FF0000:03FF0000,01FF0000:03FFFF00
```

**Capture to a file for 30 s** (Venus has no `timeout`):
```sh
candump -tA vecan0,00FF0000:03FF0000,01FF0000:03FFFF00 > /data/capture.log & sleep 30; kill $!
```
Copy it off from Windows PowerShell with `scp root@192.168.1.226:/data/capture.log .`

**Manual circuit command** (Light 5 = `0A`, device ID `03`, trailer `08`):
```sh
cansend vecan0 1CFF0065#27990A000003F108
cansend vecan0 1CFF0065#27990A0000034008
```
Use `F2` in place of `F1` for OFF.

**Logs:**
```sh
tail -100 /data/log/signalk-server/current | tai64nlocal
```

---

## 12. Files produced in this session

| File | Purpose |
|---|---|
| `zcf-circuit-parser.zip` | `lib/zcf-circuits.js`, `test/zcf-circuits.test.js`, `ZCF-CIRCUIT-TABLE.md` for the author |
| `bench-status.log` | 65284 capture used to prove the load-mask mapping |
| `czone-controller-id.patch` | **Superseded:** heartbeat approach, not needed |
| This handover | Start point for the next session and for the fork's `docs/` |
