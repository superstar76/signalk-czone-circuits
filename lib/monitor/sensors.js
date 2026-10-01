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
//
// All four are single-frame PGNs.

const SENSOR_PGNS = new Set([130312, 130316, 130314, 127505])

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
  return []
}

module.exports = { SENSOR_PGNS, decodeSensorFrame, sensorKey: key }
