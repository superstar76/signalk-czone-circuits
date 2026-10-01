# signalk-czone-circuits

Signal K control plugin for CZone circuits and Modes using a dynamically parsed
CZone ZCF configuration.

**Current release:** `0.1.0-beta.19`

> **Beta status:** This project is an active reverse-engineering and field-testing
> project. The ZCF parser has been broadened and regression-tested against multiple
> CZone configurations, but some control mappings remain provisional until they are
> exercised against the corresponding live CZone system.

## Beta 16

Beta 16 replaces the earlier byte-signature circuit scan with a structural ZCF circuit-table parser. The parser reads the table length and record count, then consumes each circuit record using its declared control/output lengths, so logic blocks, Modes, extended output records, and other record types cannot desynchronise the scan.

Circuit filtering is deliberately conservative:

- Logic blocks are excluded from the circuit list using their ZCF flag bit.
- Modes are identified from their category/record structure and remain in the separate Mode list.
- A circuit with no controls is **not** automatically discarded. It is excluded only when another circuit with the same name has controls, which removes internal duplicate copies while preserving real zero-control circuits such as Sel Citron's Salon Air Conditioner, Meitaki's Cabin Fans/Cockpit USB, and Sugar Shack's four solar chargers.
- Virtual/VS circuits are not blanket-filtered; entries such as VS - HWC Port and Watermaker Fault VS remain available when present in the ZCF.

The parser also consumes extended output records correctly and retains their channel/module/level information. The supplied six ZCF fixtures are now structural regression tests, including an exact 107-name Meitaki list with the user-facing Audible Alarm at circuit ID `0x20` (32).

The module-table parser was also tightened: the byte immediately after the table length is the device count, and each module record consumes its trailing byte explicitly. This removes the previous byte-by-byte resynchronisation fallback while retaining the corrected high-bit name-length handling.

## Beta 15

- Added a second ZCF circuit-status mapping parser for the Bench/TestBench load-table layout.
- Load records are decoded as `[mask:4-byte little-endian][name length][name][output #][module]` and are located from the `64 00` load-table marker.
- The full load mask is retained as `statusMask`; legacy ZCF status records continue to use their single-bit mapping.
- A logical circuit uses the load record with the same name, so TestBench Light 5 maps to module `0x01`, mask `0x10`, while the companion Buzzer load remains `0x20`.
- PGN 65284 state decoding now uses `statusMask` when present, allowing Light 5 to report correctly from the observed `0x30` bitmap without treating the Buzzer bit as part of Light 5.
- Added a TestBench regression fixture test covering Light 1-5 masks and module mapping.

## Beta 14

Beta 14 tightens CZone device discovery and command sequencing based on additional ZCF and
Wireless Interface observations. The module parser now reads only the bounded module table immediately
after the length-prefixed vessel/configuration name. It masks the high bit of module-name length bytes
and accepts the observed third record byte values instead of requiring zero. This captures real devices
including the Bench Display and Sugar Shack B&G displays, ACOI, and STBD Helm KeyPad without counting
circuit or Mode records as devices.

The automatically selected command device ID is therefore the lowest address not present in the actual
ZCF module table. Circuit and Mode commands continue to use trailer `0x08`. Webapp circuit ON/OFF
commands now use the same multi-frame sequences as Signal K PUT handlers, including the `0x40`
completion frame for ordinary circuits. Dimmable ON now follows the observed Wireless Interface
sequence `F5 95 43`; dimmable OFF remains `F5 95 42`.

## Beta 13

Beta 13 changes CZone control command ownership based on controlled Bench testing. The command byte-5 value is now selected automatically as the first unused CZone module/dipswitch address in the loaded ZCF; the plugin no longer hard-codes a device identity such as `0x08`, `0x24`, or `0x65`. Circuit and Mode control frames use trailer `0x08`. This prevents the approximately 10-second expiry observed when a `0x00` trailer is used with a device identity that is not live on the bus. The selected command device ID is reported in plugin status/logs.

## Beta 12 / current status

Beta 12 is primarily a documentation release following the Beta 7–11 UI and
configuration refinements. The current beta line includes:

- A responsive webapp with three-column desktop, two-column medium, and a dedicated
  super-narrow/mobile layout.
- Desktop and medium layouts keep the Modes, System Overview, and Connection panels
  in the right/left status well as appropriate to the viewport.
- Super-narrow layout is deliberately ordered for small-screen use:
  **branding → hero → Modes → filters → circuit listing → System Overview → Connection**.
- The electric-blue abstract hero image and dynamic vessel-name title are retained.
- The medium layout hides the decorative `ACTIVE` suffix on Mode buttons so long Mode
  names have more room and can wrap safely. Wide and super-narrow layouts retain it.
- The Signal K Plugin Config screen remains the configuration boundary; runtime webapp
  controls do not duplicate the ZCF configuration controls.
- The NMEA 2000 transmit permission is phrased directly as **Allow this plugin to send
  NMEA 2000 messages**, with an explanation that enabling it permits CZone circuit and
  Mode control PGNs to be sent to the NMEA 2000 network.
- Package metadata includes the plugin author and Signal K's
  `signalk-plugin-enabled-by-default` setting.

## Beta 6 parser update

Beta 6 replaced the earlier Sugar Shack-specific ZCF circuit detection with a
structural parser based on the common circuit-record signature observed across the
available configurations. The parser no longer assumes that valid circuit modules
fall within the old `0x10..0x40` range (plus `0xF8`). Low module IDs are accepted when
the surrounding record structure matches a circuit record, while module `0` is
excluded because it is used by other ZCF tables.

The circuit signature currently used includes:

- channel at record offset `+4`
- module at `+5`
- `E8 03` marker at `+6/+7`
- ZCF circuit/control ID at `+9`
- circuit-name length at `+16`
- ASCII circuit name beginning at `+17`

The configuration/vessel name parser was also corrected to use the length-prefixed
name at byte 14 rather than searching for a `}` terminator.

Regression fixtures currently cover six configurations:

| ZCF fixture | Circuits found | Configuration name |
|---|---:|---|
| TestBench | 6 | Test Bench |
| Compass Rose | 35 | Compass Rose 28.06.26 |
| Persevere | 58 | Persevere 14.07.25 |
| Sel Citron | 102 | Sel Citron 02.04.25 |
| Meitaki | 107 | Meitaki 07.04.25 |
| Sugar Shack | 110 | Sugar Shack-20260927-01 |

The parser changes are also used by the **Read From Network and Save** path: after
CZone network DataBlock reassembly produces the complete configuration byte stream,
the same ZCF loader is used to parse and validate the resulting configuration.

This establishes generic parsing across the supplied fixtures. It does not by itself
prove that every possible ZCF can be transferred successfully over every CZone/NMEA
2000 network; network transport/reassembly still depends on the observed CZone
DataBlock protocol.

## Beta 1–5 UI and platform work

### Beta 5 — responsive layout

- Added responsive desktop, medium/tablet, and narrow/mobile layouts.
- Medium widths use a two-column layout with the navigation/status content kept in an
  independently scrolling left well.
- Narrow widths stack the major interface sections instead of allowing the status well
  to become coupled to the circuit-list height.
- Package metadata and application assets were retained while the layout was changed.

### Beta 4 — NMEA 2000 output readiness

- Improved NMEA 2000 output readiness handling across Signal K/canboatjs lifecycle
  variants while retaining the existing `app.emit('nmea2000out', line)` path.
- The plugin does not claim or configure the NMEA 2000 source address; the active
  canboatjs connection remains responsible for that.

### Beta 3 — approved hero artwork

- Added the abstract electric-blue hero background: dark navy/black field with glowing
  blue electrical currents and branching energy-like filaments.
- No boat, vehicle, or textual artwork is embedded in the hero image.

### Beta 2 — hero image

- Added a dedicated hero background image to the main webapp.

### Beta 1 — vessel name and hero

- The hero title uses the vessel name when available, displayed as
  **`<vesselname>’s Circuits`**.
- Falls back to **Your Boat, Your Circuits** when a vessel name is unavailable.

