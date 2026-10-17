# signalk-czone-circuits: the monitoring fork

What the fork adds to Matt Mitchell's plugin and what it changes, as of 15 October 2026.

**Fork:** `github.com/superstar76/signalk-czone-circuits`, branch `monitoring`
**Based on:** Matt Mitchell's `signalk-czone-circuits`, `main` at `45c47d1` (beta.20), merged in with no conflicts. His beta.22 restructure is not merged yet.
**State:** 15 October 2026 (evening). Matt's new plugin, `signalk-czone`, is on npm at 0.3.0-beta.13. From this work it now has confirm before on/off (#17), Control X PLUS current (#18), trends off by default (#24, from our #23) and the honest connection line (#25). The parser fixes are with him as `signalk-czone-zcf` #13. See section 13.
**Run on:** the CZone test bench and Compass Rose, both on a Cerbo GX with Venus OS 3.80 and Signal K 2.27, and both reachable remotely over Tailscale
**Size:** about 5,300 lines of new code in 20 new files (and three small shell scripts), 3,200 lines of new tests in 15 new test files with 4 new sample ZCFs, and about 980 lines added to six of Matt's files

## Summary

Matt's plugin reads a CZone configuration file (ZCF), lists the circuits in a webapp and switches them over NMEA 2000. The fork keeps all of that and adds seven things, all driven by the same ZCF with nothing set up by hand:

- **Monitoring:** every meter and sender in the CZone configuration, live, in a Monitoring tab.
- **Trends:** history for every monitored value and every circuit's current, kept on an SD card.
- **Circuit current and temperature:** amps per circuit, and the temperature that belongs to a circuit, shown with the circuit.
- **Victron switch pane:** the CZone circuits as switches on the GX touch screen, Remote Console and VRM.
- **A truer circuit list:** state on boats whose ZCF has no status table, every category named, and circuits that no CZone display would list left out.
- **On the chartplotter:** the webapp as a tile on a B&G / Simrad / Lowrance plotter, with a layout for its touch screen.
- **Third-party switches from CZone:** a Shelly, or any output in the Victron switch pane, switched from a CZone display through a virtual circuit, and kept in step both ways.

The rule throughout: once the ZCF is uploaded, the data should appear. Where the bus is ambiguous (several devices on one instance), the ZCF decides.

One addition is the installer's choice and not read from the ZCF: **confirm before turning off**, for the few circuits (a freezer, the instruments) that must not go off by a slip of a finger.

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
| Inputs | switch inputs | ON / OFF on a Signal Interface, a Combination Output Interface and a Control X PLUS |

- **Grouping:** a DC meter goes under its DC Type from the Configuration Tool, so a solar meter is under Solar and not under Batteries.
- **Switch inputs:** each shows ON or OFF, live, and is published at `electrical.czone.inputs.<name>.state`. The state comes from the status message of the module the switch is wired to (PGN 65284) and follows the switch itself, not the circuit it controls. It is trended like any other value: the chart shows the share of time the input was on. The module sends the message when an input changes, so a short press is caught (a tap on a momentary switch was, on the bench), and each change is stored in the trend at the moment it happens, not at the next ten-second sample. On the page, inputs have their own light update every second (the rest of Monitoring stays at five seconds), an input that is on is highlighted, and under its name the row says when it went on, or when it was last on and for how long. A press that was over before the page asked is shown as ON for a couple of seconds so it is not missed, and a trend that is open on that input reloads by itself. The times are kept in memory: after Signal K restarts they start again at the next operation (the trend keeps the history). The Average on a trend is now weighted by time for every value (rows are written on change, so they are not evenly spaced and a plain average of the rows was wrong: four 0.3-second taps in 25 seconds read 44 % on, now 5 %). Known limit: a value that changes more than about 400 times inside a chart of 48 hours or less is thinned by the server with a plain average, so the Average of such a chart is approximate. Worked out on the test bench on 6 October 2026 for a Signal Interface (five switches, one bit each at position 2 × input + 1, counting inputs from 0). A module also sends a separate input message (PGN 65308) as an input changes, with the same layout; the plugin reads both. A Combination Output Interface (COI) sends its inputs only in that message, numbered in its configuration from 16: input i is at bit 2 × (i − 16) + 1. Worked out from a capture Matt made on SugarShack on 27 September 2026 (all four COI inputs, each on and off). Signal K's parser reports PGN 65308 under another number, so the plugin recognises the message by its CAN identifier. A Control X PLUS carries its inputs in its status message (65284): outputs in the low 16 bits, then input i at bit i as numbered in the ZCF (inputs start at 16), or at bit i + 1 for an input wired to switch to negative. Worked out on Compass Rose on 15 October 2026, each input operated twice with the bus captured: Anchor Up (input 17) bit 17, Ignition (input 24) bit 24, High Bilge Water Alarm (input 18, to negative) bit 19. Only one input to negative was seen, so that rule rests on one example. Replaying the whole capture through the plugin gives exactly the operations made. An input on a kind of module not yet worked out says so on its row and shows no state, and if the module stops reporting the row goes back to NOT ON BUS within two minutes.
- **Live or not:** each row says LIVE or NOT ON BUS. A row that is not on the bus names the NMEA 2000 instance the ZCF expects ("Nothing is sending instance 3 on NMEA 2000"), which is the number to set on the sending device.
- **Looks:** built from the webapp's own classes, so it matches the circuit list. Group colours are CSS variables. A group heading carries a faint band of the accent blue and its rows are indented under it, so headings and rows are told apart at a glance.
- **Opening a trend:** a value box opens that value's trend, and the arrow at the end of the row opens the item's. The rest of the row does nothing, so a stray touch does not open a chart.
- **No false readings:** NMEA 2000 marks a field as "not available", "out of range" or "reserved" with its top values. None of them is shown as a reading; the last good value stays.

