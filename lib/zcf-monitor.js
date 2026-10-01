'use strict'

// Structural parser for the CZone ZCF Meters and Inputs tables.
//
// Like zcf-circuits.js, both tables are read by their own length and count
// fields; a table is only accepted if exactly `count` records end exactly at
// the declared table length.
//
// METERS  (Configuration Tool "Meters" tab)
//   u32 tableLength | u16 count | u8 header | record × count
//   record: u8 ac (0 DC, 1 AC) | u8 meterId | u8 module | u8 nameLength | name
//     meterId: virtual meters are numbered 1..n; a wired meter's id is its
//       input on the module (Meter Interface DC1 = 0). NOT the NMEA instance.
//     module 0x00 = virtual / third-party meter; module != 0 = meter wired to
//     that module (e.g. Meter Interface 0x04), which broadcasts it
//
// DC METER (battery) SETTINGS, immediately after the Meters table
//   u32 tableLength | u16 count | u8 recordSize (86 older, 92 newer) | record × count
//   record: u8 nmeaInstance | u8 meterId | u8 module | …
//     (meterId, module) matches a DC meter above. nmeaInstance is the instance
//     the Configuration Tool shows and the one on the bus in PGN 127508/127506.
//     Bench 1 Oct 2026: Victron Shunt meterId 1 -> instance 2 (Cerbo sends
//     127508 instance 2); 5V System - MI meterId 1 on module 0x04 -> instance 1
//     (Meter Interface sends 127508 instance 1). The Pad: House Battery -> 239.
//
// AC METER SETTINGS, immediately after the DC table: same layout
//   (recordSize 65), record: u8 nmeaInstance | u8 meterId | u8 module | …
//
// INPUTS  (Configuration Tool "Inputs" tab: signal inputs + third-party senders)
//   u32 tableLength | u16 count | u8 header | record × count
//   record: u8 input | u8 module | u8 wiring | u8 kind | u8 flags | u8 a | u8 b
//           | body (47 bytes in older files, 53 in newer)
//           | u8 nameLength | name
//           | calibration points (newer files only; see below)
//     module 0x00 = third-party sender (data arrives on NMEA 2000 from elsewhere)
//     wiring: 0x04 Switch to Pos, 0x05 Switch to Neg, 0x01 resistive sender …
//     kind:   0x0c temperature, 0x0f refrigeration temperature, 0x08 pressure,
//             tanks 0x04/0x07/0x44/0x84, 0x0b voltage/current, 0x00-0x02 switch
//     tank:        a = fluid type (0 fuel, 1 fresh, 2 waste, 5 black), b = instance
//     temperature: a = temperature source,                                b = instance
//     pressure:    a = pressure source (0 atmospheric),                   b = instance
//   Newer (53-byte) records end "... <points> xx xx 00 00 00 00 FF FF <nameLength>";
//   <points> calibration points follow the name, 4 bytes each (6 for kind 0x0b).
//
// Validated against the Configuration Tool Meters/Inputs tabs for TestBench,
// Compass Rose and The Pad, and by exact table walks on six production ZCFs.

function printableName (buf) {
  if (buf.length === 0) return false
  let letters = 0
  for (const c of buf) {
    if (c < 0x20 || c === 0x7f) return false
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) letters++
  }
  return letters >= 2
}

function tableHeader (buf, h) {
  if (h + 7 > buf.length) return null
  const length = buf.readUInt32LE(h)
  const count = buf.readUInt16LE(h + 4)
  const end = h + 4 + length
  if (count < 1 || end > buf.length) return null
  return { length, count, end, header: buf[h + 6] }
}

// ---------------------------------------------------------------- meters --

function readMetersAt (buf, h) {
  const t = tableHeader(buf, h)
  if (!t || t.count > 64 || t.length < 8 || t.length > 4000) return null
  const meters = []
  let p = h + 7
  for (let i = 0; i < t.count; i++) {
    if (p + 4 > t.end) return null
    const ac = buf[p]
    const meterId = buf[p + 1]
    const module = buf[p + 2]
    const n = buf[p + 3]
    if (ac > 1 || n < 1 || p + 4 + n > t.end) return null
    const nameBuf = buf.subarray(p + 4, p + 4 + n)
    if (!printableName(nameBuf)) return null
    meters.push({
      name: nameBuf.toString('utf8').trim(),
      type: ac ? 'AC' : 'DC',
      module,
      virtual: module === 0,
      meterId,
      instance: meterId, // replaced below for DC meters with battery settings
      instanceFrom: 'meterId',
      offset: p
    })
    p += 4 + n
  }
  if (p !== t.end) return null
  applyInstances(buf, t.end, meters)
  return { offset: h, count: t.count, meters }
}

