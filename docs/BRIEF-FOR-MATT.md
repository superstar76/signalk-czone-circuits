# signalk-czone-circuits — items for Matt

**From:** Matthew Duckett (bench testing on a Cerbo GX, Venus OS 3.80, Signal K 2.27)
**Against:** `main` at `45c47d1` (beta.20)
**Date:** 1 October 2026

Ordered by impact. Each item has evidence and a suggested fix. None of these need our fork; they're all in your code.

---

## 1. "Alarm" circuit category isn't recognised

- **Symptom:** on the bench, changing the Buzzer from *Pump* to *Alarm* in the Configuration Tool removed its category tag in the webapp.
- **Evidence:** the Buzzer's subcategory bits in the circuit record:
  - as Pump: `0x18010000` (`0x10000000` = Pumps);
  - as Alarm: `0x00810000`, so **Alarm = `0x00800000`**.
- **Fix:** in `lib/zcf.js`, `ZONE_SUB_CATEGORY_BITS`:
  ```js
  Alarms: 0x00800000,
  ```
  Map it to the Safety icon in the webapp. The other Configuration Tool categories are probably single bits too; a ZCF with one circuit per category would pin them all down.

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
- **Cause:** your `lib/zcf-circuit-table.js` is based on an earlier version of our parser, without the `internal` rule. A circuit with **no controls** that shares its name with a circuit that **has** controls is an internal helper (Meitaki IDs 1 and 2 beside the user-facing 32).
- **Fix:** add `markInternalDuplicates` from our `lib/zcf-circuits.js` and classify those records as `kind: 'internal'`. Our `test/zcf-circuits.test.js` checks the exact Configuration Tool circuit list for TestBench, Compass Rose, Meitaki, Sel Citron and SugarShack. It passes against our parser and fails on Meitaki with yours.

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

## 7. Tests read customer files from `/mnt/data`

`bench-status`, `bench-state`, `state` and `config-network` look for `/mnt/data/TestBench.zcf` and `/mnt/data/SugarShack-20260927-01.zcf`, so they're always skipped elsewhere. Both files are in `test/fixtures/`; pointing the tests there makes them run everywhere.

## 8. Earlier items, for completeness

- **Modes vs group circuits (SugarShack):** "All Lights On", "Welcome Home" and so on are ordinary multi-output circuits in the file. The four real Modes are the category-0 records.
- **`signalk-czone` current mapping:** it was mapping currents to the previous circuit's output (old parser). Commit `e67c29d` moved it to the structural parser, which should fix it; not yet re-checked live. If our fork is merged, `signalk-czone-circuits` publishes circuit currents itself (see `FORK-CHANGES.md`) and `signalk-czone` isn't needed.
