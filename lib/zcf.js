'use strict'

const fs = require('fs')
const path = require('path')
const structuralZcf = require('./zcf-circuit-table')
const structuralStatus = require('./zcf-status-table')

// The ZCF is a proprietary binary configuration database.  We intentionally
// decode only structures for which we have empirical evidence. Unknown bytes
// are retained as offsets/raw hex where useful rather than guessed.


// Keep circuit path identity compatible with the established signalk-czone
// plugin.  Do not introduce a second naming convention for the same physical
// CZone circuit.
function slugify (name) {
  const text = String(name || 'CZoneCircuit').trim()
  const cleaned = text
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'CZoneCircuit'
}

function circuitSource (circuit) {
  // The ZCF circuit module byte identifies the CZone unit which owns the
  // circuit.  The supplied live configuration uses 0xF8 for the AC/ACOI
  // mapping, represented by the existing signalk-czone source as CZone-AC.11.
  // Other circuit modules are DC/COI units and use their ZCF unit ID in
  // decimal, e.g. module 0x14 -> CZone-DC.20.
  if (Number(circuit.module) === 0xF8) return 'CZone-AC.11'
  return `CZone-DC.${Number(circuit.module)}`
}

function modeSlugify (name) {
  return String(name)
    .trim()
    .replace(/[^A-Za-z0-9]+(.)/g, (_, ch) => ch.toUpperCase())
    .replace(/[^A-Za-z0-9]/g, '')
    .replace(/^[^A-Za-z]+/, '')
    .replace(/^./, ch => ch.toLowerCase()) || 'mode'
}

function uniqueSlugs (items) {
  const used = new Map()
  for (const item of items) {
    const base = slugify(item.name)
    const count = (used.get(base) || 0) + 1
    used.set(base, count)
    item.slug = count === 1 ? base : `${base}${count}`
  }
  return items
}

function signalKPaths (slug, capabilities) {
  const paths = { state: `electrical.czone.${slug}.switch.state` }
  if (capabilities && capabilities.dimmer) {
    paths.brightness = `electrical.czone.${slug}.switch.brightness`
  }
  return paths
}

function isModule (value) {
  // ZCF configuration-module IDs are not confined to the Sugar Shack range.
  // Valid fixtures include low IDs such as 0x01 as well as higher IDs and 0xF8.
  // The record signature, not an arbitrary module-number range, identifies a
  // primary circuit record. Module 0 is excluded because it is used by other
  // object/status tables in the same binary.
  return value > 0
}

function isAsciiName (buf, offset, length) {
  if (length < 1 || length > 120 || offset + length > buf.length) return false
  for (let i = offset; i < offset + length; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7e) return false
  }
  return true
}

function extractVesselName (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null

  // The supplied ZCF family uses a length-prefixed configuration/vessel name:
  // byte 14 is the ASCII name length and bytes 15.. contain the name. Earlier
  // code searched for a '}' terminator, which happened to work only for one
  // configuration family and could consume the following binary field.
  const length = buf[14]
  if (length < 1 || length > 120 || 15 + length > buf.length) return null
  if (!isAsciiName(buf, 15, length)) return null
  return buf.subarray(15, 15 + length).toString('ascii').trim() || null
}

