# ZCF circuit table: structural parser

`lib/zcf-circuits.js` reads the ZCF circuit table by its own length and count
fields instead of scanning for byte signatures, so no circuit type is skipped and
a mis-parse can't silently drop records.

## Validation

| ZCF | Current `parseCircuitRecords()` | Structural (circuits + modes / all records) | Ground truth |
|---|---|---|---|
| TestBench | 5 | **6** / 6 | Config Tool: 6 circuits. IDs 05–0A switched live on the bus |
| Compass Rose | 21 | **35** / 44 | Config Tool: 35 circuits; channel + module of all 26 physical/VS loads match the Loads tab |
| SugarShack | 108 | 110 + 4 modes / 115 | Mode IDs 4E / 53 / 4D / 56 match live captures |
| Meitaki | 103 | **107** + 8 modes / 131 | Config Tool: 115 = 107 circuits + 8 Modes, exact name match. Module + channel correct for 38/38 loads on 16 OIs |
| Persevere | 59 | 58 / 68 | exact table walk |
| The Pad (04.08.26, not in repo) | 53 | **76** + 2 modes / 79 | Config Tool: 78 = 76 circuits + Away/Onboard modes, all matched; Mode IDs 0x48/0x1E agree with the existing Mode parser. Module correct for 53/53 loads |
| Sel Citron | 100 | **102** / 116 | Config Tool (current: 110): all 101 circuits common to both revisions match; the 9 others were added after this 02.04.25 file. Module correct for 76/76 loads |

"Exact table walk" means the header's record count and byte length both match
what's read, record by record, which a misaligned parse can't do by chance.
All 486 records' output blocks also decode to exactly their declared length.

## Layout

```
u32 tableLength | u16 recordCount | u8[4] header | record × recordCount

record:
  u8  circuitId        27 99 <id> command ID
  u32 flags            0x0400 = logic block ("LB …", hidden in the Config Tool)
                       0x0100 = Mode
  u16 category         0x0020 DC, 0x0040 AC, 0x0010 lighting, 0x0001 electronics…
                       0x0000 on Modes
  u8  nameLength, name (UTF-8; ⁰ = E2 81 B0)
  u32 controlsLength, u16 controlCount, controls (variable entries; skipped)
  u32 outputsLength,  u16 outputCount, outputs:
      u8 channel, u8 module, u16 level (tenths of %, 0x03E8 = 100%),
      u8 reserved, + 9 bytes if (level & 0x0400)
```

Channel numbering:
- CXP: A.1–A.4 = 0–3, B.1–B.10 = 4–13, C.1–C.6 = 14–19
- COI: DC5–DC16 = 0–11, DC1–DC4 = 12–15 (same on all 11 COIs checked, two vessels)
- ACOI: ACn = n − 1
- Output Interface DCn and Contact 6 RLn: n − 1
- VSn = 0x1F + n (confirmed to VS25 = 0x38)

Module = dipswitch read LSB-first (10000000 = 0x01, 00000001 = 0x80, 11000000 = 0x03). On the TestBench Output Interface the
65284 status bit equals the channel number.

## Issues this fixes in the current parser

1. **Missing circuits.** Any record without `E8 03` at +6 (no-output circuits,
   some pumps, alarms, the Buzzer) is skipped.
2. **Wrong channel/module.** The current parser reads channel/module from the bytes
   *before* the name, which are the *previous* record's outputs. The outputs belong
   after the name; the circuit ID is correctly before it.
3. **Circuit ID 0.** Names matched from other tables become circuits with ID 0
   (SugarShack "Watermaker Z-ion" is really 0x5A, "Compass Lights" 0x55;
   Meitaki "TV USB").