### 1.2 Trends

- **Off unless ticked:** under **Record trends** in the settings, as in Matt's plugin (#23). Off, nothing is sampled or written and no card is touched; live values are unchanged, and the values and arrows do not open charts. Many boats already send their data to a database (InfluxDB with Grafana).
- **What is recorded:** every live monitored value and every circuit's current.
- **Sampling:** every 10 seconds by default (setting: 5, 10, 15, 30 or 60 s), buffered and written once a minute.
- **Files:** plain CSV, no database, in two tiers per value:

  | Tier | File | Contents |
  |---|---|---|
  | Full detail | `<series>/<YYYY-MM-DD>.csv` | `time,value`, written when the value changes and at least every 10 minutes |
  | Summary | `<series>/summary/<YYYY-MM>.csv` | `bucket,min,avg,max` per 10 minutes, from every sample |

- **Retention:** kept until storage runs low. Then the oldest full-detail days go first and summaries last, so recording never stops. An optional setting caps full detail at 31, 90 or 365 days.
- **Where:** on a Victron GX, an SD card or USB stick only, never internal flash; with no card, nothing is written or held in memory. On other systems, the Signal K data folder. A "Trend folder" setting overrides both. Minimum card: 16 GB.
- **One file on the card for a GX, and no login.** Venus OS mounts a FAT card writable by root only, and Signal K runs as the `signalk` user, so the plugin can see a new card but not write to it. The plugin cannot change that itself. Venus OS, though, unpacks a file called `venus-data.tgz` from a card at boot and runs a hook from it. So when there is no card yet, or a card is found but not writable, the Monitoring tab says so and gives three steps: download `venus-data.tgz` from the link there, copy it onto the card with a computer, restart the GX. From then on the GX opens the card for Signal K at every start, including after a firmware update. Nobody has to log in to the GX.
  - **What the file does:** puts `sdcard-rw.sh` in `/data` and adds one line to `/data/rc.local` to run it at boot. The script mounts each FAT card or stick again with open permissions, stopping the VRM logger for the moment that takes, and does nothing when the card is already open.
  - **How far it is tested:** the archive, both scripts and the download are covered by `npm test` (the scripts in a dry run against mount tables copied from the bench). The original, simpler script was pasted in by hand on the bench Cerbo and works there. The file-on-the-card route itself has not yet been run on a GX.
  - **With no card at all** the pill says "No SD card or USB stick: trends off".
- **Chart:** an in-page panel with 1 h, 24 h, 7 d, 31 d, 90 d, 1 y or a custom from/to period; now/min/avg/max; a hover crosshair; gaps where data is missing. Periods over 48 hours draw the average with a min–max band, so short spikes stay visible.
- **Several values on one chart:** "Add value" puts any other trended value on the chart, up to five. Each unit gets its own scale; "Stacked" shows one plot per unit on the same time axis.
- **Earlier history:** data already on the card from the February plugin is read in place. Old folder names are matched automatically where possible; others are mapped in `aliases.json` in the trend folder. Compass Rose's history back to late September is readable this way.

