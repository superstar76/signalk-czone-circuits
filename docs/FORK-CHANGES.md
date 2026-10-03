# signalk-czone-circuits: the monitoring fork

What the fork adds to Matt Mitchell's plugin and what it changes, as of 3 October 2026.

**Fork:** `github.com/superstar76/signalk-czone-circuits`, branch `monitoring`
**Based on:** Matt Mitchell's `signalk-czone-circuits`, `main` at `45c47d1` (beta.20), merged in with no conflicts. His beta.22 restructure is not merged yet.
**State:** 3 October 2026
**Run on:** the CZone test bench and Compass Rose, both on a Cerbo GX with Venus OS 3.80 and Signal K 2.27
**Size:** about 4,100 lines of new code in 14 new files, 1,800 lines of new tests in 9 new test files, and about 260 lines changed in four of Matt's files

## Summary

Matt's plugin reads a CZone configuration file (ZCF), lists the circuits in a webapp and switches them over NMEA 2000. The fork keeps all of that and adds five things, all driven by the same ZCF with nothing set up by hand:

- **Monitoring:** every meter and sender in the CZone configuration, live, in a Monitoring tab.
- **Trends:** history for every monitored value and every circuit's current, kept on an SD card.
- **Circuit current and temperature:** amps per circuit, and the temperature that belongs to a circuit, shown with the circuit.
- **Victron switch pane:** the CZone circuits as switches on the GX touch screen, Remote Console and VRM.
- **A truer circuit list:** state on boats whose ZCF has no status table, every category named, and circuits that no CZone display would list left out.

The rule throughout: once the ZCF is uploaded, the data should appear. Where the bus is ambiguous (several devices on one instance), the ZCF decides.

## 1. What is new for the person using it

### 1.1 Monitoring tab

A **Monitoring** entry in the webapp lists everything the CZone configuration monitors.

| Group | From the ZCF | Readings |
|---|---|---|
| Batteries | DC meters of type Battery | voltage, current, state of charge, temperature |
| Solar, Alternators, Converters, Wind Generators | DC meters of that type | voltage, current |
| AC Power | AC meters | voltage, current, power, frequency |
| Tanks | tank senders | level %, volume |
| Temperatures | temperature senders | °C |
| Environment | pressure senders | hPa / kPa |
| Inputs | switch inputs | listed; state not decoded yet |

- **Grouping:** a DC meter goes under its DC Type from the Configuration Tool, so a solar meter is under Solar and not under Batteries.
- **Live or not:** each row says LIVE or NOT ON BUS. A row that is not on the bus names the NMEA 2000 instance the ZCF expects ("Nothing is sending instance 3 on NMEA 2000"), which is the number to set on the sending device.
- **Looks:** built from the webapp's own classes, so it matches the circuit list. Group colours are CSS variables.

### 1.2 Trends

- **What is recorded:** every live monitored value and every circuit's current.
- **Sampling:** every 10 seconds by default (setting: 5, 10, 15, 30 or 60 s), buffered and written once a minute.
- **Files:** plain CSV, no database, in two tiers per value:

  | Tier | File | Contents |
  |---|---|---|
  | Full detail | `<series>/<YYYY-MM-DD>.csv` | `time,value`, written when the value changes and at least every 10 minutes |
  | Summary | `<series>/summary/<YYYY-MM>.csv` | `bucket,min,avg,max` per 10 minutes, from every sample |

- **Retention:** kept until storage runs low. Then the oldest full-detail days go first and summaries last, so recording never stops. An optional setting caps full detail at 31, 90 or 365 days.
- **Where:** on a Victron GX, an SD card or USB stick only, never internal flash; with no card, nothing is written or held in memory. On other systems, the Signal K data folder. A "Trend folder" setting overrides both. Minimum card: 16 GB.
- **One manual step on a GX:** Venus OS mounts a FAT card writable by root only, and Signal K runs as the `signalk` user, so a new card shows "Card found but not writable". The card has to be mounted with `umask=0000`; FAT only takes that at mount time, and the VRM logger holds the card, so `docs/venus-sdcard-rw.sh` stops the logger, remounts and restarts it. Copy it to `/data/sdcard-rw.sh` and add `/data/sdcard-rw.sh &` to `/data/rc.local`. The plugin cannot do this itself because it does not run as root.
- **Chart:** an in-page panel with 1 h, 24 h, 7 d, 31 d, 90 d, 1 y or a custom from/to period; now/min/avg/max; a hover crosshair; gaps where data is missing. Periods over 48 hours draw the average with a min–max band, so short spikes stay visible.
- **Several values on one chart:** "Add value" puts any other trended value on the chart, up to five. Each unit gets its own scale; "Stacked" shows one plot per unit on the same time axis.
- **Earlier history:** data already on the card from the February plugin is read in place. Old folder names are matched automatically where possible; others are mapped in `aliases.json` in the trend folder. Compass Rose's history back to late September is readable this way.