## Alpha 53–47 UI and packaging work

### Alpha 53

- Removed the duplicate category toolbar from the center of the webapp.
- Category navigation remains in the left well.
- Search remains above the circuit list.

### Alpha 52

- Refined the main three-column interface and category navigation layout.

### Alpha 51 / 50 / 49

- Added the plugin icon to the package root and public webapp assets.
- Added the Signal K `appIcon` package metadata.
- Kept plugin configuration in the Signal K Plugin Config interface rather than placing
  configuration controls in the normal runtime webapp.
- Preserved the network configuration source selector and **Read From Network and Save**
  workflow in Plugin Config.

### Alpha 48

- Fixed plugin startup/packaging issues identified during installation testing.

### Alpha 47 baseline

- Established the CZone circuit-control webapp, ZCF loading, Signal K paths, Mode
  controls, and NMEA 2000 output work that the later beta releases build upon.

## CZone command PGN

Outbound CZone circuit commands are emitted as raw NMEA 2000 PGN **65280 (0xFF00)**.
Some tooling represents the same proprietary CZone family in the DP-numbered range
(130816); the plugin accepts that alias when decoding input, but deliberately uses 65280
for outbound Actisense/NMEA 2000 frames because that is the on-wire PGN observed in CZone
captures.

## Plugin boundary

This plugin is intentionally separate from the existing `signalk-czone` plugin:

- **signalk-czone**: read-only CZone telemetry/reporting, including current measurements.
- **signalk-czone-circuits**: active circuit/brightness/Mode control and NMEA 2000 output.

This plugin does **not** publish `electrical.czone.<circuit>.current`.

## NMEA 2000 sending safety interlock

**Allow this plugin to send NMEA 2000 messages** defaults to **disabled**. No CZone control
frame is emitted unless the administrator explicitly enables sending and Signal K reports
that NMEA 2000 output is available.

The plugin does **not** configure or claim an NMEA 2000 source address. It sends through
Signal K's `nmea2000out` path and lets the active canboatjs NMEA 2000 connection own address
claiming and source-address selection.

The ZCF can still be uploaded, parsed, inspected, and used for read-only status display
with sending disabled.

## ZCF model

Each parsed circuit retains:

- ZCF circuit/control ID
- module/device address
- channel/page/slot
- stable Signal K slug
- switch capability
- dimmer capability where the empirically identified `0F 01 00 00` control object is present
- protocol confidence (`capture` for sampled mappings, `zcf-derived` for provisional mappings)
- CZone runtime status mapping (`statusModule` + `statusBit`) decoded from the ZCF status/output table

The current Sugar Shack fixture identifies 13 dimmable circuits.

Mode records retain both identifiers:

- `id`: 16-bit ZCF configuration/object ID
- `runtimeId`: one-byte live `27 99` control ID
- `modeGroupId`: currently observed as `0x01`; semantic meaning is **provisional** pending a ZCF containing another Mode Group

The current Sugar Shack configuration contains four Modes: Anchored, Day Crusing,
Night Cruising and Sleep.

## Confirmed CZone control protocol

Individual control uses the empirically verified proprietary eight-byte payload:

```text
27 99 <control-id> 00 <percent> <parameter> <operation> 00
```

Confirmed operations:

- `F1` = ON
- `F2` = OFF
- `FC` = level

For tested level commands, `<percent>` is the literal decimal percentage byte.

Examples:

```text
27 99 65 00 00 08 F1 00
27 99 65 00 00 08 F2 00
27 99 65 00 32 08 FC 00
```

Yacht Devices CanView may display an `8` data-length field before the payload. That `8`
is **not** part of the CAN payload.

### Confirmed Mode activation

Mode activation is one CZone frame; the plugin does not replay the Mode action list:

```text
27 99 53 00 00 24 F1 00  # Day Crusing
27 99 4D 00 00 24 F1 00  # Night Cruising
27 99 4E 00 00 24 F1 00  # Anchored
27 99 56 00 00 24 F1 00  # Sleep
```