### 1.3 Circuit current

- **Shown** under ON on each circuit's button in the webapp, and in the Victron switch label.
- **Trend:** the arrow beside ON/OFF opens that circuit's current trend. A trend opens at the top of the page whichever tab it is opened from.
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
- **A steady label:** each change of a switch's name makes the GX re-sort its lists and jump to the selected row. So a reading that only wobbles (1.9 A, 2.0 A, 1.9 A) no longer changes the label. A step of 0.2 A or half a degree shows at once, as do on and off; a smaller change shows once it has held for two minutes (current) or five (temperature). The GX's own current column is always exact.
- **Edits made on the GX are kept:** switch names, groups and types, and the device's own name.
- **The device list:** Settings > Devices lists each switch as "Name: label", so every switch's Name is "CZone": "CZone: Freezer (13.3 °C)", in A-Z order. (The circuit name showed it twice; a module and channel number meant nothing to most people.)

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
- **No flicker, and sliders stay put.** The lists (circuits, navigation, categories, Modes, Monitoring) are updated in place instead of being rebuilt on every live update. A dimmer slider follows the boat but is not pulled away while it is being moved.
- **Not logged in is said plainly.** When Signal K refuses the plugin's data, the page says "Not logged in to Signal K" and links to the login, instead of showing an empty list under "Connected". A login is kept per address, so `venus.local` and the IP address each need their own.
- **The connection line tells the truth.** It said "Connected" whenever the page had read the circuit list once, even with the live feed down, so a page could say Connected while nothing on it moved. It now says Connected only while the live feed is up. Otherwise: "Circuits loaded · connecting live updates…" before the feed has ever opened, and "Live updates lost · reconnecting… (circuits as of 10:36:46)" after it drops, with the time of the last read.
- **The category list follows the tab.** On AC, DC, In Use or Favorites, only the categories of the circuits in that tab are listed, with counts for that tab. A category narrows the tab; a second click clears it. On Monitoring the list is the monitoring groups.

### 1.7 Settings page

- **Saves as you go:** the page now says so, and confirms each save.
- **New settings:** see section 4.

### 1.8 Chartplotter view

A Navico plotter (B&G, Simrad, Lowrance) on the same Ethernet network as Signal K can show the webapp as a tile. The plotter's browser is Chromium 69 and cannot run Signal K's pages as they are, so the tile comes from another plugin, `signalk-navico-embedder`, which converts pages on the way through and supplies the login token.

- **Layout:** the page recognises the plotter (the plotter's own parameters on the address, or the embedder's token) and switches to a touch layout: larger rows and buttons, no banner, the category and status chips dropped, drawn icons in place of symbol characters the plotter's fonts lack. A desktop browser never sees it; `?layout=mfd` shows it for testing.
- **Scrolling:** the plotter's touch arrives as mouse events, so a drag selected text and nothing scrolled. Dragging the list or the left column now scrolls it, and the release is not taken as a tap. On the first try on the plotter the drag worked but lagged the finger by about a second. So drag positions are applied once per frame, redraws caused by live data wait while a finger is down, and the plotter styles were made cheap to draw (no shadows, gradients or transitions). With those the drag follows the finger well on Compass Rose. Page-up and page-down buttons were added as a fallback at the same time and removed again once the drag was confirmed.
- **Updates reach the plotter by themselves:** the plotter kept showing the page it first loaded until it was restarted. The page now checks once a minute whether its script has changed on the server and reloads once if so.
- **A readout for diagnosis:** five taps on the "Connected" line show the last input events the plotter sent, the frame time and the time to redraw the list. There is no other way to see inside that browser.
- **Compatibility:** the page's own script avoids syntax newer than that browser (the embedder converts separate script files but not the code inside a page).
- **Tested** on Compass Rose (Simrad NSS evo3S): the tile appears, the page loads with live state, and circuits switch from the plotter. The touch layout has since been seen on the plotter: it draws correctly and switching works, and drag scrolling works but is slow to follow the finger. Everything is also checked against a real Chromium 69 build driven by a simulated mouse, which cannot reproduce the plotter's speed.
- **Not done yet:** the plotter's day and night mode is not followed, and the trend panel's few remaining symbol characters have not been checked on the plotter.
- **Setting it up:** the plotter and the Signal K machine must be on the same network segment. In the embedder: the IP override set to that machine's wired address, the CZone Circuits app enabled, and an admin token (the plugin's own interface needs a login). On Compass Rose the embedder's own "Generate" button did not deliver a token; one made with `signalk-generate-token` and written into the embedder's settings did. Restrict the embedder's client list to the plotter's address, since the token carries admin rights.
- **The built-in Signal K tile is not this.** A GX running Venus OS Large advertises a Signal K tile to the plotter by itself, but it opens Signal K's admin page, which that browser cannot draw (a white screen on Signal K 2.27).

