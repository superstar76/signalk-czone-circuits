# What the `monitoring` fork adds

**Fork:** `github.com/superstar76/signalk-czone-circuits`, branch `monitoring`
**Based on:** `mattsmitchell/signalk-czone-circuits` `main` at `45c47d1` (beta.20), merged in, no conflicts outstanding
**Tests:** Matt's full suite plus 4 new test files all pass (`npm test`)
**Bench-tested:** Cerbo GX, Venus OS 3.80, Signal K 2.27, CZone test bench (OI, SI, MI, display)

Everything is additive: ~3,700 new lines, almost all in new files. Matt's existing files change in a few marked places only (listed at the end).

---

## 1. Monitoring tab

A **Monitoring** entry in the webapp sidebar lists everything the CZone configuration monitors, read from the uploaded ZCF. Nothing is configured by hand.

| Group | From the ZCF | Readings |
|---|---|---|
| Batteries | DC meters | voltage, current, state of charge, temperature |
| AC Power | AC meters | voltage, current, power, frequency |
| Temperatures | temperature senders | °C |
| Environment | pressure senders | hPa / kPa |
| Tanks | tank senders | level %, volume |
| Inputs | switch inputs | (state source still being identified) |

- **Live on the bench:** House Battery and 5V System (Meter Interface), Victron Shunt (Cerbo, instance 2), Power In/Out (Meter Interface AC, e.g. 236 V / 5.3 A / 1238 W / 49.9 Hz with a heater on), Ruuvi and Victron temperature sensors.
- **Matching:** every reading is matched by the NMEA 2000 instance configured in CZone:
  - meters wired to a CZone module are read only from that module's N2K source address (learned from CZone module status frames);
  - third-party sensors are matched on instance + source.
- **Looks:** built from the webapp's own classes (section headers, circuit-row layout, value boxes the size of the ON/OFF button). Group colours are CSS variables, ready for a theme configurator.

## 2. Circuit current

- **Decoding:** CZone's output tables are decoded per channel, 0.1 A resolution, and mapped to circuits using the structural parser's outputs: PGN 130822 (DC modules), 130817 (AC modules and the Output Interface) and 130825 (Control X PLUS, a bit-packed form of the same table that needs no CZone display on the network).
- **Published** at `electrical.czone.<slug>.current`, next to Matt's `.switch.state` / `.switch.brightness`.
- **Shown** under ON on each circuit's button.
- **Trend:** the › arrow beside ON/OFF opens that circuit's current trend.
- **Off = 0 A:** an output whose level word says OFF reads 0 A (the Output Interface otherwise reports a constant 0.1 A).

## 2a. What the fork adjusts on the parser's result (`lib/fork-mapping.js`)

One step after `zcf.load()`, shared by the webapp, the Signal K paths and the Victron switch pane:

- **State without a status table** (Compass Rose, Persevere): bit n of PGN 65284 = output channel n.
- **Every sub-category named** (20 standard ones) and the five user-defined ones read from the ZCF by name (Meitaki: Winches, Furlers, Lithium). `circuit.subCategories` lists all that are ticked, most specific first; `circuit.group` is the first of them, used where a circuit can be in one group only (Victron switch pane). Order: `GROUP_PRIORITY` in `lib/fork-mapping.js`.
- **Virtual-switch circuits hidden** (all outputs on channel 32 or above), unless the setting is ticked.

## 2b. AC and third-party readings

- **AC:** the older PGNs 127503 / 127504 are decoded as well as 127744 / 127747. All feed the same AC meter readings, so a meter shows once; when both styles are on the bus the older pair is used.
- **DC meters matched by type:** each DC meter's type (battery, alternator, converter, solar) is read from the ZCF. When several devices send a third-party meter's instance, the one whose PGN 127506 declares that type is used; for a battery, the one that reports state of charge. Compass Rose: House Battery from the BMS (of five devices on instance 0), Solar from the MPPT's array side (of three on instance 1). `/monitor/bus` lists `dcMeters` (wanted type, every sender, the one chosen). Solar, alternator and converter meters show voltage and current only.
- **One sender per reading:** a third-party reading stays with the device that is sending it and does not flip between two devices that use the same instance. `/monitor/bus` lists `sensorOwners` and `contested`.