function attachStatusMappings (records, statusMap, statusTable) {
  const outputMap = structuralStatus.buildStatusOutputMap(statusTable)

  return records.map(record => {
    let status = statusMap.get(record.name) || null
    let statusConfidence = status ? 'zcf-derived' : null
    let statusSource = 'status-name'

    // Some logical/virtual circuits have no same-named entry in the ZCF
    // status table.  If an extended output explicitly points at a runtime
    // status module/channel, use that structural relationship as the fallback.
    // Keep this conservative: only accept one unambiguous extended-output
    // match, never guess from a name or from arbitrary bytes.
    if (!status) {
      const candidates = []
      for (const output of record.zcf.outputs || []) {
        if (!output.extended || !Number.isInteger(output.module) || !Number.isInteger(output.channel)) continue
        const candidate = outputMap.get(`${output.module}:${output.channel}`) || null
        if (candidate && !candidates.some(x => x.offset === candidate.offset)) candidates.push(candidate)
      }
      if (candidates.length === 1) {
        status = candidates[0]
        statusConfidence = 'zcf-output-derived'
        statusSource = 'status-output'
      } else {
        // A virtual circuit can expose an intermediate DC/output object as
        // well as its actual AC load. In the supplied ZCF family the AC/ACOI
        // runtime module 0xF8 is the authoritative state identity for those
        // extended heater outputs. Prefer that explicit AC status identity
        // when it is present rather than binding the virtual circuit to an
        // unrelated same-channel DC status record.
        const acCandidates = candidates.filter(candidate => candidate.statusModule === 0xF8)
        if (acCandidates.length === 1) {
          status = acCandidates[0]
          statusConfidence = 'zcf-output-derived'
          statusSource = 'status-output'
        }
      }
    }

    return {
      ...record,
      statusModule: status ? status.statusModule : null,
      statusBit: status ? status.statusBit : null,
      statusMask: status ? status.statusMask : null,
      statusFormat: status ? status.statusFormat : null,
      statusConfidence,
      zcf: {
        ...record.zcf,
        statusRecord: status,
        statusSource,
        statusTableFormat: statusTable ? statusTable.format : null
      }
    }
  })
}

function findDimmingObject (buf, afterName) {
  // Empirically confirmed: exactly the 13 known dimmable circuits have an
  // associated control object beginning 0F 01 00 00 immediately after the
  // circuit name.  Keep this tied to the object boundary, not arbitrary
  // byte-searching through the file.
  const marker = Buffer.from([0x0F, 0x01, 0x00, 0x00])
  const window = buf.subarray(afterName, Math.min(buf.length, afterName + 32))
  const offset = window.indexOf(marker)
  return offset >= 0 ? { offset: afterName + offset, marker: '0f010000' } : null
}

const VERIFIED_CONTROL_PROFILES = Object.freeze({
  // Confirmed from the supplied live CAN captures. These are retained as
  // concrete evidence while the generic ZCF-derived mapping covers circuits
  // that have not yet been individually exercised.
  0x73: { parameter: 0x24, family: 'f1f2', confidence: 'capture' }, // Courtesy Blue
  0x21: { parameter: 0x24, family: 'f1f2', confidence: 'capture' }, // Deck Spot Lights
  0x35: { parameter: 0x24, family: 'f1f2', confidence: 'capture' }, // Piano Light
  0x2E: { parameter: 0x08, family: 'f1f2', confidence: 'capture' }, // Stereo
  0x29: { parameter: 0x08, family: 'f1f2', confidence: 'capture' }, // Stereo Amplifier
  0x1B: { parameter: 0x08, family: 'level', confidence: 'capture' }, // Galley Lights
  0x65: { parameter: 0x08, family: 'level', confidence: 'capture' }  // Sink Red Nighttime
})

// CZone circuit-menu category flags are stored in the six bytes immediately
// before the circuit name length. The 32-bit low portion is the sub-category
// bitmap; the following 16-bit value contains the master-category bits and
// the Entertainment flag used by this configuration. The standard CZone
// category names below are based on the CZone Configuration Tool menu and
// validated against the supplied Sugar Shack ZCF (rather than inferred from
// circuit names).
const ZONE_MASTER_CATEGORY_BITS = Object.freeze({
  Favorites: 0x10,
  DC: 0x20,
  AC: 0x40
})

// Confirmed against the supplied configuration:
//   Lighting     -> 0x04000000
//   Navigation   -> 0x00040000
//   Pumps        -> 0x10000000
//   Fans/Ventilation -> 0x02000000
//   Power        -> 0x40000000
//   Entertainment -> 0x0001 in the category word
// Other bits are retained as raw values until independently validated.
const ZONE_SUB_CATEGORY_BITS = Object.freeze({
  Lighting: 0x04000000,
  Navigation: 0x00040000,
  Pumps: 0x10000000,
  'Fans/Ventilation': 0x02000000,
  Power: 0x40000000
})