### 1.3 Circuit current

- **Shown** under ON on each circuit's button in the webapp, and in the Victron switch label.
- **Trend:** the arrow beside ON/OFF opens that circuit's current trend.
- **Decoded** from CZone's own output tables, 0.1 A resolution:

  | PGN | Sent by |
  |---|---|
  | 130822 | DC modules |
  | 130817 | AC modules and the Output Interface |
  | 130825 | Control X PLUS (a bit-packed form of the same table; needs no CZone display on the network) |

- **Off reads 0 A:** an output whose level says off reads 0 A, where the module otherwise reports a constant 0.1 A.

### 1.4 Circuit temperature

Where a temperature input is named after a circuit, the two are paired: circuit "Freezer" and input "Freezer Temperature" (or "Freezer Temp"), ignoring case and punctuation. Nothing else pairs, and a name shared by two inputs pairs with nothing.

- **Webapp:** a small temperature chip beside the circuit's name; clicking it opens the temperature's trend.
- **Victron switch pane:** in the switch label (see 1.5).
- **Quiet sender:** the temperature is dropped after five minutes without a reading.

### 1.5 Victron switch pane

An opt-in setting registers the circuits with the GX as `com.victronenergy.switch.czone_circuits`, following Victron's switchable-output API.

- **Each circuit is a switch:** toggle or momentary, or a slider for a dimmable circuit.
- **Both directions:** a tap in the pane switches the circuit with the same code the webapp uses, so "Allow sending" still applies; a change made anywhere else shows in the pane.
- **Groups:** one group per circuit, taken from its CZone sub-category (see 1.6).
- **Label:** the name, then the temperature and the current: "Freezer (-8.2 °C, 2.9 A)", "Fridge (5.1 °C)", "Lights (1.9 A)". The temperature is in the unit set on the GX. A label is limited to 32 characters: a long name first gets a compact temperature ("-18°C"), then the name is cut.
- **Order:** the GX lists switches alphabetically by label and has no other order. The label is written so a switch stays in the same place whether it is on or off.
- **Edits made on the GX are kept:** switch names, groups and types, and the device's own name.

### 1.6 The circuit list

- **State on boats with no status table.** Some ZCFs (Compass Rose, Persevere) have no status table, and every circuit read as off. On those, state is taken from the module's output bitmap: bit n is output channel n.
- **Every category named.** All 21 standard sub-categories and the five user-definable ones, whose names are read from the ZCF (Meitaki: Winches, Furlers, Lithium).
- **Virtual-switch circuits hidden.** A circuit that only drives virtual switches is not a circuit anyone switches.
- **Circuits not on any CZone display hidden.** A circuit with no display among its Circuit Controls (thermostat feeds, "pump running" indicators, alarm relays) is left out of the webapp and the pane, as it is on a CZone display. Its state still goes to Signal K.
- **One group where only one fits.** A circuit ticked in several categories is listed under each in the webapp, as on a CZone display. The Victron pane allows one group, so it takes the first in a fixed order: the owner's own categories, then Indicators and Alarms, Navigation, Refrigeration, Bilge Pumps, Pumps, Lighting and so on.
- **The category list follows the tab.** On AC, DC, In Use or Favorites, only the categories of the circuits in that tab are listed, with counts for that tab. A category narrows the tab; a second click clears it. On Monitoring the list is the monitoring groups.

### 1.7 Settings page

- **Saves as you go:** the page now says so, and confirms each save.
- **New settings:** see section 4.

## 2. How readings are found with nothing configured

- **The ZCF gives the identity.** Each meter and sender has an NMEA 2000 instance in the ZCF (and a source or fluid type for senders). The same numbers are in the standard PGNs on the bus.
- **Wired to a CZone module:** read only from that module's own NMEA 2000 address, learned from the module's status messages.
- **Third-party:** read straight off the CAN interface with `candump`, filtered to the sensor PGNs. This is needed on a GX because Signal K does not pass the GX's own transmissions to plugins, and its own battery paths use VRM instances, not the NMEA 2000 instances CZone is configured with.
- **Several devices on one instance:** the meter's DC type in the ZCF is matched to the type each device declares in PGN 127506. For a battery, the device that reports state of charge wins; a charger that also reports a "battery" loses to a shunt. The choice is the same after every restart.
- **One device per reading:** other third-party readings stay with the device sending them and do not flip between two devices using the same instance.
- **AC, both styles:** PGNs 127503 / 127504 and 127744 / 127747 feed the same AC readings, so a meter shows once.

