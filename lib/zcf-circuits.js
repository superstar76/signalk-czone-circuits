'use strict'

// Structural parser for the CZone ZCF circuit table.
//
// Unlike signature scanning (e.g. requiring E8 03 at a fixed offset), this
// walks the table using its own length and count fields, so every circuit is
// read regardless of type, and a mis-parse cannot silently drop records.
//
// Table layout (little-endian):
//
//   u32  tableLength        bytes after this field, up to the end of the table
//   u16  recordCount
//   u8[4] tableHeader       (observed 08 08 05 0E / 08 08 05 0F ...)
//   record[recordCount]
//
// Record layout:
//
//   u8   circuitId          runtime ID used in 27 99 <id> ... commands
//   u32  flags              bitfield; 0x0400 = logic block ("LB ..."),
//                           0x0100 = Mode; other bits not yet known
//   u16  category           bitmask: 0x0020 DC, 0x0040 AC, 0x0010 lighting,
//                           0x0001 electronics, ...; 0x0000 for Modes
//   u8   nameLength
//   u8[] name               UTF-8 (degree signs appear as E2 81 B0)
//   u32  controlsLength     bytes after this field
//   u16  controlCount
//   u8[] controls           variable-size entries, skipped by length
//   u32  outputsLength      bytes after this field
//   u16  outputCount
//   output[outputCount]:
//     u8   channel          0-based output channel on the module
//                           (CXP: A.1-A.4 = 0-3, B.1-B.10 = 4-13, C.1-C.6 = 14-19,
//                            VS 01-10 = 0x20-0x29)
//     u8   module           module dipswitch address
//     u16  level            tenths of a percent (0x03E8 = 100.0%); bit 0x0400
//                           marks an extended 14-byte entry
//     u8   reserved
//     u8[9] extended        present only when (level & 0x0400)
//
// Validated against the circuit and load lists shown by the CZone
// Configuration Tool for TestBench and Compass Rose (exact names, count,
// channel and module), live-tested circuit IDs on TestBench, and an exact
// table walk (count and byte length) on six production ZCFs.

function u16 (buf, p) { return buf.readUInt16LE(p) }
function u32 (buf, p) { return buf.readUInt32LE(p) }

function decodeOutputs (buf, start, end, count) {
  const outputs = []
  let p = start
  for (let i = 0; i < count; i++) {
    if (p + 5 > end) return null
    const raw = u16(buf, p + 2)
    const extended = (raw & 0x0400) !== 0
    const size = extended ? 14 : 5
    if (p + size > end) return null
    const level = raw & ~0x0400
    outputs.push({
      channel: buf[p],
      module: buf[p + 1],
      levelRaw: level,
      levelPercent: level / 10,
      extended,
      rawHex: buf.subarray(p, p + size).toString('hex')
    })
    p += size
  }
  return p === end ? outputs : null
}

function readRecord (buf, p, limit) {
  if (p + 8 > limit) return null
  const id = buf[p]
  const flags = u32(buf, p + 1)
  const category = u16(buf, p + 5)
  const nameLength = buf[p + 7]
  if (nameLength < 1 || p + 8 + nameLength > limit) return null
  const nameBytes = buf.subarray(p + 8, p + 8 + nameLength)
  if (nameBytes.some(c => c < 0x20)) return null
  let q = p + 8 + nameLength

  if (q + 6 > limit) return null
  const controlsLength = u32(buf, q)
  const controlCount = u16(buf, q + 4)
  if (controlsLength < 2 || (controlCount === 0) !== (controlsLength === 2)) return null
  if (q + 4 + controlsLength > limit) return null
  const controlsRaw = buf.subarray(q + 6, q + 4 + controlsLength)
  q += 4 + controlsLength

  if (q + 6 > limit) return null
  const outputsLength = u32(buf, q)
  const outputCount = u16(buf, q + 4)
  if (outputsLength < 2 || (outputCount === 0) !== (outputsLength === 2)) return null
  const outputsEnd = q + 4 + outputsLength
  if (outputsEnd > limit) return null
  const outputs = decodeOutputs(buf, q + 6, outputsEnd, outputCount)
  if (!outputs) return null

  return {
    offset: p,
    end: outputsEnd,
    id,
    name: nameBytes.toString('utf8'),
    flags,
    category,
    kind: (flags & 0x0400) ? 'logic' : (category === 0 ? 'mode' : 'circuit'),
    hidden: (flags & 0x0400) !== 0 || category === 0,
    controlCount,
    controlsHex: controlsRaw.toString('hex'),
    outputs
  }
}

// Try to read the whole table starting at a candidate header offset. Returns
// the records only if exactly recordCount records end exactly at tableLength.
function readTableAt (buf, h) {
  if (h + 10 > buf.length) return null
  const tableLength = u32(buf, h)
  const recordCount = u16(buf, h + 4)
  if (recordCount < 1 || tableLength < 6 || h + 4 + tableLength > buf.length) return null
  const limit = h + 4 + tableLength
  const records = []
  let p = h + 10
  for (let i = 0; i < recordCount; i++) {
    const r = readRecord(buf, p, limit)
    if (!r) return null
    records.push(r)
    p = r.end
  }
  if (p !== limit) return null
  markInternalDuplicates(records)
  return { offset: h, tableLength, recordCount, headerHex: buf.subarray(h + 6, h + 10).toString('hex'), records }
}

// A circuit with no controls (nothing can switch it from a display, keypad or
// input) that shares its name with a circuit that does have controls is an
// internal copy driven by logic, e.g. Meitaki "Audible Alarm" IDs 0x01/0x02
// alongside the user-facing 0x20. The Configuration Tool lists the name once.
// Zero-control circuits with a unique name (e.g. Sel Citron "Salon Air
// Conditioner", SugarShack solar chargers) are real and are left alone.
function markInternalDuplicates (records) {
  const byName = new Map()
  for (const r of records) {
    if (r.kind !== 'circuit') continue
    const key = r.name.trim()
    if (!byName.has(key)) byName.set(key, [])
    byName.get(key).push(r)
  }
  for (const group of byName.values()) {
    if (group.length < 2 || !group.some(r => r.controlCount > 0)) continue
    for (const r of group) {
      if (r.controlCount === 0) {
        r.kind = 'internal'
        r.hidden = true
      }
    }
  }
}

function parseCircuitTable (buf) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('parseCircuitTable expects a Buffer')
  for (let h = 0; h + 10 <= buf.length; h++) {
    const table = readTableAt(buf, h)
    if (table) return table
  }
  return null
}

function requireTable (buf) {
  const table = parseCircuitTable(buf)
  if (!table) throw new Error('CZone circuit table not found in ZCF')
  return table
}

// Circuits as listed (black) in the CZone Configuration Tool.
function parseCircuits (buf) {
  return requireTable(buf).records.filter(r => r.kind === 'circuit')
}

// Modes as listed (blue) in the CZone Configuration Tool. Outputs are the
// Mode's action list; levelPercent 0 = OFF.
function parseModes (buf) {
  return requireTable(buf).records.filter(r => r.kind === 'mode')
}

module.exports = { parseCircuitTable, parseCircuits, parseModes }
