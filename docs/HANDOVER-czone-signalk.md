# CZone ↔ Signal K — Combined Handover

**Updated:** 1 October 2026 (evening)
**Owner:** Matthew Duckett (Cleagh Marine Electrical)
**Supersedes:** the 1 October (morning) version, `HANDOVER-NOTES.md` (27 Feb 2026) and `czone-current-monitoring-handover.md` (28 Feb 2026)

Companion documents in this folder:

- `BRIEF-FOR-MATT.md` — what the author needs to resolve in his code.
- `FORK-CHANGES.md` — what our fork adds, file by file, for the pull request.
- `ZCF-FORMAT.md` — ZCF table layouts (circuits, meters, meter settings, inputs).

---

## 1. Where we are

| Area | Status |
|---|---|
| Circuit control (Matt's `signalk-czone-circuits`) | **Working** on the bench (beta.20): commands hold (trailer `0x08`), state feedback from display, wall switch and webapp |
| Structural ZCF circuit parser | **Adopted by Matt** as `lib/zcf-circuit-table.js` (his main, 1 Oct). Bench now shows all 6 circuits with correct channels. One rule missing (see `BRIEF-FOR-MATT.md`) |
| Monitoring tab in the webapp | **Working on the bench** (our fork): batteries, AC, temperatures from the ZCF; nothing configured by hand |
| Circuit current | **Working**: decoded from PGN 130822/130817, shown on the ON button, trend from the › arrow |
| Trending | **Built, untested on hardware**: needs an SD card or USB stick in the Cerbo (Pi/PC: Signal K data folder) |
| Victron switch pane | **Working both ways** on Venus OS 3.80, one card per CZone category, amps in the label |
| Switch inputs (Signal Interface) | **Not started**: message carrying input state not identified yet |
| RGB lighting | **Parked**: no CZone RGB circuit in any ZCF we have |
| Pull request to Matt | **Not yet**: fork `monitoring` branch is up to date with his main (beta.20 + README) |

---

## 2. Systems and locations

### Bench

| Item | Detail |
|---|---|
| GX | Cerbo GX `einstein`, `192.168.1.226` / `venus.local`, Venus OS **3.80** Large |
| Signal K | 2.27.0, config dir `/data/conf/signalk` |
| NMEA 2000 | CZone backbone on **`vecan0`** (there is no `can1`) |
| CZone modules | Output Interface `0x01` (src 0), Signal Interface `0x02` (src 0x1B), Meter Interface `0x04` (src 9), Display `0x10` (src 1) |
| Cerbo's own N2K addresses | 0x65 (temperatures), 0xE0 / 0xE1 (battery / shunt) |
| Circuits | Buzzer `0x05`, Light 1–5 `0x06`–`0x0A` |
| Meters (ZCF 1 Oct) | Victron Shunt inst 2 (virtual), 5V System - Victron inst 3 (virtual, not yet sent by Cerbo), House Battery inst 0 (MI), 5V System - MI inst 1 (MI), Power In AC inst 0 (MI), Power Out AC inst 1 (MI) |
| Senders (ZCF 1 Oct) | Ruuvi Tag: temperature inst 102, source Inside (sent by Cerbo); Victron Temp Sensor: inst 101, source Outside (sent by Cerbo) |
| Inputs | Switch 1–5 on Signal Interface; Tank Level (unconfigured sender) |

### Repositories

| Repo | Use |
|---|---|
| `github.com/mattsmitchell/signalk-czone-circuits` | Matt's plugin + webapp (`main`, beta.20) |
| `github.com/superstar76/signalk-czone-circuits`, branch **`monitoring`** | **Our fork**: Matt's main + our work. The bench installs from here |
| `github.com/mattsmitchell/signalk-czone` | Matt's read-only current plugin. Now uses the structural parser too (commit `e67c29d`); not needed if our fork is merged |

Your fork's `main` branch is untouched and behind Matt; ignore it (or *Sync fork → Update branch*).

---

## 3. CZone protocol — proven facts

### Commands (PGN 65280)

```
27 99 <circuitId> 00 <value> <deviceId> <operation> <trailer>
```

- `operation`: `F1` ON, `F2` OFF, `40` completion, `FC` level; dimmer ON `F5 95 43`, OFF `F5 95 42`.
- `deviceId`: a CZone dipswitch address. Matt picks an unused one from the ZCF (bench `0x03`).
- **`trailer 0x08` = command holds.** `0x00` holds only while the device in `deviceId` is live (cause of the original ~10 s revert).

### Status and telemetry

| PGN | Meaning |
|---|---|
| 65281 | Command acknowledgement from the output module |
| 65284 (`0xFF04`) | Per-module circuit on/off bitmap, bytes 4–7 LE; load-table masks map circuits to bits |
| 0xFF04/15/16/1C | Module status frames; **byte 2 = module dipswitch**, used to learn module → N2K source address |
| **130822** (DC modules) | Output table, fast packet, 28 bytes: `27 99 <module> <page>` + 8 × `[current][level u16 LE]` |
| **130817** (AC modules **and** the Output Interface) | Same, but `27 99 <page> <module>` |

Output table details:

- Slot n on page p = output channel `p*8 + n` (same numbering as the ZCF circuit outputs).
- Current byte = **0.1 A**. Level word: `0x0400` off, `0x07E8` on, `0x0400 + ‰` dimmed.
- **Bench Output Interface reports current byte 1 (0.1 A) on every output, on or off.** We treat level = off as 0 A. On SugarShack's COIs off channels read 0 and on channels read real loads (Starlink 3.1 A, router 1.4 A, AIS 0.3 A).

### Standard PGNs we decode ourselves

| PGN | Use |
|---|---|
| 130312 / 130316 | Temperature: instance, source |
| 130314 | Pressure: instance, source |
| 127505 | Tank level: instance + fluid type nibble |
| 127508 / 127506 | Battery V / A / temp, SoC (first fast-packet frame) |
| 127744 / 127747 | AC phase A current/power, voltage/frequency; "connection" = AC meter instance |

---

## 4. ZCF format (full detail in `ZCF-FORMAT.md`)

- **Circuit table:** structural walk, records = circuit / mode / logic / internal. Matt has adopted this.
- **Meters table:** `[ac][meterId][module][nameLen][name]`. **`meterId` is not the NMEA instance.** Virtual meters are numbered 1..n; a wired meter's id is its input on the module.
- **Meter settings tables** (straight after the Meters table): DC (record size 86 or 92), then AC (65). Each record = `[nmeaInstance][meterId][module]…`. This is where the instance the Configuration Tool shows lives.
  - Confirmed live: Victron Shunt → 2; 5V System - MI → 1.
  - All DC and AC meters in all 8 sample files resolve through these tables.
  - The Pad's House Battery is instance 239.
- **Inputs table:** `[input][module][wiring][kind][flags][a][b]` + body (47 or 53 bytes) + name + calibration points.
  - temperature: `a` = source, `b` = instance;
  - pressure: `a` = source, `b` = instance;
  - tank: `a` = fluid type, `b` = instance;
  - module 0 = third-party sender.

---

## 5. What runs where (our fork)

### Monitoring (`lib/monitor/`, `public/monitor.*`)

1. On start, the ZCF is parsed into a catalogue: meters (batteries, AC), senders (temperature, pressure, tanks), switch inputs, and circuit currents.
2. Values come from, in order:
   - **values the plugin decodes itself:** circuit currents, and sensors/meters by NMEA instance;
   - **Signal K paths**, filtered to the right N2K source for meters wired to a CZone module (module → source learned from module status frames).
3. **Third-party sensors and meters** (ZCF module 0) are read **straight off the CAN bus with `candump`** on `vecan0`, kernel-filtered to the sensor PGNs. Reason: Signal K does not pass the GX's own transmissions (e.g. Cerbo temperatures, shunt) to plugins. It runs only when the ZCF has a third-party sender or virtual meter. While it runs, those readings never fall back to Signal K's `electrical.batteries.<n>`, which on a GX uses VRM instances, not N2K instances.
4. Sampled every 10 s (setting: 5 / 10 / 15 / 30 / 60 s), buffered and written once a minute. See "Trend storage" below.

**Trend storage:**

| Platform | Location |
|---|---|
| Victron GX | SD card or USB stick only (never internal flash) |
| Pi / PC | Signal K data folder |
| Any | The "Trend folder" setting overrides both |

Plain CSV files, no database. Nothing is built or held without storage: with no card, samples are dropped each minute and memory use is a few numbers per point.

| Tier | File | Contents | Used by |
|---|---|---|---|
| Full detail | `<storage>/signalk-czone/trends/<series>/<YYYY-MM-DD>.csv` | `time,value` (February format), **written on change**: when the value differs, plus the last unchanged sample before it, and at least every 10 minutes | 1 h and 24 h charts |
| Summary | `<series>/summary/<YYYY-MM>.csv` | `bucket,min,avg,max` per 10 minutes, built from every sample | 7 d, 31 d, 90 d, 1 y charts (average line with a min–max band) |

- **Retention:** nothing is deleted by age by default ("Keep full-detail trend data for" can cap it at 31 / 90 / 365 days).
- **Space guard (hourly):** when free space drops below 5% or 200 MB on a card (10% or 1 GB on a shared disk), the oldest full-detail days go first; summaries only when no old full detail is left. Today's file and this month's summary are never removed, so recording never stops.
- **Sizing:** 200 points at 10 s is at most 12.6 GB/year of full detail (every sample different; write-on-change makes it far less in practice) plus 0.34 GB/year of summaries. **Minimum card: 16 GB.**

**UI:**

- **Monitoring tab:** one section per group; a value box per live reading; click a box for its trend.
- **Circuit list:** the ON button shows amps; the › arrow opens that circuit's current trend.

### Victron switch pane (`lib/victron/`)

- The plugin registers `com.victronenergy.switch.czone_circuits` on the Cerbo's system D-Bus (VRM device instance from localsettings; bench: 100).
- One `/SwitchableOutput/<slug>/…` per ZCF circuit:
  - State, Status, Name, Current;
  - Dimming for dimmers;
  - Settings: Type (toggle / momentary, or dimmable), Group = CZone category, CustomName, ShowUIControl.
- **Pane → CZone:** calls the same functions as the webapp buttons (hook in `index.js`), so "Allow sending" still applies. A refusal snaps the switch back.
- **CZone → pane:** from the plugin's `electrical.czone.<slug>.switch.state/brightness` deltas.
- **Amps in the label** while on ("Light 1 · 1.5 A"), because Venus OS doesn't display `/Current` yet (Victron community request, 28 Sep 2026). This is a setting.
- Pane-side renames, types and groups are kept in `victron-switches.json` in the plugin data folder.

### Settings added (plugin config panel)

| Setting | Default |
|---|---|
| Show CZone circuits in the Victron switch pane | off |
| Show circuit current in the switch label | on |
| Trend folder (optional) | blank = automatic |

### Diagnostics routes (`/plugins/signalk-czone-circuits/…`)

| Route | Shows |
|---|---|
| `/monitor/items` | The catalogue with resolved values |
| `/monitor/modules` | Learned module → source addresses |
| `/monitor/bus` | Frames reaching the plugin, by PGN and source; candump status; sensors seen vs wanted |
| `/monitor/debug?path=` | What the plugin sees for one Signal K path |
| `/trend/status`, `/trend?path=&range=` | Trend storage and data |
| `/victron/status` | Switch pane service state and the last 10 pane requests |

---

## 6. Lessons from this session

1. **Don't trust "instance-looking" bytes.** The meter list byte matched the bus by coincidence on the first bench file (House Battery 0). The second meter (Victron Shunt) exposed it.
2. **Signal K plugins don't see the GX's own N2K output.** Cerbo-sent temperatures and shunt data only reach a plugin via `candump` (or Signal K's dbus-sourced paths, which use VRM instances).
3. **Signal K doesn't map 127744/127747** (AC phase A). Decode them yourself.
4. **Signal K PUT via `app.putSelfPath`** didn't switch circuits on the bench; calling the plugin's own send functions does.
5. Venus OS gui-v2 prefixes a switch with the device name unless `Settings/CustomName` is set.
6. Spawning a child process: never `kill()` when `pid` is 0/undefined. Kill(0) hits the whole process group, i.e. Signal K.
7. GitHub web upload: nothing happens until **Commit changes**. Hidden files (`.gitignore`) may not upload from Windows.

---

## 7. Next steps

| # | Step | Who |
|---|---|---|
| 1 | SD card (16 GB or larger, high-endurance, FAT32) or USB stick in the bench Cerbo; set up the `/data/rc.local` remount; confirm trends draw | Matthew |
| 2 | Switch inputs: `candump -ta vecan0 \| grep "1B "` while flicking Switch 1 and 2; then build the input display with "lighting-only inputs hidden" default + per-row show/hide | Matthew → Claude |
| 3 | Configure 5V System - Victron instance 3 on the Cerbo (NMEA Reader); confirm it goes live | Matthew |
| 4 | Send Matt `BRIEF-FOR-MATT.md` | Matthew |
| 5 | Tailscale on the Compass Rose Cerbo (RUT200 can't run it); test monitoring, AC/tanks/pressure and dimmers there with sending off first | Matthew |
| 6 | RGB: find a boat with a true CZone RGB circuit; ZCF + capture while changing colour | Matthew |
| 7 | Pull request from `superstar76:monitoring` to `mattsmitchell:main` once Matt has reviewed `FORK-CHANGES.md` | Matthew |
| 8 | Circuit currents stopped arriving once after ~10 h running (2 Oct), back after a restart. When it recurs, **don't restart**: open `/monitor/bus` and note `currentTables` (are frames still climbing? packets? decoded?) | Matthew → Claude |
| 9 | Later: per-row show/hide on Monitoring, theme configurator (group colours are already CSS variables), February parked items (favourites, themes, icons) | — |

---

## 8. Useful commands (bench)

**Install our fork:**

```sh
cd /data/conf/signalk
npm install https://github.com/superstar76/signalk-czone-circuits/tarball/monitoring
svc -t /service/signalk-server
```

Then hard-refresh the webapp with Ctrl+F5. Ignore the `npm audit` and `abstract-socket` warnings.

**Capture to a file:**

```sh
candump -ta vecan0 > /data/capture.log & sleep 20; kill $!
```

Copy it off from Windows PowerShell:

```powershell
scp root@192.168.1.226:/data/capture.log $env:USERPROFILE\Desktop\
```

**Filtered captures:**

| What | Command |
|---|---|
| Temperatures | `candump -ta vecan0 \| grep -E "FD08\|FD0C" & sleep 10; kill $!` |
| Battery status / DC detail | `candump -ta vecan0 \| grep -E "F214\|F212" & sleep 5; kill $!` |
| Signal Interface only | `candump -ta vecan0 \| grep "1B " & sleep 30; kill $!` |

**Switch pane from the shell:**

```sh
dbus -y com.victronenergy.switch.czone_circuits / GetItems | head -40
dbus -y com.victronenergy.switch.czone_circuits /SwitchableOutput/Light_1/State SetValue 1
```

**Logs:**

```sh
tail -100 /data/log/signalk-server/current | tai64nlocal
```