PGNs decoded:

| Reading | PGN |
|---|---|
| Battery and DC meters | 127508, 127506 |
| AC meters | 127503, 127504, 127744, 127747 |
| Temperature | 130312, 130316 |
| Pressure | 130314 |
| Tank level | 127505 |
| Circuit current | 130822, 130817, 130825 |

## 3. What was learned about the ZCF and the bus

These are in the brief for Matt, with evidence, for his parser.

| Finding | Detail |
|---|---|
| Meter instance | The Meters list byte is a meter id. The NMEA 2000 instance is in the DC and AC settings tables that follow |
| DC type | Byte 28 of the DC settings record: low nibble is the NMEA 2000 DC type, high nibble the nominal voltage |
| Inputs table | Senders with their source, instance and fluid type, and calibration points |
| Sub-categories | Flags bits 16 to 31 and category word bits 0 to 3 and 13, in the Configuration Tool's dialog order |
| User-defined categories | Category word bits 7 to 11; names in a small block after the backlight-zone table |
| Virtual switches | Virtual switch n is output channel 31 + n |
| Display controls | Control module 0 is "All Display Interfaces"; module type 16 is a display or chartplotter, 17 the Wireless Interface |
| No status table | On those configurations the 65284 bitmap is the module's output channels |
| Control X PLUS | Current and level are in PGN 130825, 22-bit records, not 130822 |

## 4. Settings added

| Setting | Default |
|---|---|
| Show CZone circuits in the Victron switch pane | off |
| Show circuit current in the switch label | on |
| Show temperature in the switch label | on |
| Show virtual switch circuits | off |
| Show circuits that are not on any CZone display | off |
| Trend folder | automatic |
| Trend sample rate | 10 seconds |
| Keep full-detail trend data for | as long as there is space |

## 5. Signal K paths added

| Path | Value |
|---|---|
| `electrical.czone.<circuit>.current` | amps |
| `electrical.czone.<circuit>.temperature` | kelvin, where a temperature input is named after the circuit |

Matt's `electrical.czone.<circuit>.switch.state` and `.switch.brightness` are unchanged. Meter and sender readings are held in the plugin for the Monitoring tab and trends; they are not published to Signal K.

## 6. Diagnostic pages

All under `/plugins/signalk-czone-circuits`.

| Page | Shows |
|---|---|
| `/monitor/items` | every monitored item with its live readings; circuit-temperature pairings |
| `/monitor/bus` | what reaches the plugin from the bus; every device seen per reading; which device each DC meter was given and why |
| `/monitor/modules` | CZone module to NMEA 2000 address |
| `/monitor/debug?path=` | everything the plugin sees for one path |
| `/monitor/values` | current value of every trended series |
| `/trend/status` | where trends are stored, free space, sample rate |
| `/trend?path=&range=` | a series' data |
| `/victron/status` | the switch pane: circuits it has as on, any that disagree with the plugin, the GX's unit setting, recent requests |

## 7. Faults found and fixed along the way

| Fault | Cause | Fix |
|---|---|---|
| Every circuit off, only ON could be sent (Compass Rose) | ZCF has no status table | State from module and channel |
| No circuit current (Compass Rose) | Control X PLUS uses PGN 130825 | Decoder for the packed table |
| Switch pane all off after a restart | The pane read state back from Signal K and missed it | The pane takes state from the plugin's own decoded state |
| Signal K could crash when the plugin was stopped while starting | Unhandled error on a D-Bus connection closed mid-handshake | Error handled; overtaken starts end cleanly |
| "Solar" showed 12.6 V, 0 A | Three devices on DC instance 1; the wrong one was taken | Device matched by DC type |
| AC not shown | Boat's AC data is on PGNs 127503 / 127504 | Both AC styles decoded |
| Switches changed place in the pane when turned on | The current suffix changed the alphabetical order | Suffix written as "(1.5 A)" |
| Device name on the GX would not hold | The plugin refused the edit | Edit accepted and kept |
| Bilge pumps under "DC" | Bilge Pumps category not located | Found and named |

## 8. Files

New files:

```
lib/monitor/index.js      monitor lifecycle, sender choice, values, routes
lib/monitor/catalog.js    ZCF -> monitored items, groups, circuit-temperature pairs
lib/monitor/currents.js   CZone output tables -> circuit current
lib/monitor/sensors.js    standard meter and sender PGN decoding
lib/monitor/fastpacket.js fast-packet reassembly
lib/monitor/storage.js    trend storage: two tiers, write-on-change, space guard
lib/monitor/wire.js       candump listener for third-party devices
lib/victron/vedbus.js     minimal Victron D-Bus service
lib/victron/switches.js   CZone circuits as GX switchable outputs
lib/fork-mapping.js       state fallback, categories and groups, hidden circuits
lib/zcf-circuits.js       structural circuit parser (with the hidden-duplicate rule)
lib/zcf-monitor.js        meters, meter settings, inputs
public/monitor.js         Monitoring tab and trend panel
public/monitor.css
docs/ZCF-FORMAT.md        layouts, checked across the sample ZCFs
test/                     9 new test files, 2 new ZCF fixtures
```

Changes to Matt's files:

| File | Lines | Change |
|---|---|---|
| `index.js` | +92, −4 | Create, start and stop the monitor; hand the switch pane the send functions and the decoded state; one call after `zcf.load()` to `fork-mapping`; `current`, `temperature` and `notShown` on `/circuits`; eight settings |
| `public/index.html` | +63, −11 | Monitoring tab; amps under ON; trend arrow; temperature chip; category list that follows the tab; icons for the new categories; circuit label shows the circuit's own load, numbered as the Configuration Tool does |
| `public/remoteEntry.js` | +101 | Controls for the eight settings; saved confirmation |
| `package.json` | +4, −1 | `dbus-native` dependency; the new tests in `npm test` |

## 9. Tests

`npm test` runs Matt's suite and the fork's, 21 files, all passing. The fork's tests use frames captured on the bench and on Compass Rose, and eight sample ZCFs (two bench, two Compass Rose, Meitaki, Persevere, Sel Citron, SugarShack).

## 10. What has been confirmed where

| Feature | Bench | Compass Rose |
|---|---|---|
| Monitoring tab, wired and third-party meters | yes | yes |
| Trends on an SD card | yes, once the card was made writable (3 October) | yes, with February's history |
| Circuit current | yes (130822 / 130817) | yes (130825) |
| Switch pane, both directions | yes | yes |
| Pane state after a restart | not re-checked | yes, three restarts |
| State with no status table | does not apply | yes |
| DC meters matched by type | grouping yes (5V System - MI under Converters) | yes (House Battery from the BMS, Start Battery, Solar, Alternator) |
| AC from 127503 / 127504 | does not apply | yes |
| Categories, hidden circuits, category list | not re-checked | yes |
| Temperature in the label and webapp | not re-checked | yes (Freezer and Fridge) |

The bench had the builds of 3 October installed that evening; rows marked "not re-checked" are still to be confirmed there.

## 11. Load on the Cerbo

Measured on Compass Rose, plugin off against plugin on: Signal K at about 41 % and 45 % CPU, a difference smaller than the swing within either run. Idle stayed near 25 % and the load average near 4 both ways. The Cerbo is close to its limit with Signal K, Node-RED and the other apps; the plugin adds nothing measurable. A Cerbo GX MK3 is the comfortable choice for that kind of installation. The plugin has not been run on one.

## 12. Limits and open items

- **Matt's beta.22 restructure is not merged.** A clean-up pass of the fork is planned with that merge: one source of state for the pane, one way of choosing a sender, and the monitor's main file split up.
- **Our own copy of the circuit parser.** `lib/zcf-circuits.js` is Matt's structural parser plus the hidden-duplicate rule. Once his has the rule, ours can go.
- **Switch inputs** are listed but their state is not decoded.
- **Per-display permissions** are not respected: a circuit that only one display may switch off can be switched off from the webapp and the pane.
- **Pane order** is alphabetical; Victron has no setting for it.
- **The GX unit setting** reads empty on Compass Rose and is treated as °C. What it reads when set to Fahrenheit has not been seen.
- **Compass Rose:** the Victron DC instances were renumbered on 3 October (Start Battery 2, Alternator 4, Solar 7) and the Fridge temperature tag corrected, so each meter now has its own instance. House Battery (instance 0) is still sent by several devices; the plugin takes the BMS.
- **Signal K 2.27 admin page:** a plugin's settings sometimes will not reopen without a page refresh. This is a Signal K fault, fixed in 2.33.
- **Parked from the bench:** units from the ZCF, RGB circuits, a Node-RED palette, the occasional current drop-out.

## 13. Before opening the pull request

- [ ] Leave `docs/HANDOVER-czone-signalk.md` and `docs/BRIEF-FOR-MATT.md` out. They are working notes and name customer boats.
- [ ] Merge Matt's latest `main` and do the clean-up pass.
- [ ] If his parser has the hidden-duplicate rule, use it and drop `lib/zcf-circuits.js`.
- [ ] Remove the two leftover `status-fallback` files on GitHub.
- [ ] Re-check on the bench and on Compass Rose.
