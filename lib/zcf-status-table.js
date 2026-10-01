'use strict'

// Structural decoders for the status/load table immediately following the
// primary CZone circuit table.  This deliberately does not search the ZCF
// for names or magic byte signatures: the circuit-table boundary, table
// length/count, record boundaries and record name lengths define the data.

function isAsciiName (buf, offset, length) {
  if (length < 1 || length > 120 || offset + length > buf.length) return false
  for (let i = offset; i < offset + length; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7e) return false
  }
  return true
}

function tableHeader (buf, start) {
  if (start + 6 > buf.length) return null
  const tableLength = buf.readUInt32LE(start)
  const recordCount = buf.readUInt16LE(start + 4)
  const end = start + 4 + tableLength
  if (tableLength < 6 || recordCount < 1 || end > buf.length) return null
  return { start, tableLength, recordCount, end }
}

function decodeNamedStatusTable (buf, start) {
  const table = tableHeader(buf, start)
  if (!table || start + 7 > buf.length) return null

  // Sugar Shack / Meitaki / Sel Citron family: a one-byte table/header
  // value follows the count, then each status record is a 17-byte header plus
  // its name. The header byte varies by configuration, so it is retained but
  // not used as a record signature.

  let p = start + 7
  const records = []
  for (let i = 0; i < table.recordCount; i++) {
    if (p + 17 > table.end) return null
    const nameLength = buf[p + 16]
    if (!isAsciiName(buf, p + 17, nameLength) || p + 17 + nameLength > table.end) return null

    const statusBit = buf[p]
    const statusModule = buf[p + 1]
    if (statusModule === 0) return null

    records.push({
      offset: p,
      name: buf.subarray(p + 17, p + 17 + nameLength).toString('ascii'),
      statusBit: statusBit <= 31 ? statusBit : null,
      statusMask: statusBit <= 31 ? (1 << statusBit) >>> 0 : null,
      statusModule,
      statusFormat: 'status-table-bit-record',
      rawHeaderHex: buf.subarray(p, p + 17).toString('hex')
    })
    p += 17 + nameLength
  }

  if (p !== table.end) return null
  return { ...table, format: 'status-table-bit-record', records }
}

function decodeLoadStatusTable (buf, start) {
  const table = tableHeader(buf, start)
  if (!table || start + 8 > buf.length) return null

  // TestBench load table family: 12 00 header, followed by records with a
  // module byte at offset 0, a 32-bit logical mask at offset 12, a name
  // length at offset 16, and one output-number byte after the name. The final
  // output-number byte sits immediately after the table's declared end in the
  // supplied fixture family; the mask/name data itself is table-bounded.
  if (buf[start + 6] !== 0x12 || buf[start + 7] !== 0x00) return null

  let p = start + 8
  const records = []
  for (let i = 0; i < table.recordCount; i++) {
    if (p + 17 > table.end + 1) return null
    const nameLength = buf[p + 16]
    const nameEnd = p + 17 + nameLength
    if (!isAsciiName(buf, p + 17, nameLength)) return null
    if (nameEnd > table.end + 1) return null

    const statusModule = buf[p]
    const statusMask = buf.readUInt32LE(p + 12) >>> 0
    if (statusModule === 0 || statusMask === 0) return null

    const outputNumber = nameEnd < buf.length ? buf[nameEnd] : null
    const firstBit = 31 - Math.clz32(statusMask)

    records.push({
      offset: p,
      name: buf.subarray(p + 17, nameEnd).toString('ascii'),
      statusBit: firstBit,
      statusMask,
      statusModule,
      outputNumber,
      statusFormat: 'load-table-mask',
      rawHeaderHex: buf.subarray(p, Math.min(nameEnd, buf.length)).toString('hex')
    })

    p = nameEnd + 1
  }

  // The TestBench family leaves the last output-number byte just beyond the
  // declared table end. Accept exactly that one-byte tail, but never scan
  // past it or search the surrounding file.
  if (p !== table.end && p !== table.end + 1) return null
  return { ...table, format: 'load-table-mask', records }
}

function parseStatusTable (buf, circuitTable) {
  if (!Buffer.isBuffer(buf) || !circuitTable) return null
  const start = circuitTable.offset + 4 + circuitTable.tableLength

  return decodeNamedStatusTable(buf, start) ||
    decodeLoadStatusTable(buf, start)
}

function buildStatusMap (statusTable) {
  const map = new Map()
  if (!statusTable) return map

  for (const record of statusTable.records) {
    // Names are the stable object key available in these status-table
    // families. Refuse ambiguous duplicate names rather than guessing.
    if (map.has(record.name)) map.set(record.name, null)
    else if (Number.isInteger(record.statusBit) && Number.isInteger(record.statusMask)) map.set(record.name, record)
  }
  return map
}

function buildStatusOutputMap (statusTable) {
  const map = new Map()
  if (!statusTable) return map

  for (const record of statusTable.records) {
    if (!Number.isInteger(record.statusModule) || !Number.isInteger(record.statusBit) || !Number.isInteger(record.statusMask)) continue
    const key = `${record.statusModule}:${record.statusBit}`
    if (map.has(key)) map.set(key, null)
    else map.set(key, record)
  }
  return map
}

module.exports = {
  parseStatusTable,
  buildStatusMap,
  buildStatusOutputMap,
  decodeNamedStatusTable,
  decodeLoadStatusTable
}