## 3. Trending

- **Sampling:** every 10 s by default (setting: 5 / 10 / 15 / 30 / 60 s), buffered, written once a minute.
- **Files:** plain CSV, no database, in two tiers per series:

  | Tier | File | Contents |
  |---|---|---|
  | Full detail | `<series>/<YYYY-MM-DD>.csv` | `time,value`, written when the value changes and at least every 10 minutes |
  | Summary | `<series>/summary/<YYYY-MM>.csv` | `bucket,min,avg,max` per 10 minutes, from every sample |

- **Retention:** kept until storage runs low; then the oldest full-detail days are removed first, summaries last. Recording never stops. An optional setting caps full detail at 31 / 90 / 365 days.
- **Earlier history:** data already on the card is read in place and its summaries built once at start. Old folder names are matched automatically where they are one of the reading's Signal K paths; others are mapped in `aliases.json` in the trend folder.
- **Sizing:** 200 points at 10 s is at most 12.6 GB/year of full detail plus 0.34 GB/year of summaries. Minimum card: 16 GB.
- **Chart:** an in-page panel with 1 h / 24 h / 7 d / 31 d / 90 d / 1 y or a **custom period** (from/to), min/avg/max/now tiles, hover crosshair, and gaps where data is missing. Ranges over 48 h read the summaries and draw the average with a min–max band, so short spikes stay visible.
- **Several values on one chart:** "Add value" puts any other trended value (meter, sender or circuit current) on the chart, up to 5. Each unit gets its own scale (first on the left, others on the right, ticks on shared grid lines); "Stacked" shows one plot per unit on the same time axis instead. A legend row per value gives now/min/avg/max; the crosshair reads every value at that time.
- **Storage:**
  - Victron GX: SD card or USB stick only, never internal flash. With no card nothing is written or held in memory;
  - other platforms: the Signal K data folder;
  - optional "Trend folder" setting overrides both.

## 4. Third-party sensors straight off the bus

- **Why:** Signal K doesn't pass the GX's own NMEA 2000 transmissions (Cerbo temperatures, SmartShunt) to plugins. On a GX, Signal K's `electrical.batteries.<n>` uses VRM instances, not the N2K instances CZone is configured with.
- **How:**
  - only when the ZCF has a third-party sender or virtual meter, the plugin runs `candump` on `vecan0`, kernel-filtered to PGNs 130312/130316/130314/127505/127508/127506/127744/127747;
  - Venus OS ships `candump`. Elsewhere this does nothing and Signal K paths are used.

## 5. Victron switch pane

- **Opt-in setting:** registers `com.victronenergy.switch.czone_circuits` on the GX's system D-Bus, following Victron's SwitchableOutput API.
- **Channels:** every ZCF circuit becomes a switch:
  - toggle (or momentary, chosen in the pane);
  - dimmable with a slider;
  - one card per CZone category.
- **Both directions:**
  - pane taps call the same `sendCircuitState` / `sendCircuitBrightness` as the webapp, so "Allow sending" still applies;
  - CZone changes (display, wall switch, webapp) update the pane.
- **Current in the label:** "Light 1 (0.1 A)" while on (optional), because Venus OS doesn't display `/Current` yet. The GX sorts switches by label, and this form keeps a switch in the same place on or off.
- **Pane edits kept:** renames, groups and types made in the pane are saved.
- **Dependency:** adds `dbus-native` (same library as other Signal K ↔ Venus plugins).
- **Device name:** defaults to `CZone <vessel name from the ZCF>`; a name typed in the GX device list is accepted, kept in `victron-switches.json` and survives restarts and new ZCF uploads. Clearing it restores the default.
- **State source:** the pane takes each circuit's state from the host plugin's decoded state (`getState` handed over with the send functions), the same one the webapp shows; reading it back from Signal K is the fallback. On Compass Rose the pane stayed all-off after a restart while Signal K and the webapp had the right state.
- **One live service:** the newest instance takes the D-Bus name (replace flags); an older one that finds the name gone retires. A start overtaken by a stop does not carry on. A D-Bus connection error is logged instead of taking Signal K down (stopping the plugin while the connection was still opening crashed the server).
- **`/victron/status`** lists the circuits the pane has as on, any that differ from Signal K (`mismatch`), and `diag` (process id, instance number, resync count and errors, whether this instance owns the service name).

