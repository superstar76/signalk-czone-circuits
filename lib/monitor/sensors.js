'use strict'

// Standard NMEA 2000 sensor PGNs decoded straight off the bus, so a sender
// added in the CZone Configuration Tool shows up as soon as the ZCF is
// uploaded: the ZCF gives the NMEA 2000 instance (and source / fluid type),
// and the same numbers are in the PGN. No Signal K path naming involved.
//
//   130312 Temperature                 SID, instance, source, temp u16 0.01 K
//   130316 Temperature, Extended Range SID, instance, source, temp u24 0.001 K
//   130314 Actual Pressure             SID, instance, source, pressure i32 0.1 Pa
//   127505 Fluid Level                 instance:4 | type:4, level i16 0.004 %, capacity u32 0.1 L
//   127508 Battery Status              instance, voltage i16 0.01 V, current i16 0.1 A, temp u16 0.01 K
//   127506 DC Detailed Status          fast packet; first frame: seq, len, SID, instance, type, SoC %
//   127744 AC Power / Current, Phase A SID, connection, current u16 0.1 A, power i32 1 W
//   127747 AC Voltage / Freq., Phase A SID, connection, V L-N u16 0.1 V, V L-L u16 0.1 V, freq u16 0.1 Hz
//     connection = the AC meter's instance (bench Meter Interface: Power In 0,
//     Power Out 1; e.g. "08 00 3F 09 FF FF F4 01" = 236.7 V, 50.0 Hz)
//
// 127506 is a fast packet, but SoC sits in its first frame, so no reassembly.
//
// The older AC messages are fast packets and need reassembling:
//   127503 AC Input Status   } instance, number of lines, then per line (18 bytes):
//   127504 AC Output Status  } line/flags u8, voltage u16 0.01 V, current u16 0.1 A,
//                              frequency u16 0.01 Hz, breaker u16, real power u32 1 W,
//                              reactive power u32, power factor i8
// CZone and many chartplotters only understand these two; newer equipment
// (Victron via the GX) only sends 127744-127749. Boats bridge one to the other
// in Node-RED, so both styles can be on the bus for the same meter. Both feed
// the same acVoltage/acCurrent/acPower/acFrequency keys (instance = the AC
// meter's NMEA 2000 instance), so a meter shows once; when both are present
// the older pair wins, because that is what the CZone configuration refers to.

const SENSOR_PGNS = new Set([130312, 130316, 130314, 127505, 127508, 127506, 127744, 127747])
const FAST_SENSOR_PGNS = new Set([127503, 127504])
// Higher wins when two message styles carry the same reading.
const sensorRank = pgn => (FAST_SENSOR_PGNS.has(pgn) ? 2 : 1)

const u16na = v => v === 0xffff
const key = (kind, instance, sub) => `${kind}:${instance}:${sub}`