function decodeCircuitCategories (buf, p) {
  const subCategoryBits = buf.readUInt32LE(p + 10)
  const categoryWord = buf.readUInt16LE(p + 14)

  const masterCategories = Object.entries(ZONE_MASTER_CATEGORY_BITS)
    .filter(([, bit]) => (categoryWord & bit) !== 0)
    .map(([name]) => name)

  const subCategories = Object.entries(ZONE_SUB_CATEGORY_BITS)
    .filter(([, bit]) => (subCategoryBits & bit) !== 0)
    .map(([name]) => name)

  // Entertainment is stored in the low category word alongside the master
  // category bits. This is directly validated by Stereo, Starlink, Nemeis,
  // and Underwater Lights in the supplied ZCF; Underwater Lights also has the
  // Lighting sub-category in the 32-bit bitmap.
  if ((categoryWord & 0x01) !== 0) subCategories.push('Entertainment')

  const knownSubBits = Object.values(ZONE_SUB_CATEGORY_BITS)
    .reduce((mask, bit) => mask | bit, 0)
  const knownMasterBits = Object.values(ZONE_MASTER_CATEGORY_BITS)
    .reduce((mask, bit) => mask | bit, 0) | 0x01

  return {
    masterCategories,
    subCategories,
    userSubCategories: [],
    raw: {
      subCategoryBits,
      categoryWord,
      unknownSubCategoryBits: subCategoryBits & ~knownSubBits,
      unknownCategoryWordBits: categoryWord & ~knownMasterBits,
      hex: buf.subarray(p + 10, p + 16).toString('hex')
    }
  }
}

function decodeStructuralCategories (record) {
  const category = record.category >>> 0
  const flags = record.flags >>> 0
  const masterCategories = []
  if (category & ZONE_MASTER_CATEGORY_BITS.DC) masterCategories.push('DC')
  if (category & ZONE_MASTER_CATEGORY_BITS.AC) masterCategories.push('AC')

  const subCategories = []
  for (const [name, bit] of Object.entries(ZONE_SUB_CATEGORY_BITS)) {
    if ((flags & bit) !== 0) subCategories.push(name)
  }
  if ((category & 0x01) !== 0) subCategories.push('Entertainment')

  const knownSubBits = Object.values(ZONE_SUB_CATEGORY_BITS)
    .reduce((mask, bit) => mask | bit, 0) >>> 0
  const knownMasterBits = (Object.values(ZONE_MASTER_CATEGORY_BITS)
    .reduce((mask, bit) => mask | bit, 0) | 0x01) >>> 0

  return {
    masterCategories,
    subCategories,
    userSubCategories: [],
    raw: {
      subCategoryBits: flags,
      categoryWord: category,
      unknownSubCategoryBits: flags & ~knownSubBits,
      unknownCategoryWordBits: category & ~knownMasterBits,
      hex: `${flags.toString(16).padStart(8, '0')}${category.toString(16).padStart(4, '0')}`
    }
  }
}

function parseCircuitRecords (buf, modules = [], circuitTable = null, statusTable = null) {
  // Walk the structural CZone circuit table. This is deliberately based on
  // the table's length/count fields and each record's own control/output
  // lengths rather than searching for a circuit signature through the file.
  const structuralTable = circuitTable || structuralZcf.parseCircuitTable(buf)
  const structural = structuralTable.records.filter(r => r.kind === 'circuit')
  const statusMap = structuralStatus.buildStatusMap(statusTable)
  const records = []

  for (const record of structural) {

    const primary = record.outputs[0] || null
    const channel = primary ? primary.channel : null
    const module = primary ? primary.module : null

    const zcfCircuitId = record.id
    const name = record.name
    const nameOffset = record.offset + 8
    const afterName = nameOffset + name.length
    const dimmerObject = findDimmingObject(buf, afterName)
    const categories = decodeStructuralCategories(record)

    const profile = VERIFIED_CONTROL_PROFILES[zcfCircuitId] || (dimmerObject
      ? { parameter: 0x24, family: 'level', confidence: 'zcf-dimmer-capture' }
      : { parameter: 0x08, family: 'f1f2', confidence: 'zcf-derived' })

    records.push({
      name,
      module,
      source: primary && module > 0 ? circuitSource({ module }) : 'CZone-Unknown',
      channel,
      page: Number.isInteger(channel) ? Math.floor(channel / 8) : null,
      slot: Number.isInteger(channel) ? channel % 8 : null,
      zcfCircuitId,
      protocolCircuitId: zcfCircuitId,
      protocolParameter: profile.parameter,
      protocolOperationFamily: profile.family,
      protocolConfidence: profile.confidence,
      capabilities: {
        switch: true,
        dimmer: Boolean(dimmerObject)
      },
      masterCategories: categories.masterCategories,
      masterCategory: categories.masterCategories.find(name => name === 'DC' || name === 'AC') || null,
      subCategories: categories.subCategories,
      userSubCategories: categories.userSubCategories,
      controlCount: record.controlCount,
      zcf: {
        category: categories.raw,
        offset: record.offset,
        nameOffset,
        nameLength: name.length,
        flags: record.flags,
        controlsHex: record.controlsHex,
        controlsTrailingHex: record.controlsTrailingHex,
        controls: record.controls.map(control => ({
          ...control,
          controlModuleId: control.module,
          controlModuleName: control.module === 0
            ? 'All Display Interfaces'
            : (modules.find(m => m.module === control.module)?.name || null),
          controlModule: control.module === 0
            ? 'All Display Interfaces'
            : (modules.find(m => m.module === control.module)?.name || null)
        })),
        outputCount: record.outputs.length,
        outputs: record.outputs,
        dimmerObject
      }
    })
  }

  return uniqueSlugs(attachStatusMappings(records, statusMap, statusTable))
}