// Read a meter settings table (DC or AC); rows give each meter's NMEA 2000
// instance. Returns { rows, end } or null.
function readSettings (buf, h) {
  if (h + 7 > buf.length) return null
  const length = buf.readUInt32LE(h)
  const count = buf.readUInt16LE(h + 4)
  const size = buf[h + 6]
  if (count === 0 && length === 3) return { rows: [], end: h + 4 + length }
  if (count < 1 || count > 64 || size < 16 || length !== 3 + count * size || h + 4 + length > buf.length) return null
  const rows = []
  for (let i = 0; i < count; i++) {
    const r = h + 7 + i * size
    rows.push({ instance: buf[r], meterId: buf[r + 1], module: buf[r + 2] })
  }
  return { rows, end: h + 4 + length }
}

// DC settings table, then AC settings table, straight after the Meters table.
function applyInstances (buf, h, meters) {
  const dc = readSettings(buf, h)
  if (!dc) return
  const ac = readSettings(buf, dc.end)
  for (const [type, table] of [['DC', dc], ['AC', ac]]) {
    if (!table) continue
    for (const m of meters) {
      if (m.type !== type) continue
      const row = table.rows.find(r => r.meterId === m.meterId && r.module === m.module)
      if (row) { m.instance = row.instance; m.instanceFrom = 'settings' }
    }
  }
}

function parseMeters (buf) {
  for (let h = 0; h + 7 <= buf.length; h++) {
    const r = readMetersAt(buf, h)
    if (r) return r
  }
  return null
}

// ---------------------------------------------------------------- inputs --

const WIRING = { 0x04: 'switchToPos', 0x05: 'switchToNeg', 0x01: 'resistive' }
const FLUID = { 0: 'fuel', 1: 'freshWater', 2: 'wasteWater', 3: 'liveWell', 4: 'lubrication', 5: 'blackWater' }

function classify (wiring, kind) {
  if (wiring === 0x04 || wiring === 0x05) return 'switch'
  if (kind === 0x0c || kind === 0x0f) return 'temperature'
  if (kind === 0x08) return 'pressure'
  if (kind === 0x0b) return 'electrical'
  if (kind === 0x07 || (kind & 0x0f) === 0x04) return 'tank'
  return 'analog'
}

function nameAt (buf, p, end, body) {
  const lp = p + 7 + body
  if (lp >= end) return null
  const n = buf[lp]
  if (n < 1 || n > 64 || lp + 1 + n > end) return null
  if (!printableName(buf.subarray(lp + 1, lp + 1 + n))) return null
  const points = (body === 53 && buf[lp - 1] === 0xff && buf[lp - 2] === 0xff) ? buf[lp - 9] : 0
  return { lp, n, after: lp + 1 + n, points }
}

function readInputsAt (buf, h) {
  const t = tableHeader(buf, h)
  if (!t || t.count > 250 || t.length < 30) return null
  for (const body of [47, 53]) {
    const inputs = []
    let p = h + 7
    let ok = true
    for (let i = 0; i < t.count; i++) {
      const r = nameAt(buf, p, t.end, body)
      if (!r) { ok = false; break }
      const kind = buf[p + 3]
      const sizes = kind === 0x0b ? [6, 4, 8] : [4, 6, 8]
      let next = null
      let pointSize = 0
      if (r.points === 0) {
        next = r.after
      } else {
        for (const s of sizes) {
          const candidate = r.after + r.points * s
          const fits = i === t.count - 1 ? candidate === t.end : nameAt(buf, candidate, t.end, body) !== null
          if (fits) { next = candidate; pointSize = s; break }
        }
      }
      if (next === null) { ok = false; break }
      const wiring = buf[p + 2]
      const module = buf[p + 1]
      const type = classify(wiring, kind)
      const a = buf[p + 5]
      const b = buf[p + 6]
      const rec = {
        name: buf.subarray(r.lp + 1, r.lp + 1 + r.n).toString('utf8').trim(),
        type,
        module,
        thirdParty: module === 0,
        input: buf[p],
        wiring: WIRING[wiring] || `0x${wiring.toString(16).padStart(2, '0')}`,
        kind,
        calibrationPoints: r.points,
        offset: p,
        raw: buf.subarray(p, p + 7).toString('hex')
      }
      if (type === 'tank') { rec.fluidType = FLUID[a] || a; rec.instance = b }
      if (type === 'temperature') { rec.source = a; rec.instance = b }
      if (type === 'pressure') { rec.source = a; rec.instance = b }
      inputs.push(rec)
      p = next
    }
    if (ok && p === t.end) return { offset: h, count: t.count, recordSize: body, inputs }
  }
  return null
}

function parseInputs (buf) {
  for (let h = 0; h + 7 <= buf.length; h++) {
    const r = readInputsAt(buf, h)
    if (r) return r
  }
  return null
}

module.exports = { parseMeters, parseInputs }
