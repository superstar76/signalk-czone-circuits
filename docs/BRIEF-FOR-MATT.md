# signalk-czone-circuits — items for Matt

**From:** Matthew Duckett (CZone test bench and Compass Rose, both on a Cerbo GX, Venus OS 3.80, Signal K 2.27)
**Against:** `main` at `2744c45` (beta.22) and `signalk-czone-zcf` at `3f836e7` (beta.1)
**Date:** 3 October 2026 (replaces the 1 October version)

Ordered by impact. Each item has evidence and a suggested fix. None of these need our fork; they're all in your code. Every item was re-checked against the commits above on 3 October.

---

## 1. No circuit state on configurations without a status table (Compass Rose, Persevere)

**New, and the one that matters: it stops the plugin being usable on the boat.**

- **Symptom (Compass Rose):** every circuit shows OFF. Pressing a circuit in the webapp switches it on at the boat, the row shows "Sending…" for about 14 s, then drops back to OFF while the circuit stays on. The webapp can therefore only ever send ON, the Victron switch pane never changes, and nothing can be switched off from Signal K.
- **Cause:** `parseStatusTable` finds no status table in `Compass-Rose-28.06.26.zcf` or `Persevere-14.07.25.zcf` (`parsed.statusTable` is `null`; same in `signalk-czone-zcf` beta.1), so every circuit has `statusModule: null` and `decodeCzoneCircuitStatus` returns at the "no circuit maps to this module" check.
- **What the bus shows:** on these networks the 65284 bitmap is the module's output channels, bit n = channel n. Capture from Compass Rose, "Lights" (ZCF module 2, channel 4, circuit id `0x0F`) switched off at the display:

  ```
  1CFF0402  27 99 02 36 33 0E 01 00     module 02 before
  1CFF0003  27 99 0F 00 00 04 F2 00     display (dipswitch 04): Lights OFF
  1CFF0402  27 99 02 36 23 0E 01 00     module 02 after: bit 4 cleared
  1CFF0003  27 99 0F 00 00 04 40 00
  ```

  Decoding both modules' bitmaps that way gives a believable set of circuits on (Freezer, Freezer Temp Control, Fresh Water Pump, Fridge Temp Control, Toilet, VHF, Anchor Light, Lights). Note the status subtype byte here is `0x36`.
- **Suggested fix:** when the ZCF yields no status mapping for any circuit, fall back to `statusModule = module`, `statusBit = channel` (channels 0–31), marked as inferred. Use the circuit's own load for this, not the first one listed (see item 9, Instruments). Leave ZCFs that do have a status table alone (TestBench load masks).
- **Interim in our fork:** `applyStatusFallback` in `lib/fork-mapping.js` does exactly that, called once after `zcf.load()` in `loadConfiguredZcf`; `test/fork-mapping.test.js` replays the frames above. Drop it when the parser covers this.
- **Also seen in that capture:** the plugin's own commands go out correctly (`1CFF0065  27 99 0F 00 00 03 F1 08` then `… 40 08`, device id 3). The display uses its own dipswitch (04) and trailer `00`.

## 2. Control X PLUS sends current and level in PGN 130825, not 130822

**New. Affects `signalk-czone` (current) and brightness/level in `signalk-czone-circuits`.**