### 1.9 Confirm before turning off

Some circuits must not go off by a slip of a finger. Two cases raised it. On Compass Rose, Instruments powers the chartplotter, so turning Instruments off on the plotter takes the plotter with it, and it has to be brought back from a keypad. On Sel Citron, the cockpit freezers hold long-term stores and may not be opened for weeks, so a freezer turned off by accident is found too late; in his CZone configuration fridges and freezers can be turned on from any display but off only from the iPad.

The plugin cannot work out which circuits these are: the ZCF says which output a circuit drives, not what is wired to it. So they are nominated, one by one, in the plugin's settings. It is not a general rule; a circuit that is not nominated switches exactly as before.

- **Nominating:** under **Confirm before turning off** in the settings, a circuit is chosen from a list of the configuration's circuits. Nothing else is set.
- **In the webapp and on the chartplotter:** a nominated circuit carries a small padlock after its name. Turning it off brings up the question "Turn off Freezer?" and two buttons, **Keep on** and **Turn off**, and nothing else. Turning it on is never held up.
- **Against a double tap:** **Turn off** does not respond for the first half second, and the question appears in the middle of the screen, not under the finger. A tap outside the question, or Escape, keeps the circuit on.
- **Enforced by the plugin, not only the page:** an off request without the confirmation is refused (409), so a page that loaded before the circuit was nominated asks too.
- **Where no question can be asked:** the Victron switch pane and other Signal K apps (a PUT to the switch path) cannot ask. By default an off from them is not acted on and the pane's switch returns to on; turning on works. One setting lets them turn nominated circuits off after all.
- **Modes are not held up.** A Mode is switched often and on purpose, and a question answered by reflex protects nothing. What a Mode switches is the installer's choice: a freezer that must stay on is left out of the Mode in the CZone configuration, where every display and keypad then respects it too.
- **Not affected:** CZone's own keypads and displays.
- **Checked** in a current Chromium and in Chromium 69 (the plotter's version), and by the plugin's tests. Installed on Compass Rose on 4 October: the question appears in the webapp, and on the GX an off from the switch pane goes back to on at once. Still to be seen: the question on the plotter.

### 1.10 Third-party switches from CZone

A switch that is not on the CZone network (a Shelly, a GX relay, any output in the Victron switch pane) can be switched from a CZone display or keypad, with no switchbank and nothing extra on the bus.

- **In the CZone configuration:** add a virtual circuit for it (no output of its own) and put it on the display like any other circuit. A virtual circuit is held by a CZone module like any circuit: on the bench the Output Interface reports "Shelly Relay - Powerboard" as channel 6 of its status message, and a display press sends the usual command with the module answering.
- **In the plugin's settings,** under **Third-party switches:** choose that circuit, then either a Victron output (the list shows what the GX has, by the names given on the GX) or a Shelly by IP address and channel, with a **Test** button that asks the Shelly for its state. Then **Link**.
- **Both ways:** the switch follows the CZone circuit (display, keypad, webapp, plotter), and the circuit follows the switch when it is switched from anywhere else (the Victron pane, VRM, the Shelly app or its button). Switching the circuit back needs NMEA 2000 sending allowed.
- **Two routes, chosen per link:**
  - *Victron output, through the GX:* the plugin writes the output's state on the GX's D-Bus. Works for anything Venus OS lists as a switchable output, whatever made it. The service name carries the Shelly's MAC address, so renaming it on the GX does not break the link. Needs the plugin to run on the GX.
  - *Shelly, directly:* the plugin uses the Shelly's own local interface (`/rpc/Switch.Set`, `/rpc/Switch.GetStatus`). No GX needed, so it also works on a Pi. Shelly Gen2 or later, with no password; the address should be reserved in the router.
- **Rules, so the two sides never fight:** a side is acted on only when it changes, and only if the other side differs; the plugin's own change coming back is recognised and not passed on; at start, or when a side is first seen, nothing is switched: if the two sides differ the link shows "out of step" and the next real change on either side brings them together (taking the switch as right turned Instruments off on Compass Rose, because a GX relay comes back off after a reboot); a circuit nominated to confirm before turning off is never turned off by a link (the link shows "not switched off: this circuit asks before turning off" and does not retry), unless other apps are allowed to turn those circuits off; a change one side could not take (switch unreachable or refusing, sending off) is kept and tried again every 15 seconds; a switch that accepts a command but does not change is reported as "No confirmation" after 6 seconds, then tried again in its turn. The switch is read every 2 seconds; a CZone change is acted on as its status arrives.
- **The GX's own relays and I/O extender relays** are in the Victron list too (on Venus OS 3.80 the GX relays are switchable outputs of `com.victronenergy.system`). A relay the GX uses for something else (alarm relay, generator, tank pump, temperature) is listed greyed out with the reason, for example "GX internal relay 1 (used by the GX as alarm relay)", and cannot be picked. Only a relay set to Manual on the GX is offered. A linked relay whose function is later changed on the GX is not switched again; its link shows why. Outputs that are not on/off (a dimmer) are listed but cannot be picked. Seen on Compass Rose: relay 1 alarm relay, relay 2 manual.
- **Status in the settings:** each link shows in step (ON / OFF), out of step, waiting, or the error ("Not reachable: no answer", "the Shelly has a password set").
- **Not twice in the switch pane:** a linked circuit is left out of the plugin's own Victron switch pane, since the real output is already there.
- **Self-contained:** `lib/bridge/` has no CZone or Signal K code in it; it is given a way to read and write a circuit and the two drivers, so it can move to Matt's plugin as it is.
- **Tested** by the plugin's tests (the linking rules on a stand-in switch and circuit, both drivers against stand-ins, and the whole plugin with the bench configuration: a Shelly switched off brings a CZone OFF command for the virtual circuit). On the bench by hand: both Shelly commands, and the Victron output by `dbus` from the command line, before the plugin was written. Both routes then confirmed on the bench by Matthew on 13 October.

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
| Confirm before turning off (a list of circuits) | empty |
| Let the Victron switch pane and other apps turn those circuits off | off |
| Record trends | off |
| Trend folder | automatic |
| Trend sample rate | 10 seconds |
| Keep full-detail trend data for | as long as there is space |
| Third-party switches (a list of links: circuit, and a Victron output or a Shelly address and channel) | empty |

## 5. Signal K paths added

| Path | Value |
|---|---|
| `electrical.czone.<circuit>.current` | amps |
| `electrical.czone.<circuit>.temperature` | kelvin, where a temperature input is named after the circuit |
| `electrical.czone.inputs.<input>.state` | `true` / `false`: a switch input (Signal Interface, Combination Output Interface) |

Matt's `electrical.czone.<circuit>.switch.state` and `.switch.brightness` are unchanged. Meter and sender readings are held in the plugin for the Monitoring tab and trends; they are not published to Signal K.

## 6. Diagnostic pages

All under `/plugins/signalk-czone-circuits`.

| Page | Shows |
|---|---|
| `/monitor/items` | every monitored item with its live readings; circuit-temperature pairings |
| `/monitor/inputs` | the switch inputs alone: on or off, since when, last time on (asked for every second by the page) |
| `/monitor/bus` | what reaches the plugin from the bus; every device seen per reading; which device each DC meter was given and why |
| `/monitor/modules` | CZone module to NMEA 2000 address |
| `/monitor/debug?path=` | everything the plugin sees for one path |
| `/monitor/values` | current value of every trended series |
| `/trend/status` | where trends are stored, free space, sample rate |
| `/trend/card-setup` | downloads `venus-data.tgz`, the card setup file for a GX |
| `/trend?path=&range=` | a series' data |
| `/bridge/status` | each third-party switch link: both sides, in step or not, waiting on, last action, error |
| `/bridge/outputs` | the switchable outputs the GX has, as offered in the settings |
| `/bridge/shelly?host=&channel=` | asks a Shelly for its state (the settings' Test button) |
| `/victron/status` | the switch pane: circuits it has as on, any that disagree with the plugin, the GX's unit setting, recent requests |

## 7. Faults found and fixed along the way

| Fault | Cause | Fix |
|---|---|---|
| Meitaki's October 2026 file: state from the fallback, not the status table | The newer Configuration Tool writes status records one byte longer (18-byte header) | Both lengths read; 52 status records found, as before plus Clive's new circuits |
| Meitaki: three Signal K paths for one Audible Alarm, the real one `Audible_Alarm3` | Two internal copies (no controls, same name, kept by the Configuration Tool for its own logic) were hidden but still given paths | Internal copies dropped before paths are given out; the real circuit is `Audible_Alarm` |
| A link to a GX relay turned Instruments off after a reboot (Compass Rose) | At start the switch was taken as right, and the relay comes back off | Nothing is switched at start; the link waits for a real change |
| Meitaki's October 2026 file: no inputs or tanks found | A newer Configuration Tool writes input records 6 bytes shorter (no `00 00 00 00 ff ff` before the name), so the calibration count was missed and the table walk failed | The count is read from its place in the shorter layout too; all 51 inputs and 6 tanks found |
| "Connected" with the live feed down | The line was set by any successful read of the circuit list | Connected only while the live feed is up; otherwise says what is happening |
| COI inputs never changed (SugarShack) | A COI sends inputs only in PGN 65308, which Signal K's parser reports under another number | Recognised by CAN identifier; COI layout added |
| Every circuit off, only ON could be sent (Compass Rose) | ZCF has no status table | State from module and channel |
| No circuit current (Compass Rose) | Control X PLUS uses PGN 130825 | Decoder for the packed table |
| Switch pane all off after a restart | The pane read state back from Signal K and missed it | The pane takes state from the plugin's own decoded state |
| Signal K could crash when the plugin was stopped while starting | Unhandled error on a D-Bus connection closed mid-handshake | Error handled; overtaken starts end cleanly |
| "Solar" showed 12.6 V, 0 A | Three devices on DC instance 1; the wrong one was taken | Device matched by DC type |
| AC not shown | Boat's AC data is on PGNs 127503 / 127504 | Both AC styles decoded |
| Every name twice in the GX device list ("AFT Outlets: AFT Outlets") | The list shows "Name: label" and both were the circuit name | Name is "CZone" for every switch ("CZone: AFT Outlets") |
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
| The GX's Outputs list jumped about every few seconds | The label carried live amps, and every 0.1 A wobble renamed the switch, which makes the GX re-sort and jump to the selected row | Label held steady against small wobbles |
| A Signal K PUT to a switch path stopped working after any settings change, until Signal K was restarted | Signal K drops a plugin's PUT handlers when the plugin stops; the plugin remembered the paths as registered and registered none on the next start (found by Matt, 5 October) | The record is cleared on stop, so every start registers the handlers again |
| ON buttons flickered every few seconds (seen on the plotter) | Every list was rebuilt whole on each live update, and the amps under ON change constantly | Lists are updated in place: a changed reading changes one piece of text |

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
lib/confirm-off.js        circuits nominated to confirm before off
lib/bridge/index.js       third-party switches: linking rules (self-contained)
lib/bridge/shelly.js      Shelly driver (local RPC over HTTP)
lib/bridge/victron.js     Victron switchable output driver (GX D-Bus)
lib/fork-mapping.js       state fallback, categories and groups, hidden circuits, a circuit's own loads
lib/zcf-circuits.js       structural circuit parser (with the hidden-duplicate rule)
lib/zcf-monitor.js        meters, meter settings, inputs
public/monitor.js         Monitoring tab and trend panel
public/monitor.css
docs/INSTALL-AND-USE.md   installation and use, for the person fitting or using the plugin
docs/ZCF-FORMAT.md        layouts, checked across the sample ZCFs
docs/venus-sdcard-rw.sh   a copy of the card script, for reading
test/                     14 new test files, 3 new ZCF fixtures
```

Changes to Matt's files:

| File | Lines | Change |
|---|---|---|
| `index.js` | +242, −5 | Create, start and stop the monitor; hand the switch pane the send functions and the decoded state; one call after `zcf.load()` to `fork-mapping`; `current`, `temperature` and `notShown` on `/circuits`; confirm before off (the off route, PUT handlers, the pane's send functions); third-party switch links (start, stop, routes, a hook in status decoding); eleven settings |
| `public/index.html` | +445, −29 | Monitoring tab; amps under ON; trend arrow; temperature chip; category list that follows the tab; icons for the new categories; circuit label shows the circuit's own load, numbered as the Configuration Tool does; "not logged in" message; chartplotter layout (styles, drawn icons, drag-to-scroll, self-reload, diagnostic readout); lists updated in place; the confirm-before-off question and padlock; a connection line that says Connected only while the live feed is up |
| `public/remoteEntry.js` | +256 | Controls for the eleven settings, including the list of circuits that confirm before off and the third-party switch links with their status; saved confirmation |
| `package.json` | +4, −1 | `dbus-native` dependency; the new tests in `npm test` |

## 9. Tests

`npm test` runs Matt's suite and the fork's, 27 files, all passing. The fork's tests use frames captured on the bench and on Compass Rose, and nine sample ZCFs (three bench, two Compass Rose, Meitaki, Persevere, Sel Citron, SugarShack).

The webapp pages are not covered by `npm test`. They were checked by hand in a current Chromium and, for the chartplotter layout, in Chromium 69.0.3494, the version the plotter runs: layout, drag scrolling of the list and of the left column, a drag from a button not switching it, a tap switching it, the desktop page unchanged, and the confirm-before-off question (asked, kept on, turned off, and a page that did not know the circuit was nominated). The settings panel's new sections were rendered and exercised in a current Chromium, and the connection line was driven through a live feed refused, opened, dropped and restored.

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
| Chartplotter touch layout | no plotter | yes |
| Chartplotter scrolling by drag | no plotter | yes |
| No flicker of ON buttons on the plotter | no plotter | yes |
| Updates reach the plotter without a restart | no plotter | yes |
| Confirm before turning off | not installed | yes in the webapp and the switch pane; plotter not yet |
| Switch inputs, Signal Interface | yes (65284 and 65308) | does not apply |
| Switch inputs, COI | no COI; decoded from Matt's SugarShack capture | does not apply |
| Switch inputs, Control X PLUS | does not apply | yes (15 October): Anchor Up, Ignition, bilge float |
| Connection line | installed 13 October | installed 15 October |
| Third-party switch, Victron output | yes (13 October) | yes, GX relay 2 (15 October); relay 1 (alarm relay) refused as it should be |
| Third-party switch, Shelly direct | yes (13 October) | no Shelly on board |
| Link safety (nothing switched at start, confirm-before-off) | tests only | installed 15 October; not yet seen in use |
| Record trends checkbox | tests and browser only | installed 15 October, ticked |
| GX Outputs list steady against small wobbles in current | not yet confirmed there | yes (still moves on a change of 0.2 A or more, which renames the switch) |

The bench was updated on the evening of 3 October; rows marked "not re-checked" or "not yet confirmed" are still to be checked there. Both Cerbos have Tailscale, so either can be reached from the other site.

## 11. Load on the Cerbo

Measured on Compass Rose, plugin off against plugin on: Signal K at about 41 % and 45 % CPU, a difference smaller than the swing within either run. Idle stayed near 25 % and the load average near 4 both ways. The Cerbo is close to its limit with Signal K, Node-RED and the other apps; the plugin adds nothing measurable. A Cerbo GX MK3 is the comfortable choice for that kind of installation. The plugin has not been run on one.

The chartplotter view adds a second plugin, `signalk-navico-embedder`, which converts pages on the Cerbo as the plotter asks for them. After it was installed on Compass Rose, one Signal K start took about five minutes and saving its settings took minutes to take effect. Whether that repeats has not been measured.

## 12. Limits and open items

- **The fork stays on Matt's old plugin.** It will not be merged as a whole. Its features go to Matt's new plugin (`signalk-czone`, on npm) one pull request at a time, rebuilt to fit his code (section 13). Once the ones that matter are in, Compass Rose and the bench move to his plugin.
- **Trend storage, two fixes to bring back from Matt.** His review of #23 found that a custom trend folder could get round the GX "card or stick only" rule, and that card detection could stay cached after a card is removed. Fixed in his #24; the fork's trend code has the same origin and needs the same two fixes.
- **Overview page:** an idea for a power overview tab, worked to a second mock-up and parked (separate write-up, 15 October). No code.
- **Our own copy of the circuit parser.** `lib/zcf-circuits.js` is Matt's structural parser plus the hidden-duplicate rule. Once his has the rule, ours can go.
- **Control X PLUS inputs wired to negative** are read one bit above their number, from a single example (Compass Rose's bilge float). A second input to negative on another boat would confirm it.
- **Third-party switches:** a Shelly with a password is not supported yet (digest login). A Shelly Gen1 is not supported. Dimmers and other non-on/off outputs are not linked, only on and off.
- **Per-display permissions** are not respected: a circuit that only one display may switch off can be switched off from the webapp and the pane. Confirm before turning off (section 1.9) covers the common case by hand: the installer nominates the circuits.
- **Pane order** is alphabetical; Victron has no setting for it.
- **The GX unit setting** reads empty on Compass Rose and is treated as °C. What it reads when set to Fahrenheit has not been seen.
- **Compass Rose:** the Victron DC instances were renumbered on 3 October (Start Battery 2, Alternator 4, Solar 7) and the Fridge temperature tag corrected, so each meter now has its own instance. House Battery (instance 0) is still sent by several devices; the plugin takes the BMS.
- **Signal K 2.27 admin page:** a plugin's settings sometimes will not reopen without a page refresh. This is a Signal K fault, fixed in 2.33.
- **Trends with no card.** On a GX, trends are off until there is a card, and the card needs the setup file. Keeping a short history on the GX's own storage, with a strict size limit, would make trends work with nothing at all; it was ruled out earlier to spare the internal flash. Open for a decision.
- **The card setup file** needs one run on a real GX (the bench) before it is relied on.
- **Which circuits to hide is not settled.** Today a circuit with no display among its controls is hidden. Matt wants his four solar-charger circuits shown; they have no controls at all. Two ways forward: he adds "All Display Interfaces" to them, or the rule becomes "hide when there are controls and none is a display; show when there are none". The second also brings back Meitaki's Audible Alarm, Cabin Fans and Cockpit USB and Sel Citron's Salon Air Conditioner. Waiting on Matt.
- **State of a group circuit.** SugarShack's Timed Port and Timed Stbd Water Heater share a status bit with the plain water heaters, so each pair shows on and off together. "On only when every load it drives is on" would separate them; not built, and it needs SugarShack to test.
- **Instruments on Compass Rose** now reads its own load. To be confirmed against what is physically on.
- **Chartplotter layout:** day and night mode and the trend panel's symbols are still to do.
- **Confirm before turning off** is still to be tried on the plotter.
- **Compass Rose network.** The plotter sat behind the PredictWind DataHub Pro, on a different network from the Cerbo, so no tile could reach it. For the test the Cerbo's cable was moved to the DataHub, which left the Cerbo on two networks and made `venus.local` unreliable from the laptop. A Teltonika TSW010 switch is to go on the RUT200's LAN port with the Cerbo and the plotter on it; then the embedder's IP override changes to the Cerbo's wired address, the plotter's address goes on the embedder's client list, and the Cerbo's Wi-Fi goes off.
- **Parked from the bench:** units from the ZCF, RGB circuits (an RGBW light is on order; it needs a Control X PLUS and a capture while the colour is changed), a Node-RED palette, the occasional current drop-out.

## 13. Getting this into Matt's plugin

Features go to Matt's new plugin (`mattsmitchell/signalk-czone`) as separate pull requests, each rebuilt on his current `main`, never the fork wholesale. Pull requests come from `superstar76/signalk-czone` (the plugin) and `superstar76/signalk-czone-zcf` (the parser).

| Feature | Where it is |
|---|---|
| Confirm before turning on or off | In his plugin: #17 (Matt's, from our #16) |
| Control X PLUS circuit current (130825) | In his plugin: #18 |
| Trends, off unless ticked | In his plugin: #24 (Matt's, from our #23, with GX storage protections), beta.10 |
| Connection line says Connected only while live | In his plugin: #25, beta.12 |
| Newer Configuration Tool files; tank settings from their own record; internal copies | Parser pull request #13, waiting for Matt. Then his plugin moves to that parser version (Meitaki 109 -> 107 circuits) |
| Switch inputs (Signal Interface, COI, Control X PLUS) | Built and tested; sent once parser #13 and #28 are merged |
| Third-party switches (Shelly, Victron outputs, GX relays, link safety, Node-RED virtual switches) | Pull request #28, waiting for Matt |
| Chartplotter fixes (`??` twice and 15 flex `gap` rules in beta.13) | Pull request #29, waiting for Matt |
| Chartplotter touch layout | Discuss with Matt first |
| Victron switch pane (with the CZone location as each switch's Name); third-party sensor listener | Ask Matt whether he wants them |
| Monitoring extras; a circuit's own load | Compare with his monitoring and his #22 / #26 first |
| Hidden circuits rule; favourites on the server | Waiting on Matt's decisions |

Never sent: `docs/HANDOVER-czone-signalk.md` and `docs/BRIEF-FOR-MATT.md` (working notes that name customer boats). `docs/INSTALL-AND-USE.md` names no boats and can go with the features it describes.