There is no Mode OFF command in the current model. A Mode is a persistent selection;
after system restart the plugin performs a short startup reconciliation using observed
CZone circuit states. This is a fuzzy best-match fallback only; an authoritative Mode
activation frame always takes precedence.

## Signal K control paths

Circuit state:

```text
electrical.czone.<circuit>.switch.state
```

Dimmable circuit brightness:

```text
electrical.czone.<circuit>.switch.brightness
```

Mode selection:

```text
electrical.czone.mode.active
```

Mode writes accept a Mode slug or ZCF display name. A false/off value is not valid.

Writes are treated as requests. Circuit ON/OFF state is published from CZone PGN 65284
status bitmaps. PGN 130822 is used for DC level/brightness telemetry only and is not used
to infer switch state from load current or brightness. A received Mode activation frame is
authoritative during normal operation. After plugin startup, the plugin may publish a fuzzy
best-match Mode once enough circuit-status observations have arrived. Startup inference is
performed only once and does not re-evaluate the Mode when individual circuits are manually
overridden.

## ZCF upload

The Signal K configuration panel provides a dedicated `.zcf` upload control similar to
the existing `signalk-czone` plugin. The uploaded file is parsed and validated before it
replaces the installed ZCF. A successful upload persists the configuration and restarts the
plugin so that Signal K PUT handlers are rebuilt against the new ZCF.

The installed ZCF is stored under the plugin data directory as `installation.zcf`.

## Network configuration read

The Plugin Config interface can explicitly request the complete CZone configuration from
the network. This is **not** performed during Signal K startup.

The **Read From Network and Save** action sends the observed CZone configuration-read
request on PGN 65290, receives/reassembles the CZone DataBlock transfer on PGN 130816,
acknowledges each DataBlock on PGN 65291, validates the reconstructed configuration with
the ZCF parser, and saves the resulting raw configuration bytes using a `.czone.net`
extension.

The saved filename is based on the vessel name embedded in the received configuration
when available, then Signal K's `vessels.self.name`, then the generic `CZone Network` name.
A JSON sidecar records acquisition metadata. The resulting `.czone.net` file appears in
the Plugin Config source selector and can be explicitly selected for future startup.
Switching back to **Use installed/uploaded ZCF** is also available there.

`.czone.net` is intentionally used instead of `.zcf`: the plugin has reconstructed the
CZone configuration byte stream from the network, but does not claim to produce an
officially sanctioned CZone configuration file.

## Webapp architecture

The normal runtime webapp is deliberately focused on monitoring and control. ZCF source
selection, upload, network configuration reads, and the NMEA 2000 transmit permission live
in the Signal K Plugin Config interface (`remoteEntry.js`).

The runtime webapp receives live Signal K WebSocket deltas for circuit state and brightness.
A long-duration WebSocket watchdog performs a REST reconciliation only after an extended
period without a Signal K delta; it does not run a high-frequency polling loop.

## Development status

The implementation is a **beta-stage reverse-engineering project**. The supplied ZCF
fixtures demonstrate that the parser can identify circuit records across substantially
different configurations, including configurations with low module IDs and larger circuit
counts. Unknown proprietary fields are retained rather than guessed.

Generic ZCF-derived control mappings remain provisional for circuits that have not yet been
individually exercised on the live bus. Further captures can promote mappings from
`zcf-derived` to empirically verified profiles.

## Historical protocol notes

### Alpha.34 webapp state synchronization

- Signal K WebSocket deltas became the primary live state source for circuit `switch.state`
  and `switch.brightness`.
- Removed the 5-second `/circuits` polling loop.
- A WebSocket watchdog performs one REST `/circuits` reconciliation only after 120 seconds
  without a Signal K delta, then resets its timer.
- WebSocket reconnects trigger a recovery path without creating a high-frequency polling loop.
- Circuit commands update the UI optimistically and show a `Sending…` indicator until
  authoritative CZone state/brightness is observed.
- If the command is rejected or CZone reports a different value, the UI rolls back/reconciles
  to the observed value.
- The NMEA 2000/CZone command encoding is unchanged from Alpha.33.

### Alpha.33 outbound switch commands

