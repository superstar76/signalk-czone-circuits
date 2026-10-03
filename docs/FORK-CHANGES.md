# signalk-czone-circuits: the monitoring fork

What the fork adds to Matt Mitchell's plugin and what it changes, as of 4 October 2026.

**Fork:** `github.com/superstar76/signalk-czone-circuits`, branch `monitoring`
**Based on:** Matt Mitchell's `signalk-czone-circuits`, `main` at `45c47d1` (beta.20), merged in with no conflicts. His beta.22 restructure is not merged yet.
**State:** 4 October 2026
**Run on:** the CZone test bench and Compass Rose, both on a Cerbo GX with Venus OS 3.80 and Signal K 2.27, and both reachable remotely over Tailscale
**Size:** about 4,300 lines of new code in 15 new files (and two small shell scripts), 2,000 lines of new tests in 10 new test files, and about 430 lines added to four of Matt's files

## Summary

Matt's plugin reads a CZone configuration file (ZCF), lists the circuits in a webapp and switches them over NMEA 2000. The fork keeps all of that and adds six things, all driven by the same ZCF with nothing set up by hand:

- **Monitoring:** every meter and sender in the CZone configuration, live, in a Monitoring tab.
- **Trends:** history for every monitored value and every circuit's current, kept on an SD card.
- **Circuit current and temperature:** amps per circuit, and the temperature that belongs to a circuit, shown with the circuit.
- **Victron switch pane:** the CZone circuits as switches on the GX touch screen, Remote Console and VRM.
- **A truer circuit list:** state on boats whose ZCF has no status table, every category named, and circuits that no CZone display would list left out.
- **On the chartplotter:** the webapp as a tile on a B&G / Simrad / Lowrance plotter, with a layout for its touch screen.

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
- **No false readings:** NMEA 2000 marks a field as "not available", "out of range" or "reserved" with its top values. None of them is shown as a reading; the last good value stays.

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
- **One file on the card for a GX, and no login.** Venus OS mounts a FAT card writable by root only, and Signal K runs as the `signalk` user, so the plugin can see a new card but not write to it. The plugin cannot change that itself. Venus OS, though, unpacks a file called `venus-data.tgz` from a card at boot and runs a hook from it. So when a card is found but not writable, the Monitoring tab says so and gives three steps: download `venus-data.tgz` from the link there, copy it onto the card with a computer, restart the GX. From then on the GX opens the card for Signal K at every start, including after a firmware update. Nobody has to log in to the GX.
  - **What the file does:** puts `sdcard-rw.sh` in `/data` and adds one line to `/data/rc.local` to run it at boot. The script mounts each FAT card or stick again with open permissions, stopping the VRM logger for the moment that takes, and does nothing when the card is already open.
  - **How far it is tested:** the archive, both scripts and the download are covered by `npm test` (the scripts in a dry run against mount tables copied from the bench). The original, simpler script was pasted in by hand on the bench Cerbo and works there. The file-on-the-card route itself has not yet been run on a GX.
  - **With no card at all** the pill says "No SD card or USB stick: trends off".
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
- **A circuit's own loads only:** where a circuit also switches another circuit's load, that load's current stays with the circuit it belongs to (see 1.6).

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
- **A circuit's own load.** A circuit's load list in the ZCF can include loads that belong to other circuits: on the bench, Light 5 lists the Buzzer's output ahead of its own; on Compass Rose, Instruments lists Autopilot's and VHF's. A load is treated as another circuit's when it is that circuit's only output. What is left is the circuit's own, and it decides three things:

  | Use | Before | Now |
  |---|---|---|
  | Label under the name | first load listed, counted from 0 (Light 5 and Buzzer both "ch 5") | the circuit's own load, counted from 1 as the Configuration Tool does (Light 5 "ch 5", Buzzer "ch 6") |
  | Current | every load the circuit switches | its own loads |
  | State with no status table | the first load listed (Instruments followed the autopilot) | its own load |

  The other circuits it switches are in the hover text ("Also switches: Buzzer"). A circuit that owns no load at all (SugarShack's All Lights On, Welcome Home) is a group and shows no load, like a Mode.
- **Not logged in is said plainly.** When Signal K refuses the plugin's data, the page says "Not logged in to Signal K" and links to the login, instead of showing an empty list under "Connected". A login is kept per address, so `venus.local` and the IP address each need their own.
- **The category list follows the tab.** On AC, DC, In Use or Favorites, only the categories of the circuits in that tab are listed, with counts for that tab. A category narrows the tab; a second click clears it. On Monitoring the list is the monitoring groups.

### 1.7 Settings page

- **Saves as you go:** the page now says so, and confirms each save.
- **New settings:** see section 4.

### 1.8 Chartplotter view

A Navico plotter (B&G, Simrad, Lowrance) on the same Ethernet network as Signal K can show the webapp as a tile. The plotter's browser is Chromium 69 and cannot run Signal K's pages as they are, so the tile comes from another plugin, `signalk-navico-embedder`, which converts pages on the way through and supplies the login token.

- **Layout:** the page recognises the plotter (the plotter's own parameters on the address, or the embedder's token) and switches to a touch layout: larger rows and buttons, no banner, the category and status chips dropped, drawn icons in place of symbol characters the plotter's fonts lack. A desktop browser never sees it; `?layout=mfd` shows it for testing.
- **Scrolling:** the plotter's touch arrives as mouse events, so a drag selected text and nothing scrolled. The page now scrolls the list or the left column on a drag, and the release is not taken as a tap.
- **Compatibility:** the page's own script avoids syntax newer than that browser (the embedder converts separate script files but not the code inside a page).
- **Tested** on Compass Rose (Simrad NSS evo3S): the tile appears, the page loads with live state, and circuits switch from the plotter. The touch layout and drag scrolling were built after that test and checked against a real Chromium 69 build, driven by a simulated mouse; they have not yet been seen on the plotter.
- **Not done yet:** the plotter's day and night mode is not followed, and the trend panel's few remaining symbol characters have not been checked on the plotter.
- **Setting it up:** the plotter and the Signal K machine must be on the same network segment. In the embedder: the IP override set to that machine's wired address, the CZone Circuits app enabled, and an admin token (the plugin's own interface needs a login). On Compass Rose the embedder's own "Generate" button did not deliver a token; one made with `signalk-generate-token` and written into the embedder's settings did. Restrict the embedder's client list to the plotter's address, since the token carries admin rights.
- **The built-in Signal K tile is not this.** A GX running Venus OS Large advertises a Signal K tile to the plotter by itself, but it opens Signal K's admin page, which that browser cannot draw (a white screen on Signal K 2.27).

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
| Load lists | A circuit's first load can be another circuit's; the parser's module/channel is that first load |
| Circuits with no controls | Some circuits have no Circuit Controls at all and are switched only as loads of another circuit (SugarShack's four solar chargers under SSB Operation) |
| Reserved values | The top three values of a numeric NMEA 2000 field mean no data; a bridge on the bench sends AC power as "out of range" from time to time |

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
| `/trend/card-setup` | downloads `venus-data.tgz`, the card setup file for a GX |
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
| AC output power read 4294967294 W at times (bench) | The "out of range" marker was shown as a reading | Marker and reserved values dropped in every decoder |
| Light 5 and Buzzer both "ch 5" (bench) | The label was the first load listed, counted from 0 | The circuit's own load, counted from 1 |
| Instruments would follow the autopilot (Compass Rose) | Its state was read from the first load listed, which is Autopilot's | State from its own load |
| "SD card read-only" with a good card | The card was found but the `signalk` user could not write to it, and fixing that needed a login to the GX | Says "Card found but not writable" and offers a setup file to copy onto the card; no login |
| Empty circuit list under "Connected" | Signal K refused the plugin's data (no login at that address) and the page did not say so | Page says "Not logged in to Signal K" with a link |
| White screen from the plotter's Signal K tile | It opens Signal K's admin page, too modern for the plotter's browser | Our webapp served through `signalk-navico-embedder`; page script kept within that browser's syntax |
| Could not scroll on the plotter; a drag selected text | The plotter's touch arrives as mouse events | Drag-to-scroll and no text selection in the plotter layout |

## 8. Files

New files:

```
lib/monitor/index.js      monitor lifecycle, sender choice, values, routes
lib/monitor/catalog.js    ZCF -> monitored items, groups, circuit-temperature pairs
lib/monitor/currents.js   CZone output tables -> circuit current
lib/monitor/sensors.js    standard meter and sender PGN decoding
lib/monitor/fastpacket.js fast-packet reassembly
lib/monitor/storage.js    trend storage: two tiers, write-on-change, space guard
lib/monitor/venus-card.js builds venus-data.tgz, the card setup file for a GX
lib/monitor/venus/        the two scripts that go in it
lib/monitor/wire.js       candump listener for third-party devices
lib/victron/vedbus.js     minimal Victron D-Bus service
lib/victron/switches.js   CZone circuits as GX switchable outputs
lib/fork-mapping.js       state fallback, categories and groups, hidden circuits, a circuit's own loads
lib/zcf-circuits.js       structural circuit parser (with the hidden-duplicate rule)
lib/zcf-monitor.js        meters, meter settings, inputs
public/monitor.js         Monitoring tab and trend panel
public/monitor.css
docs/ZCF-FORMAT.md        layouts, checked across the sample ZCFs
docs/venus-sdcard-rw.sh   a copy of the card script, for reading
test/                     10 new test files, 2 new ZCF fixtures
```

Changes to Matt's files:

| File | Lines | Change |
|---|---|---|
| `index.js` | +92, −4 | Create, start and stop the monitor; hand the switch pane the send functions and the decoded state; one call after `zcf.load()` to `fork-mapping`; `current`, `temperature` and `notShown` on `/circuits`; eight settings |
| `public/index.html` | +235, −16 | Monitoring tab; amps under ON; trend arrow; temperature chip; category list that follows the tab; icons for the new categories; circuit label shows the circuit's own load, numbered as the Configuration Tool does; "not logged in" message; chartplotter layout (styles, drawn icons, drag-to-scroll), which is about 150 of the added lines |
| `public/remoteEntry.js` | +101 | Controls for the eight settings; saved confirmation |
| `package.json` | +4, −1 | `dbus-native` dependency; the new tests in `npm test` |

## 9. Tests

`npm test` runs Matt's suite and the fork's, 22 files, all passing. The fork's tests use frames captured on the bench and on Compass Rose, and eight sample ZCFs (two bench, two Compass Rose, Meitaki, Persevere, Sel Citron, SugarShack).

The webapp pages are not covered by `npm test`. They were checked by hand in a current Chromium and, for the chartplotter layout, in Chromium 69.0.3494, the version the plotter runs: layout, drag scrolling of the list and of the left column, a drag from a button not switching it, a tap switching it, and the desktop page unchanged.

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
| Monitoring groups by DC type | yes | yes |
| No false AC power reading | fix not yet confirmed there | does not apply |
| Label shows the circuit's own load | not yet confirmed there | yes |
| Instruments state from its own load | does not apply | installed; not yet confirmed against the boat |
| Chartplotter tile (loads, live state, switching) | no plotter | yes (NSS evo3S) |
| Chartplotter touch layout and drag scrolling | no plotter | built and tested in Chromium 69; not yet installed |

The bench was updated on the evening of 3 October; rows marked "not re-checked" or "not yet confirmed" are still to be checked there. Both Cerbos have Tailscale, so either can be reached from the other site.

## 11. Load on the Cerbo

Measured on Compass Rose, plugin off against plugin on: Signal K at about 41 % and 45 % CPU, a difference smaller than the swing within either run. Idle stayed near 25 % and the load average near 4 both ways. The Cerbo is close to its limit with Signal K, Node-RED and the other apps; the plugin adds nothing measurable. A Cerbo GX MK3 is the comfortable choice for that kind of installation. The plugin has not been run on one.

The chartplotter view adds a second plugin, `signalk-navico-embedder`, which converts pages on the Cerbo as the plotter asks for them. After it was installed on Compass Rose, one Signal K start took about five minutes and saving its settings took minutes to take effect. Whether that repeats has not been measured.

## 12. Limits and open items

- **Matt's beta.22 restructure is not merged.** A clean-up pass of the fork is planned with that merge: one source of state for the pane, one way of choosing a sender, and the monitor's main file split up.
- **Our own copy of the circuit parser.** `lib/zcf-circuits.js` is Matt's structural parser plus the hidden-duplicate rule. Once his has the rule, ours can go.
- **Switch inputs** are listed but their state is not decoded.
- **Per-display permissions** are not respected: a circuit that only one display may switch off can be switched off from the webapp and the pane.
- **Pane order** is alphabetical; Victron has no setting for it.
- **The GX unit setting** reads empty on Compass Rose and is treated as °C. What it reads when set to Fahrenheit has not been seen.
- **Compass Rose:** the Victron DC instances were renumbered on 3 October (Start Battery 2, Alternator 4, Solar 7) and the Fridge temperature tag corrected, so each meter now has its own instance. House Battery (instance 0) is still sent by several devices; the plugin takes the BMS.
- **Signal K 2.27 admin page:** a plugin's settings sometimes will not reopen without a page refresh. This is a Signal K fault, fixed in 2.33.
- **Trends with no card.** On a GX, trends are off until there is a card, and the card needs the setup file. Keeping a short history on the GX's own storage, with a strict size limit, would make trends work with nothing at all; it was ruled out earlier to spare the internal flash. Open for a decision.
- **The card setup file** needs one run on a real GX (the bench) before it is relied on.
- **Which circuits to hide is not settled.** Today a circuit with no display among its controls is hidden. Matt wants his four solar-charger circuits shown; they have no controls at all. Two ways forward: he adds "All Display Interfaces" to them, or the rule becomes "hide when there are controls and none is a display; show when there are none". The second also brings back Meitaki's Audible Alarm, Cabin Fans and Cockpit USB and Sel Citron's Salon Air Conditioner. Waiting on Matt.
- **State of a group circuit.** SugarShack's Timed Port and Timed Stbd Water Heater share a status bit with the plain water heaters, so each pair shows on and off together. "On only when every load it drives is on" would separate them; not built, and it needs SugarShack to test.
- **Instruments on Compass Rose** now reads its own load. To be confirmed against what is physically on.
- **Chartplotter layout** is to be installed and tried on the plotter. Day and night mode and the trend panel's symbols are still to do.
- **Compass Rose network.** The plotter sat behind the PredictWind DataHub Pro, on a different network from the Cerbo, so no tile could reach it. For the test the Cerbo's cable was moved to the DataHub, which left the Cerbo on two networks and made `venus.local` unreliable from the laptop. A Teltonika TSW010 switch is to go on the RUT200's LAN port with the Cerbo and the plotter on it; then the embedder's IP override changes to the Cerbo's wired address, the plotter's address goes on the embedder's client list, and the Cerbo's Wi-Fi goes off.
- **Parked from the bench:** units from the ZCF, RGB circuits (an RGBW light is on order; it needs a Control X PLUS and a capture while the colour is changed), a Node-RED palette, the occasional current drop-out.

## 13. Before opening the pull request

- [ ] Leave `docs/HANDOVER-czone-signalk.md` and `docs/BRIEF-FOR-MATT.md` out. They are working notes and name customer boats.
- [ ] Merge Matt's latest `main` and do the clean-up pass.
- [ ] If his parser has the hidden-duplicate rule, use it and drop `lib/zcf-circuits.js`.
- [ ] Remove the two leftover `status-fallback` files on GitHub.
- [ ] Settle the hide rule with Matt.
- [ ] Decide whether the chartplotter layout goes in the pull request or follows it.
- [ ] Re-check on the bench and on Compass Rose.