function findModeHeaders (buf) {
  const modes = []
  for (let p = 2; p + 6 <= buf.length; p++) {
    // Observed mode header:
    //   [runtime/control ID] 00 01 [mode ID LE] 00 00 [name length] [ASCII name]
    // The one-byte runtime/control ID is what the live 27 99 command uses;
    // the following 16-bit ID is the ZCF configuration/object ID.
    if (buf[p] !== 0x01 || buf[p + 3] !== 0x00 || buf[p + 4] !== 0x00) continue
    const runtimeId = buf[p - 2]
    const modeGroupId = buf[p]
    const id = buf.readUInt16LE(p + 1)
    const nameLength = buf[p + 5]
    if (id < 900 || id > 2000 || !isAsciiName(buf, p + 6, nameLength)) continue
    const name = buf.subarray(p + 6, p + 6 + nameLength).toString('ascii')
    modes.push({ offset: p - 2, runtimeId, modeGroupId, id, name, nameLength, nameOffset: p + 6 })
    p += 5 + nameLength
  }
  return modes
}

function parseModeRecords (buf, circuits) {
  const headers = findModeHeaders(buf)

  return headers.map((h, i) => {
    const afterName = h.nameOffset + h.nameLength
    const next = i + 1 < headers.length ? headers[i + 1].offset : Math.min(buf.length, afterName + 512)
    const end = Math.min(next, afterName + 512)
    const raw = buf.subarray(afterName, end)

    // Empirically decoded mode structure:
    //   0..16  mode metadata
    //   17     action count
    //   18     reserved/padding byte
    //   19..   repeated 5-byte action records:
    //          [target byte 0][target byte 1][value LE uint16][00]
    //
    // Target references are ZCF object references. They are NOT guaranteed
    // to equal a primary circuit record's (channel,module) identity.
    const actionCount = raw.length > 17 ? raw[17] : 0
    const actionStart = 19
    const availableBytes = Math.max(0, raw.length - actionStart)
    const availableActions = Math.floor(availableBytes / 5)
    const truncated = availableActions < actionCount

    const actions = []
    for (let j = 0; j < Math.min(actionCount, availableActions); j++) {
      const p = actionStart + j * 5
      actions.push({
        index: j,
        target: {
          byte0: raw[p],
          byte1: raw[p + 1],
          hex: `${raw[p].toString(16).padStart(2, '0')}${raw[p + 1].toString(16).padStart(2, '0')}`
        },
        value: raw.readUInt16LE(p + 2),
        valuePercent: raw.readUInt16LE(p + 2) / 10,
        terminator: raw[p + 4]
      })
    }

    return {
      id: h.id,
      runtimeId: h.runtimeId,
      modeGroupId: h.modeGroupId,
      name: h.name,
      slug: modeSlugify(h.name),
      signalK: { state: `electrical.czone.modes.${modeSlugify(h.name)}.switch.state` },
      actionCount,
      parsedActionCount: actions.length,
      actions,
      truncated,
      zcf: {
        offset: h.offset,
        nameOffset: h.nameOffset,
        nameLength: h.nameLength,
        rawPayloadHex: raw.toString('hex')
      }
    }
  })
}