- Non-dimmable ON/OFF commands use the live-captured CZone PGN 65280 switch sequence
  (`F1`/`F2` with parameter `0x24`, followed by the `0x40` completion frame).
- Dimmable circuits use the captured CZone ON/OFF sequences (`F5` + `43` for ON;
  `F5` + `95` + `42` for OFF).
- Moving a dimmer slider while the circuit is OFF first sends the CZone dimmer ON sequence,
  then the requested `FC` level command.
- Debug logging records all frames in a multi-frame command sequence.

### Alpha.24

The ZCF parser decodes the separate runtime status/output table. Each logical circuit can
therefore carry its CZone runtime `statusModule` and `statusBit`; these are the identities
used to decode PGN 65284. This replaced the previous assumption that the primary ZCF
module/channel (or a fixed module offset) maps directly to the 65284 bitmap.

PGN 65284 is authoritative for `switch.state`. PGN 130822 supplies level/brightness
telemetry and no longer synthesizes `switch.state` from current or level.

### Alpha.21

Observed ON/OFF state is sourced from CZone PGN 65284 circuit-status bitmaps. The ZCF
module/slot identifies the circuit; the NMEA-2000 source address identifies the reporting
CZone module. PGN 130822 remains the source for DC current/level telemetry.

### Mode observation (Alpha.42)

CZone mode changes are treated as authoritative from the proprietary CZone mode transaction
on PGN 65280: `27 99 <mode runtime ID> 00 00 24 F1 00`. Individual circuit state changes
do not invalidate the active mode, because circuits can be overridden while a mode remains
active. The following `0x40` CZone transaction-complete frame is logged when observed but is
not treated as a separate mode identity.

### Startup Mode reconciliation (Alpha.42)

CZone does not appear to periodically broadcast the selected Mode on the observed NMEA 2000
traffic. After a Signal K/plugin restart, Alpha.42 therefore collects the repeating PGN 65284
circuit-status observations and performs a **fuzzy best-match** against the Mode action targets
decoded from the ZCF. Expected-ON actions are weighted more heavily than expected-OFF actions
because OFF-heavy Mode definitions are otherwise ambiguous. The plugin requires a clear score
margin before publishing the inferred Mode.

This reconciliation is deliberately startup-only. Once a Mode has been inferred, or once an
authoritative `F1` Mode activation is observed, individual circuit changes never invalidate the
active mode. This allows a user to turn a circuit on/off manually while remaining in the selected
CZone Mode.

### Alpha.44 network configuration read

The plugin can explicitly request the complete CZone configuration from the network. This is
**not** performed during Signal K startup. The webapp action **Read From Network and Save** sends
the observed CZone configuration-read request on PGN 65290, receives/reassembles the CZone
DataBlock transfer on PGN 130816, acknowledges each DataBlock on PGN 65291, validates the
reconstructed configuration with the existing ZCF parser, and saves the resulting raw
configuration bytes using a `.czone.net` extension.

The saved filename is based on the vessel name embedded in the received configuration when
available, then Signal K's `vessels.self.name`, then the generic `CZone Network` name. A JSON
sidecar records acquisition metadata. The network read is exposed in the **Signal K Plugin Config**
panel, not as a normal runtime webapp action. After a successful read, the resulting `.czone.net`
file appears in the Plugin Config source selector and can be explicitly selected for future startup.
Switching back to **Use installed/uploaded ZCF** is also available there. This keeps Signal K startup
on the fast local-file path and avoids a multi-second CZone configuration transfer on every restart.

`.czone.net` is intentionally used instead of `.zcf`: the plugin has reconstructed the CZone
configuration byte stream from the network, but does not claim to produce an officially sanctioned
CZone configuration file.

### Beta.19 status-table parser

Beta.19 replaces ZCF status mapping based on binary/name signature scans with a structural parser for the status/load table immediately following the circuit table. The parser uses the table length/count and record boundaries, then builds a name lookup map once. This prevents circuit records containing byte sequences such as `E8 03` from being mistaken for runtime status records and avoids repeatedly scanning the whole ZCF.