- **Symptom (Compass Rose, two Control X PLUS, no CZone display):** no circuit current at all. In ten minutes there is not one `27 99` frame on 130822 or 130817. (The only 130822 traffic is Navico's, `13 99`, from the MFD.)
- **Where it is:** PGN 130825, a 27-byte fast packet from each module, pages 0–2 cycling about every 2 s, sent without any display or request:

  ```
  27 99 <module> <page> 00  + 8 records of 22 bits, least significant bit first
      bits 0–10   current, 0.1 A
      bits 11–21  level: 0 = off, 1000 = on
  record n on page p = output channel p*8 + n
  ```

- **Evidence:** "Lights" (module 2, channel 4) switched on and off changes only record 4 of module 02 page 0:

  ```
  off  27 99 02 00 00 | 00 40 1F 00 D0 17 00 00 00 00 00 00 00 40 00 D0 07 00 00 00 00 00
  on   27 99 02 00 00 | 00 40 1F 00 D0 17 00 00 00 00 00 05 40 5F 00 D0 07 00 00 00 00 00
  ```

  → level 0 / 0 A and level 1000 / 0.5 A. Every record with level 1000 matches a bit set in that module's 65284 bitmap (module 02: channels 0, 1, 4, 5, 9, 10, 11, 13, 16; module 01: 2, 3, 16), and the loads are believable (Freezer 3.0–3.1 A, water pump on but idle 0 A, anchor light 0.1 A).
- **Confirmed on the boat:** with this decoded, Lights reads 0.4–0.5 A with one light on and 1.7–1.9 A with four.
- **Notes:** a record that is off can still carry a raw current of 1 (0.1 A), so treat level 0 as 0 A, as with the Output Interface. Your fast-packet reassembler only accepts 130817/130822, so 130825 needs adding there too.
- **In our fork:** `lib/monitor/currents.js` decodes it (`decodePackedTable`); `test/control-x-plus.test.js` has the captured payloads.

## 3. Circuit categories, virtual-switch circuits and circuits not on a display

**New. Both come from Matthew using the plugin on Compass Rose.**

- **Grouping:** DC / AC is the circuit *type*; the sub-category is what circuits should be grouped under. Fridge and freezer circuits showed only as "DC" because their sub-category has no name in the parser.
- **All the sub-category bits**, in the order the Configuration Tool's circuit dialog lists them. Flags are the u32 at record + 10, the category word is the u16 at record + 14:

  | Flags bit | Name | Flags bit | Name |
  |---|---|---|---|
  | 16 `0x00010000` | House/Habitat | 24 `0x01000000` | Engine Management |
  | 17 `0x00020000` | Vessel Critical | 25 `0x02000000` | Fans/Ventilation |
  | 18 `0x00040000` | Navigation | 26 `0x04000000` | Lighting |
  | 19 `0x00080000` | Electronics | 27 `0x08000000` | Vessel Management |
  | 20 `0x00100000` | 24-Hour Circuits | 28 `0x10000000` | Pumps |
  | 21 `0x00200000` | Communications | 29 `0x20000000` | Propulsion Management |
  | 22 `0x00400000` | Accessories | 30 `0x40000000` | Power |
  | 23 `0x00800000` | Indicators and Alarms | 31 `0x80000000` | Refrigeration |

  | Category word bit | Name |
  |---|---|
  | 0 `0x0001` | Entertainment |
  | 1 `0x0002` | Climate |
  | 2 `0x0004` | Appliances |
  | 3 `0x0008` | Other |
  | 4, 5, 6 | Favourites, DC, AC (as you have them) |
  | 7 to 11 `0x0080`…`0x0800` | User Definable Circuit Display Category 1 to 5 |
  | 13 `0x2000` | Bilge Pumps |

- **How sure:** ticked in the Configuration Tool and checked against the file: House/Habitat (Compass Rose "LPG"), Refrigeration, Bilge Pumps, plus the six you already had. The rest follow from the dialog order, and every circuit in the seven sample files fits (bit 21: VHF, Router, Starlink; bit 23: buzzers; word bit 1: air conditioners, diesel heaters; word bit 2: washing machine, receptacles). No sample uses any other bit. Bilge Pumps is confirmed too: Matthew ticked it on Compass Rose's two bilge pumps (ZCF of 3 Oct) and they are the only circuits with word bit 13, with no other category bit. With that, every category in the dialog is located.
- **User-defined category names** are in the file: a small block straight after the backlight-zone table (the second `u32 length` table after the vessel name): `u8 blockLength`, then five `u8 n | name` strings, then one byte. Meitaki: Winches, Furlers, Lithium (its winch circuits have word bit 7, furlers bit 8, lithium bit 9). Sel Citron: Telecommunications (routers, bit 7). Five empty strings in the other five files. So there are never more than five, and a configuration never has more than 26 sub-categories.
- **One group where only one fits** (the Victron switch pane shows a switch in one group): we take the first ticked category in this order: user-defined 1 to 5, Indicators and Alarms, Navigation, Refrigeration, Bilge Pumps, Pumps, Lighting, Fans/Ventilation, Climate, Entertainment, Appliances, Electronics, Communications, Engine Management, Propulsion Management, Power, Vessel Management, Accessories, House/Habitat, Vessel Critical, 24-Hour Circuits, Other. Nothing ticked: DC or AC. The webapp keeps listing a circuit under every category it is ticked in, as a CZone display does.
- **Virtual-switch circuits should be hidden.** Virtual switch *n* of a module is output channel `31 + n` (VS 01 = 32, VS 06 = 37, VS 10 = 41). A circuit whose outputs are all on channel 32 or above only drives virtual switches: Compass Rose's "Fridge 4/6/8 °C", "Freezer 4/-12/-18 °C" and "Test VS", and Sel Citron's two "VS - HWC" circuits. A circuit that also drives a real output ("Freezer": channel 2 and VS 01) is a real circuit. No names involved.
- **Circuits that are not on any display should not be listed** (the "any display interface" rule from our chat on 3 Oct). Your parser already decodes each circuit's controls. A circuit is on a display when one of them is module `0` ("All Display Interfaces"), a module of type 16 (Display Interface, Touch, chartplotter) or type 17 (Wireless Interface). "All Display Interfaces" alone is not enough: Meitaki puts 84 controls on "Display Companionway" by name, and Sel Citron uses the touch screen and the Wireless Interface separately. What the rule leaves out in the samples:

  | File | Not on any display |
  |---|---|
  | Compass Rose | Freezer / Fridge Temp Control, the two "Bilge Pump Running" indicators, High Bilge Water Alarm to Cerbo, E/R Blower |
  | SugarShack | Wireless Relay Button 1 to 4 (their only control is a switch input on COI 04, so the rule already handles the remote), the four "Solar … Charger CHG" |
  | Persevere | six "Bilge Pump Running", Buzzer, Ignition Circuit, Spare 1 to 6, and four more switched only by inputs |
  | Sel Citron | the buzzers, the four keypad "Arch Light … Seq" steps, BMS Warning Light, and five more |
  | Meitaki | five (three with no controls at all) |
  | Bench | none |

  We keep them in the mapping, so their state still goes to Signal K, and leave them out of the webapp list and the Victron pane (setting "Show circuits that are not on any CZone display", default off). Running on Compass Rose since 3 Oct: the six circuits are gone from both, everything else is unchanged.
- **In our fork:** `lib/fork-mapping.js` (`prepareMapping`, called once after `zcf.load()`) names every category, reads the user-defined names, sets `circuit.group`, hides virtual-switch circuits (setting "Show virtual switch circuits", default off) and applies item 1's state fallback. `test/fork-mapping.test.js` covers it on all seven files.

## 4. `getPgnFromCanId` ignores the data-page bit for standard PGNs

- **Symptom:** any PGN with DP = 1 outside the CZone `0xFFxx` range comes out wrong.
- **Evidence:**

  | CAN ID | Expected PGN | Returned |
  |---|---|---|
  | `0x09FD0865` | 130312 (temperature) | 64776 |
  | `0x19F21409` | 127508 (battery status) | 61972 |
  | `0x19F30309` | 127747 (AC phase A) | 62211 |

- **Fix:** `pgn = (dp << 16) | (pf << 8) | (pf >= 240 ? ps : 0)` with `dp = (canId >>> 24) & 1`. Keep your special case that maps CAN `0xFF04` to 65284.
- **Impact today:** none on circuit control, but anything you decode beyond CZone PGNs will be misidentified.

## 5. Structural parser: hidden duplicate circuits not dropped

- **Symptom:** Meitaki lists **Audible Alarm** three times (IDs 1, 2 and 32). The Configuration Tool shows it once.
- **Cause:** the circuit-table parser (now in `signalk-czone-zcf`) is based on an earlier version of our parser, without the `internal` rule. A circuit with **no controls** that shares its name with a circuit that **has** controls is an internal helper (Meitaki IDs 1 and 2 beside the user-facing 32).
- **Fix:** add `markInternalDuplicates` from our `lib/zcf-circuits.js` and classify those records as `kind: 'internal'`. Our `test/zcf-circuits.test.js` checks the exact Configuration Tool circuit list for TestBench, Compass Rose, Meitaki, Sel Citron and SugarShack. It passes against our parser; `signalk-czone-zcf` beta.1 still returns three Audible Alarm circuits for Meitaki.

## 6. Meters: instance and DC type are in the settings tables

Only matters if you start using meters (we use them for monitoring in the fork).

- **Layout:** the Meters table record is `[ac][meterId][module][nameLen][name]`. The list byte is a meter id, not the NMEA instance.
- **Where the instance is:** in two tables straight after it, DC (record size 86 or 92) then AC (65). Each record starts `[nmeaInstance][meterId][module]`.
- **Evidence, bench (1 Oct ZCF):**
  - Victron Shunt has meterId 1 but instance **2**. The Cerbo sends PGN 127508 on instance 2, and the Configuration Tool shows 2.
  - 5V System - MI has meterId 1 and instance 1. The Meter Interface sends instance 1.
- **DC type (new):** byte 28 of the DC settings record. Low nibble = the NMEA 2000 DC type (0 battery, 1 alternator, 2 converter, 3 solar cell), high nibble = nominal voltage (1 = 12 V, 2 = 24 V). `0x13` on every meter named Solar in the samples (Compass Rose, Meitaki, Persevere, four on SugarShack), `0x11` on SugarShack's alternators, `0x12` on "12V DC" and "5V System - MI", `0x20` on the 24 V thruster batteries.
- **Why it matters (Compass Rose, 3 Oct):** instance alone does not identify a third-party meter. Battery instance 0 is sent by five devices (BMS, shunt, inverter/charger, MPPT battery side, DC-DC converter). Instance 1, which the ZCF calls "Solar", is sent by three: the shunt's aux input (12.6 V), the converter (12.6 V, 0 A) and the MPPT's array side (81 V, 6.5 A). Only the MPPT declares instance 1 as "solar cell" in PGN 127506. Matching the ZCF's DC type to the type in 127506 picks the right one with nothing to configure. For a battery, the device that reports state of charge wins.
- **Confirmed on the boat (3 Oct):** with nothing configured beyond the ZCF upload, House Battery follows the BMS and Solar shows the MPPT's array side (81.9 V, 6.4 A). The MFD, which goes by instance alone, shows 12.6 V for Solar: a mix of the three devices on instance 1.
- **Module `0xFF`** (Persevere: Start Battery, Bow Thruster Battery) is not a module on the network; we treat it like module 0 (any sender). Not verified on that boat.
- **Coverage:** all DC and AC meters in all sample files resolve this way. `test/dc-meters.test.js` replays the Compass Rose frames.

## 7. PGN 130817 isn't used for levels

- **Symptom:** `decodeDcStatePacket` returns early unless the PGN is 130822.
- **Evidence:** the bench **Output Interface** (a DC module) sends its output table as **130817**, with the header the other way round: `27 99 <page> <module>`.
- **Impact:** brightness and level telemetry from Output Interfaces (and ACOIs) is ignored. 65284 still gives on/off, so control and state work.
- **Fix:** accept both PGNs, swapping byte 2/3 for 130817. Your `decodeCzoneHeader` already does this.
- **Related:** on the bench OI the current byte reads 1 (0.1 A) on every output, **on or off**. Treat level `0x0400` as 0 A.

## 8. Signal K PUT on `electrical.czone.<slug>.switch.state`

- **Symptom:** a PUT issued in-process with `app.putSelfPath('electrical.czone.Light_1.switch.state', true)` was accepted but **didn't switch the circuit**. Calling `sendCircuitState()` directly does.
- **Status:** not fully diagnosed. It may be how Signal K routes a PUT to a handler registered with a source (`PLUGIN_ID`).
- **Worth testing:** a PUT via REST, `PUT /signalk/v1/api/vessels/self/electrical/czone/Light_1/switch/state` `{"value": true}`, since other apps (KIP, Node-RED) would use that.

## 9. Smaller points from this week

**New. None is urgent; the first three are changes we made in your files that you may want.**

- **Settings panel gives no sign that it saved.** Every control saves as it is changed and Signal K restarts the plugin, but nothing says so. In our fork `public/remoteEntry.js` has a line under the heading ("Changes on this page are saved as you make them") and a green "Saved" notice for a few seconds after each change.
- **Category list in the webapp.** It listed every category on every tab. In our fork `public/index.html` lists only the categories of the circuits in the current tab (AC, DC, In Use, Favorites), with counts for that tab, and a category narrows the tab instead of leaving it; a second click clears it.
- **A circuit's module/channel is the first load listed, which can be another circuit's.** `parseCircuitRecords` takes `record.outputs[0]`. On the bench, Light 5 lists the Buzzer's output (DC6) ahead of its own (DC5), so Light 5 and Buzzer both read "module 01 / ch 5" in the webapp. On Compass Rose, Instruments lists Autopilot's output first, then its own and VHF's. In our fork `ownLoads` in `lib/fork-mapping.js` drops any load that is another circuit's only output; what is left is the circuit's own (`ownOutputs`), and a circuit left with nothing is a group (SugarShack "All Lights On"). We use it for three things: the webapp label (own loads only, numbered from 1 as the Configuration Tool does, so Buzzer "ch 6" and Light 5 "ch 5"; the other loads go in the hover text, and a group shows nothing, like a Mode), circuit current, and the inferred state of item 1 (Instruments was reading Autopilot's bit).
- **Logging cost.** `log()` builds its message even when debug is off. One 65284 status frame on Compass Rose produces about 25 messages (2.4 KB of strings), a few times a second. Cheap, but constant on a Cerbo; a debug-enabled check before building the string would remove it.
- **Every bus frame is fully parsed** by `parseRawLine` before its PGN is looked at (our monitor's own listener does the same; that goes in our clean-up). About 1 µs per frame on a desktop. Reading the PGN from the CAN id first would skip the data parsing for everything that is not CZone.
- **For information, not yours:**
  - **Load:** on Compass Rose's Cerbo, Signal K sits at about 40 to 45 % CPU with the plugin off or on; the difference is within the noise. The Cerbo is near its limit with Signal K, Node-RED and the other apps, not because of the plugin.
  - **Signal K 2.27 admin page:** a plugin's settings sometimes will not reopen without a page refresh. It is a stale click handler in the admin UI's plugin list, fixed by 2.33.

## 10. Earlier items, for completeness

- **Modes vs group circuits (SugarShack):** "All Lights On", "Welcome Home" and so on are ordinary multi-output circuits in the file. The four real Modes are the category-0 records.
- **`signalk-czone` current mapping:** it was mapping currents to the previous circuit's output (old parser). Commit `e67c29d` moved it to the structural parser, which should fix it; not yet re-checked live. Our fork decodes circuit current inside `signalk-czone-circuits` (see `FORK-CHANGES.md`), which may be useful when you combine the two projects.

## Already fixed in beta.22, thanks

- The "Alarm" circuit category (`Alarms: 0x00800000`).
- Tests no longer read sample files from `/mnt/data`.