function parseModuleDeclarations (buf) {
  // The module table immediately follows the length-prefixed vessel/config
  // name. The byte immediately after the u32 table length is the device
  // count. Each record has one trailing byte after its name; consume it as
  // part of the record rather than resynchronizing byte-by-byte.
  //
  //   u32le tableLength
  //   u8  deviceCount
  //   u8[2] table header
  //   deviceCount * {
  //     u8 module
  //     u8 type
  //     u8 flags
  //     u8 rawNameLength (high bit is a record flag)
  //     u8[] name
  //     u8 trailing
  //   }
  if (!Buffer.isBuffer(buf) || buf.length < 20) return []
  const nameLength = buf[14]
  if (nameLength < 1 || nameLength > 120 || 15 + nameLength > buf.length) return []

  const tableStart = 15 + nameLength
  if (tableStart + 7 > buf.length) return []
  const tableLength = buf.readUInt32LE(tableStart)
  const deviceCount = buf[tableStart + 4]
  const recordsStart = tableStart + 7
  const recordsEnd = tableStart + 4 + tableLength
  if (deviceCount === 0 || recordsEnd > buf.length || recordsStart > recordsEnd) return []

  const modules = []
  const seen = new Set()
  let p = recordsStart

  for (let i = 0; i < deviceCount; i++) {
    if (p + 4 > recordsEnd) return []
    const module = buf[p]
    const type = buf[p + 1]
    const flags = buf[p + 2]
    const rawNameLength = buf[p + 3]
    const decodedNameLength = rawNameLength & 0x7F
    const nameEnd = p + 4 + decodedNameLength
    const recordEnd = nameEnd + 1

    if (decodedNameLength < 1 || recordEnd > recordsEnd ||
      !isAsciiName(buf, p + 4, decodedNameLength)) return []

    if (module !== 0 && !seen.has(module)) {
      modules.push({
        module,
        type,
        flags,
        name: buf.subarray(p + 4, nameEnd).toString('ascii'),
        offset: p,
        rawNameLength,
        trailing: buf[nameEnd]
      })
      seen.add(module)
    }
    p = recordEnd
  }

  if (p !== recordsEnd) return []
  return modules.sort((a, b) => a.module - b.module)
}

function load (filePath) {
  if (!filePath || typeof filePath !== 'string') throw new Error('No ZCF file path configured')
  const resolved = path.resolve(filePath)
  const buf = fs.readFileSync(resolved)
  if (buf.length < 32) throw new Error('ZCF file is too small')

  const modules = parseModuleDeclarations(buf)
  const circuitTable = structuralZcf.parseCircuitTable(buf)
  const statusTable = structuralStatus.parseStatusTable(buf, circuitTable)
  const circuits = parseCircuitRecords(buf, modules, circuitTable, statusTable)
  if (!circuits.length) throw new Error('No CZone circuit records found in ZCF')
  for (const circuit of circuits) {
    circuit.signalK = signalKPaths(circuit.slug, circuit.capabilities)
  }

  const modes = parseModeRecords(buf, circuits)
  const warnings = []
  const duplicateNames = circuits.map(x => x.name).filter((name, i, all) => all.indexOf(name) !== i)
  if (duplicateNames.length) warnings.push(`Duplicate circuit names: ${[...new Set(duplicateNames)].join(', ')}`)

  return {
    statusTable: statusTable ? { format: statusTable.format, recordCount: statusTable.recordCount, offset: statusTable.start, tableLength: statusTable.tableLength } : null,
    fileName: path.basename(resolved),
    filePath: resolved,
    fileSize: buf.length,
    vesselName: extractVesselName(buf),
    modules,
    moduleAddresses: modules.map(module => module.module),
    circuits,
    modes,
    warnings
  }
}

function findStatusRecord (buf, name) {
  const circuitTable = structuralZcf.parseCircuitTable(buf)
  const statusTable = structuralStatus.parseStatusTable(buf, circuitTable)
  return structuralStatus.buildStatusMap(statusTable).get(String(name)) || null
}

module.exports = { parseCircuitRecords, parseModeRecords, findModeHeaders, findStatusRecord, extractVesselName, parseModuleDeclarations, load }