// Returns [{ key, value }] for one frame (values in Signal K units).
function decodeSensorFrame (pgn, d) {
  if (!d || d.length < 7) return []
  if (pgn === 130312) {
    const raw = d.readUInt16LE(3)
    if (u16na(raw)) return []
    return [{ key: key('temperature', d[1], d[2]), value: Math.round(raw) / 100 }]
  }
  if (pgn === 130316) {
    const raw = d[3] | (d[4] << 8) | (d[5] << 16)
    if (raw === 0xffffff) return []
    return [{ key: key('temperature', d[1], d[2]), value: raw / 1000 }]
  }
  if (pgn === 130314) {
    const raw = d.readInt32LE(3)
    if (raw === 0x7fffffff) return []
    return [{ key: key('pressure', d[1], d[2]), value: raw / 10 }]
  }
  if (pgn === 127505) {
    const instance = d[0] & 0x0f
    const type = d[0] >> 4
    const level = d.readInt16LE(1)
    if (level === 0x7fff) return []
    const ratio = (level * 0.004) / 100
    const out = [{ key: key('tank', instance, type), value: ratio }]
    if (d.length >= 7) {
      const cap = d.readUInt32LE(3)
      if (cap !== 0xffffffff) out.push({ key: key('tankVolume', instance, type), value: ratio * cap / 10000 })
    }
    return out
  }
  if (pgn === 127508) {
    const out = []
    const instance = d[0]
    const v = d.readInt16LE(1)
    const a = d.readInt16LE(3)
    const t = d.readUInt16LE(5)
    if (v !== 0x7fff) out.push({ key: key('batteryVoltage', instance, 0), value: v / 100 })
    if (a !== 0x7fff) out.push({ key: key('batteryCurrent', instance, 0), value: a / 10 })
    if (t !== 0xffff) out.push({ key: key('batteryTemperature', instance, 0), value: t / 100 })
    return out
  }
  if (pgn === 127506) {
    if ((d[0] & 0x1f) !== 0 || d.length < 6) return [] // first frame of the fast packet only
    const instance = d[3]
    const soc = d[5]
    return soc === 0xff ? [] : [{ key: key('batterySoc', instance, 0), value: soc / 100 }]
  }
  if (pgn === 127744) {
    const out = []
    const conn = d[1]
    const amps = d.readUInt16LE(2)
    const watts = d.readInt32LE(4)
    if (amps !== 0xffff) out.push({ key: key('acCurrent', conn, 0), value: amps / 10 })
    if (watts !== 0x7fffffff) out.push({ key: key('acPower', conn, 0), value: watts })
    return out
  }
  if (pgn === 127747) {
    const out = []
    const conn = d[1]
    const vln = d.readUInt16LE(2)
    const hz = d.readUInt16LE(6)
    if (vln !== 0xffff) out.push({ key: key('acVoltage', conn, 0), value: vln / 10 })
    if (hz !== 0xffff) out.push({ key: key('acFrequency', conn, 0), value: hz / 10 })
    return out
  }
  return []
}

// What a device says it is for one DC instance: PGN 127506's DC type
// (0 battery, 1 alternator, 2 converter, 3 solar cell, 4 wind generator) and
// whether it reports a state of charge. Null for anything else.
function decodeDcSender (pgn, d) {
  if (pgn !== 127506 || !d || d.length < 6 || (d[0] & 0x1f) !== 0) return null
  return { instance: d[3], dcType: d[4] === 0xff ? undefined : d[4], soc: d[5] !== 0xff }
}

// "batteryVoltage:1:0" -> 1 for the four DC meter readings, else undefined.
function dcInstanceOf (sensorKeyString) {
  const m = /^battery(?:Voltage|Current|Soc|Temperature):(\d+):0$/.exec(sensorKeyString)
  return m ? Number(m[1]) : undefined
}

// Returns [{ key, value }] for a reassembled fast packet. Line 1 (phase A) only.
function decodeSensorPacket (pgn, p) {
  if (!FAST_SENSOR_PGNS.has(pgn) || !p || p.length < 15) return []
  const instance = p[0]
  if (p[1] === 0 || p[1] === 0xff) return []
  const out = []
  const volts = p.readUInt16LE(3)
  const amps = p.readUInt16LE(5)
  const hz = p.readUInt16LE(7)
  const watts = p.readUInt32LE(11)
  if (volts !== 0xffff) out.push({ key: key('acVoltage', instance, 0), value: volts / 100 })
  if (amps !== 0xffff) out.push({ key: key('acCurrent', instance, 0), value: amps / 10 })
  if (hz !== 0xffff) out.push({ key: key('acFrequency', instance, 0), value: hz / 100 })
  if (watts !== 0xffffffff) out.push({ key: key('acPower', instance, 0), value: watts })
  return out
}

module.exports = { SENSOR_PGNS, FAST_SENSOR_PGNS, sensorRank, decodeSensorFrame, decodeSensorPacket, decodeDcSender, dcInstanceOf, sensorKey: key }