## 6. ZCF parsing

| File | Adds |
|---|---|
| `lib/zcf-circuits.js` | Our structural circuit parser **with** the hidden-duplicate rule. Matt's `zcf-circuit-table.js` is the same parser minus that rule; once he adds it, our copy can go and the monitor can use his |
| `lib/zcf-monitor.js` | Meters table, DC/AC meter settings tables (the real NMEA instances), Inputs table (senders: source/instance/fluid; calibration points) |
| `docs/ZCF-FORMAT.md` | Layouts and validation across 8 ZCFs |

## 7. Settings added

| Setting | Default |
|---|---|
| Show CZone circuits in the Victron switch pane | off |
| Show circuit current in the switch label | on |
| Trend folder (optional) | automatic |
| Show virtual switch circuits | off |
| Trend sample rate | 10 seconds |
| Keep full-detail trend data for | as long as there is space |

All six are in both `schema` and the custom config panel (`public/remoteEntry.js`).

## 8. Diagnostics routes

`/monitor/items`, `/monitor/modules`, `/monitor/bus`, `/monitor/debug?path=`, `/monitor/values`, `/trend/status`, `/trend?path=&range=`, `/victron/status`.

---

## New files

```
lib/monitor/index.js      monitor lifecycle, value resolution, routes
lib/monitor/catalog.js    ZCF -> monitored items and Signal K candidates
lib/monitor/currents.js   CZone output-table decoding -> circuit current
lib/monitor/sensors.js    standard sensor / meter PGN decoding
lib/monitor/storage.js    trend storage: two tiers, write-on-change, space guard
lib/monitor/wire.js       candump listener for third-party sensors
lib/victron/vedbus.js     minimal Victron VeDbus service on dbus-native
lib/victron/switches.js   CZone circuits as Venus OS switchable outputs
lib/fork-mapping.js       state fallback, categories and groups, virtual-switch circuits
lib/monitor/fastpacket.js fast-packet reassembly (current tables, older AC PGNs)
lib/zcf-circuits.js       structural circuit parser (see §6)
lib/zcf-monitor.js        meters, meter settings, inputs
public/monitor.js         Monitoring tab + trend panel
public/monitor.css
test/monitor.test.js, test/victron-switches.test.js,
test/zcf-circuits.test.js, test/zcf-monitor.test.js,
test/fork-mapping.test.js, test/control-x-plus.test.js,
test/ac-legacy.test.js, test/dc-meters.test.js
test/fixtures/TestBench-2026-10-01.zcf
docs/ZCF-FORMAT.md
```

## Changes to Matt's files

| File | Change |
|---|---|
| `index.js` | Require + create the monitor (2 lines). `monitor.start/stop/registerRoutes` in start/stop/router (3 lines). `monitor.setControls({state, brightness})` handing the switch pane his send functions (4 lines). `current` added to `/circuits` items (1 line). Five schema properties |
| `public/index.html` | Load `monitor.css` / `monitor.js`. "Monitoring" nav entry. Hide the circuit list while Monitoring is shown. Amps under ON. The › arrow becomes a button opening the current trend. WebSocket subscription + handler for `.current` |
| `public/remoteEntry.js` | Five settings controls (switch pane, label current, trend folder, sample rate, full-detail retention) |
| `package.json` | `dbus-native` dependency; four test files added to `npm test` |

## Before opening the pull request

- [ ] Leave `docs/HANDOVER-czone-signalk.md` and `docs/BRIEF-FOR-MATT.md` out of the PR. They're our working notes and mention customer boats.
- [ ] If Matt has added the hidden-duplicate rule, point `lib/monitor/catalog.js` at his `zcf-circuit-table.js` and drop `lib/zcf-circuits.js` and its test.
- [ ] Merge his latest `main` once more; run `npm test`.
- [ ] Bench re-check: monitoring, trends with an SD card, switch pane both ways.