4. **Modes.** Mode definitions are in the same table (category 0, outputs = the
   mode's action list with levels), so Mode IDs and actions can come from here.

## Notes

- Names are stored exactly as entered, including trailing spaces
  ("Grey Water Dump "); the Configuration Tool trims them for display.
  Trim for display and slugs, keep the raw name for matching.
- Mode definitions are category-0 records whose outputs are the Mode's action
  list; the Configuration Tool lists Modes (in blue) at the top of Circuits.

## Integration

Each record has `kind`:
- `logic`: flags & 0x0400 ("LB …" logic blocks)
- `mode`: remaining category-0 records
- `internal`: a circuit with no controls that shares its name with a circuit that
  has controls (Meitaki "Audible Alarm" IDs 0x01/0x02 beside user-facing 0x20).
  Zero-control circuits with unique names are real and stay `circuit`.
- `circuit`: everything else

This reproduces the Configuration Tool's circuit and Mode lists exactly on all
five boats with ground truth. On the other boats the `internal` rule changes nothing.

`parseCircuits(buf)` returns circuits, `parseModes(buf)` returns Modes (outputs =
action list), each:
`{ id, name, category, flags, hidden, controlCount, outputs: [{ channel, module, levelPercent, extended }] }`.
`parseCircuitTable(buf)` returns every record, including hidden ones.

Suggested use: take `id`, `name` and `outputs` from here, keep the existing
dimmer detection and status-table code, and map status using an output's
`module` + `channel` where the load table has no mask.

Run `node test/zcf-circuits.test.js` (it uses the existing `test/fixtures`).

---

# ZCF Meters and Inputs tables (`lib/zcf-monitor.js`)

Both tables use the same pattern: `u32 tableLength | u16 count | u8 header | records`, and a
table is only accepted when exactly `count` records end exactly at the declared length.

## Meters

`record: u8 ac (0 DC / 1 AC) | u8 meterId | u8 module | u8 nameLength | name`

- `meterId` is **not** the NMEA 2000 instance. Virtual meters are numbered 1..n; a wired meter's id
  is its input on the module (Meter Interface DC1 = 0; SugarShack's 16–31 are inputs on module 0x28).
- `module 0` = virtual/third-party meter; `module ≠ 0` = meter wired to that module, which
  broadcasts it. Another device may publish the same instance, so read wired meters from the
  module's own source address.

### Meter settings (NMEA 2000 instance)

Straight after the Meters table come two more tables, DC then AC, same header pattern
(`u32 length | u16 count | u8 recordSize`; DC records 86 or 92 bytes, AC 65):

`record: u8 nmeaInstance | u8 meterId | u8 module | …`

`(meterId, module)` matches a meter in the list; `nmeaInstance` is what the Configuration Tool shows
and what goes out in PGN 127508/127506. Confirmed on the bench (1 Oct 2026): Victron Shunt
meterId 1 → instance 2, and the Cerbo sends PGN 127508 on instance 2; Meter Interface
"5V System - MI" meterId 1 → instance 1, sent by the Meter Interface on instance 1. Every DC and AC
meter in all eight fixture files resolves through these tables.

## Inputs (signal inputs + third-party senders)

`record: u8 input | u8 module | u8 wiring | u8 kind | u8 flags | u8 a | u8 b | body | u8 nameLength | name | calibration`

- Body is 47 bytes in older files (TestBench, Compass Rose, The Pad) and 53 in newer ones.
- `module 0` = third-party sender (value arrives on NMEA 2000 from another device).
- `wiring`: `0x04` Switch to Pos, `0x05` Switch to Neg, `0x01` resistive sender.
- `kind`: `0x0c`/`0x0f` temperature (a = temperature source, b = instance), `0x08` pressure
  (a = source, b = instance), tanks `0x04`/`0x07`/`0x44`/`0x84` (a = fluid type
  0 fuel / 1 fresh / 2 waste / 5 black, b = instance), `0x0b` voltage/current.
- Newer records end `… <points> xx xx 00 00 00 00 FF FF <nameLength>`; `<points>` calibration
  points follow the name, 4 bytes each (6 bytes for kind `0x0b`).

## Validation

| ZCF | Meters | Inputs | Ground truth |
|---|---|---|---|
| TestBench | 4 | 6 | Config Tool: exact (Meter Interface + virtual shunt; SI inputs 1–6) |
| Compass Rose | 4 | 10 | Config Tool: exact (2 DC/2 AC virtual; 4 CXP inputs + 6 senders) |
| The Pad (not in repo) | 7 | 16 | Config Tool: exact (5 DC/2 AC; 9 COI inputs + 7 senders) |
| Meitaki, Persevere, Sel Citron, SugarShack | 7 / 8 / 8 / 13 | 50 / 5 / 34 / 26 | exact table walks, incl. tank and current-sender calibration curves |

Run `node test/zcf-monitor.test.js`.

## DC meter type (settings record byte 28)

Low nibble = NMEA 2000 DC type (0 battery, 1 alternator, 2 converter, 3 solar cell, 4 wind generator); high nibble = nominal voltage (1 = 12 V, 2 = 24 V). `0x10` 12 V battery, `0x20` 24 V battery, `0x11` alternator, `0x12` converter, `0x13` solar. Checked by meter name in all seven sample files.

## Circuit sub-categories

Flags u32 at circuit record + 10, bits 16..31: House/Habitat, Vessel Critical, Navigation, Electronics, 24-Hour Circuits, Communications, Accessories, Indicators and Alarms, Engine Management, Fans/Ventilation, Lighting, Vessel Management, Pumps, Propulsion Management, Power, Refrigeration. Category word u16 at record + 14: bit 0 Entertainment, 1 Climate, 2 Appliances, 3 Other, 4 Favourites, 5 DC, 6 AC, 7..11 User Definable Circuit Display Category 1..5, 13 Bilge Pumps (Compass Rose 03.10.26).

## User-defined category names

```
u8 nameLength @14 | vessel name | modules table | backlight-zone table | block
table: u32 length | u16 count | u8 header | records
block: u8 length | 5 x (u8 n | name) | u8
```
Meitaki: Winches, Furlers, Lithium. Sel Citron: Telecommunications. Empty strings where unused.
