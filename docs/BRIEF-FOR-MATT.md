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
- **Suggested fix:** when the ZCF yields no status mapping for any circuit, fall back to `statusModule = module`, `statusBit = channel` (channels 0–31), marked as inferred. Leave ZCFs that do have a status table alone (TestBench load masks).
- **Interim in our fork:** `lib/status-fallback.js` does exactly that, called once after `zcf.load()` in `loadConfiguredZcf`; `test/status-fallback.test.js` replays the frames above. Drop it when the parser covers this.
- **Also seen in that capture:** the plugin's own commands go out correctly (`1CFF0065  27 99 0F 00 00 03 F1 08` then `… 40 08`, device id 3). The display uses its own dipswitch (04) and trailer `00`.

## 2. `getPgnFromCanId` ignores the data-page bit for standard PGNs

- **Symptom:** any PGN with DP = 1 outside the CZone `0xFFxx` range comes out wrong.
- **Evidence:**

  | CAN ID | Expected PGN | Returned |
  |---|---|---|
  | `0x09FD0865` | 130312 (temperature) | 64776 |
  | `0x19F21409` | 127508 (battery status) | 61972 |
  | `0x19F30309` | 127747 (AC phase A) | 62211 |

- **Fix:** `pgn = (dp << 16) | (pf << 8) | (pf >= 240 ? ps : 0)` with `dp = (canId >>> 24) & 1`. Keep your special case that maps CAN `0xFF04` to 65284.
- **Impact today:** none on circuit control, but anything you decode beyond CZone PGNs will be misidentified.

## 3. Structural parser: hidden duplicate circuits not dropped

- **Symptom:** Meitaki lists **Audible Alarm** three times (IDs 1, 2 and 32). The Configuration Tool shows it once.
- **Cause:** the circuit-table parser (now in `signalk-czone-zcf`) is based on an earlier version of our parser, without the `internal` rule. A circuit with **no controls** that shares its name with a circuit that **has** controls is an internal helper (Meitaki IDs 1 and 2 beside the user-facing 32).
- **Fix:** add `markInternalDuplicates` from our `lib/zcf-circuits.js` and classify those records as `kind: 'internal'`. Our `test/zcf-circuits.test.js` checks the exact Configuration Tool circuit list for TestBench, Compass Rose, Meitaki, Sel Citron and SugarShack. It passes against our parser; `signalk-czone-zcf` beta.1 still returns three Audible Alarm circuits for Meitaki.

## 4. Meters: list byte is a meter id, not the NMEA instance

Only matters if you start using meters (we use them for monitoring in the fork).

- **Layout:** the Meters table record is `[ac][meterId][module][nameLen][name]`.
- **Where the instance is:** in two tables straight after it, DC (record size 86 or 92) then AC (65). Each record starts `[nmeaInstance][meterId][module]`.
- **Evidence, bench (1 Oct ZCF):**
  - Victron Shunt has meterId 1 but instance **2**. The Cerbo sends PGN 127508 on instance 2, and the Configuration Tool shows 2.
  - 5V System - MI has meterId 1 and instance 1. The Meter Interface sends instance 1.
- **Coverage:** all DC and AC meters in all 8 sample files resolve this way. See `docs/ZCF-FORMAT.md` in our fork.

## 5. PGN 130817 isn't used for levels

- **Symptom:** `decodeDcStatePacket` returns early unless the PGN is 130822.
- **Evidence:** the bench **Output Interface** (a DC module) sends its output table as **130817**, with the header the other way round: `27 99 <page> <module>`.
- **Impact:** brightness and level telemetry from Output Interfaces (and ACOIs) is ignored. 65284 still gives on/off, so control and state work.
- **Fix:** accept both PGNs, swapping byte 2/3 for 130817. Your `decodeCzoneHeader` already does this.
- **Related:** on the bench OI the current byte reads 1 (0.1 A) on every output, **on or off**. Treat level `0x0400` as 0 A.

## 6. Signal K PUT on `electrical.czone.<slug>.switch.state`

- **Symptom:** a PUT issued in-process with `app.putSelfPath('electrical.czone.Light_1.switch.state', true)` was accepted but **didn't switch the circuit**. Calling `sendCircuitState()` directly does.
- **Status:** not fully diagnosed. It may be how Signal K routes a PUT to a handler registered with a source (`PLUGIN_ID`).
- **Worth testing:** a PUT via REST, `PUT /signalk/v1/api/vessels/self/electrical/czone/Light_1/switch/state` `{"value": true}`, since other apps (KIP, Node-RED) would use that.

## 7. Earlier items, for completeness

- **Modes vs group circuits (SugarShack):** "All Lights On", "Welcome Home" and so on are ordinary multi-output circuits in the file. The four real Modes are the category-0 records.
- **`signalk-czone` current mapping:** it was mapping currents to the previous circuit's output (old parser). Commit `e67c29d` moved it to the structural parser, which should fix it; not yet re-checked live. Our fork decodes circuit current inside `signalk-czone-circuits` (see `FORK-CHANGES.md`), which may be useful when you combine the two projects.

## Already fixed in beta.22, thanks

- The "Alarm" circuit category (`Alarms: 0x00800000`).
- Tests no longer read sample files from `/mnt/data`.
