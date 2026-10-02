'use strict'

const fs = require('fs')

// What the fork adjusts on the ZCF parser's result until the parser does it.
//
// 1. Circuit state. Some configurations (Compass Rose,
// Persevere) have no status table, so no circuit gets a statusModule/statusBit
// and PGN 65284 state is never decoded. Every circuit then reads OFF and the
// webapp can only ever send ON.
//
// On those networks the 65284 bitmap is simply the module's output channels:
// bit n = channel n. Proven on Compass Rose (3 Oct 2026): "Lights" is module 2
// channel 4, and switching it off at the display cleared bit 4 of module 02's
// bitmap (27 99 02 36 33 0E 01 00 -> 27 99 02 36 23 0E 01 00).
//
// Only applied when the ZCF gave no circuit a status mapping at all, so
// configurations with a status table (TestBench load masks, SugarShack, …)
// are untouched.
function applyStatusFallback (mapping) {
  if (!mapping || !Array.isArray(mapping.circuits)) return 0
  if (mapping.circuits.some(c => Number.isInteger(c.statusModule))) return 0
  let applied = 0
  for (const c of mapping.circuits) {
    if (!Number.isInteger(c.module) || !Number.isInteger(c.channel) || c.channel < 0 || c.channel > 31) continue
    c.statusModule = c.module
    c.statusBit = c.channel
    c.statusMask = (1 << c.channel) >>> 0
    c.statusFormat = 'module-channel'
    c.statusConfidence = 'inferred-no-status-table'
    applied++
  }
  return applied
}

// Circuit menu sub-categories (Configuration Tool, circuit dialog). The parser
// names five of them; this names them all.
//
// The 32-bit flags (record + 10) hold bits 16..31, the 16-bit category word
// (record + 14) holds the rest, in the order the dialog lists them:
//   flags bit 16 House/Habitat          24 Engine Management
//             17 Vessel Critical        25 Fans/Ventilation
//             18 Navigation             26 Lighting
//             19 Electronics            27 Vessel Management
//             20 24-Hour Circuits       28 Pumps
//             21 Communications         29 Propulsion Management
//             22 Accessories            30 Power
//             23 Indicators and Alarms  31 Refrigeration
//   word  bit 0 Entertainment, 1 Climate, 2 Appliances, 3 Other,
//         4 Favourites, 5 DC, 6 AC (master categories),
//         7..11 User Definable Circuit Display Category 1..5,
//         13 Bilge Pumps
// Seen ticked in the Configuration Tool: House/Habitat (Compass Rose "LPG"),
// Navigation, Lighting, Fans/Ventilation, Pumps, Power, Refrigeration,
// Entertainment. The rest follow from the dialog order and fit every circuit
// in the seven sample files (bit 21: VHF, Router, Starlink; bit 23: buzzers;
// word bit 1: air conditioners and diesel heaters; bit 2: washing machine,
// receptacles). Bilge Pumps is word bit 13 (0x2000): Compass Rose 03.10.26,
// "E/R Bilge Pump" and "FWD Bilge Pump" ticked Bilge Pumps and nothing else,
// are the only circuits with it and have no other category bit.
//
// The five user-definable categories are named in the General Settings tab.
// Their names are five length-prefixed strings in a small block straight
// after the backlight-zone table (Meitaki: Winches, Furlers, Lithium; Sel
// Citron: Telecommunications), so there are never more than five and a
// display never has more than 26 sub-menus.
const FLAG_CATEGORIES = {
  16: 'House/Habitat',
  17: 'Vessel Critical',
  18: 'Navigation',
  19: 'Electronics',
  20: '24-Hour Circuits',
  21: 'Communications',
  22: 'Accessories',
  23: 'Indicators and Alarms',
  24: 'Engine Management',
  25: 'Fans/Ventilation',
  26: 'Lighting',
  27: 'Vessel Management',
  28: 'Pumps',
  29: 'Propulsion Management',
  30: 'Power',
  31: 'Refrigeration'
}
const WORD_CATEGORIES = { 0: 'Entertainment', 1: 'Climate', 2: 'Appliances', 3: 'Other', 13: 'Bilge Pumps' }
const FIRST_USER_WORD_BIT = 7
const USER_CATEGORY_COUNT = 5

// One group per circuit where only one fits (the Victron switch pane), and the
// order the tags are listed in. A circuit ticked in several takes the first of
// these: the owner's own categories, then what the circuit does, then the
// categories that describe how it is managed.
const GROUP_PRIORITY = [
  'Indicators and Alarms', 'Navigation', 'Refrigeration', 'Bilge Pumps', 'Pumps', 'Lighting', 'Fans/Ventilation', 'Climate',
  'Entertainment', 'Appliances', 'Electronics', 'Communications', 'Engine Management', 'Propulsion Management',
  'Power', 'Vessel Management', 'Accessories', 'House/Habitat', 'Vessel Critical', '24-Hour Circuits', 'Other'
]

const rank = name => { const i = GROUP_PRIORITY.indexOf(name); return i < 0 ? GROUP_PRIORITY.length : i }
// The first of a list of sub-categories in GROUP_PRIORITY order (names not in
// the list, e.g. user-defined ones given without their flag, keep their place).
const primaryCategory = names => [...(names || [])].filter(Boolean).sort((a, b) => rank(a) - rank(b))[0] || null

function printable (buf) {
  for (const c of buf) if (c < 0x20 || c === 0x7f) return false
  return true
}

// Names of User Definable Circuit Display Category 1..5 ('' where unused), or
// [] when the block is not where it is expected.
//   file: … u8 nameLength @14 | vessel name | modules table | backlight table | block
//   table: u32 length | …            block: u8 length | 5 × (u8 n | name) | u8
function parseUserCategories (buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 32) return []
    let p = 15 + buf[14]
    for (let table = 0; table < 2; table++) {
      if (p + 7 > buf.length) return []
      const length = buf.readUInt32LE(p)
      if (length < 3 || length > 8192) return []
      p += 4 + length
    }
    if (p >= buf.length) return []
    const end = p + 1 + buf[p]
    if (end > buf.length) return []
    const names = []
    let q = p + 1
    for (let i = 0; i < USER_CATEGORY_COUNT; i++) {
      if (q >= end) return []
      const n = buf[q]
      if (n > 40 || q + 1 + n > end) return []
      const name = buf.subarray(q + 1, q + 1 + n)
      if (!printable(name)) return []
      names.push(name.toString('utf8').trim())
      q += 1 + n
    }
    return q + 1 === end ? names : []
  } catch (_) { return [] }
}

function rawCategory (circuit) {
  const cat = circuit && circuit.zcf && circuit.zcf.category
  if (!cat || typeof cat !== 'object' || !Number.isFinite(cat.subCategoryBits)) return null
  return { flags: cat.subCategoryBits >>> 0, word: Number.isFinite(cat.categoryWord) ? cat.categoryWord : 0 }
}

// Sets every circuit's subCategories (all ticked ones, most specific first),
// userSubCategories and group (the first of them). Returns how many circuits
// gained a category the parser had not named.
function applyCategories (mapping, userNames = []) {
  let changed = 0
  for (const c of (mapping && mapping.circuits) || []) {
    const raw = rawCategory(c)
    const before = Array.isArray(c.subCategories) ? c.subCategories.filter(Boolean) : []
    let names = before
    let user = []
    if (raw) {
      names = []
      for (const [bit, name] of Object.entries(FLAG_CATEGORIES)) if ((raw.flags >>> Number(bit)) & 1) names.push(name)
      for (const [bit, name] of Object.entries(WORD_CATEGORIES)) if ((raw.word >> Number(bit)) & 1) names.push(name)
      for (let i = 0; i < USER_CATEGORY_COUNT; i++) {
        if ((raw.word >> (FIRST_USER_WORD_BIT + i)) & 1) user.push(userNames[i] || `User Category ${i + 1}`)
      }
      for (const name of before) if (!names.includes(name) && !user.includes(name)) names.push(name) // anything the parser knows and this does not
    }
    names.sort((a, b) => rank(a) - rank(b))
    c.subCategories = [...user, ...names]
    c.userSubCategories = user
    c.group = c.subCategories[0] || c.masterCategory || null
    if (c.subCategories.some(n => !before.includes(n))) changed++
  }
  return changed
}

// A circuit that only drives virtual switches. Virtual switch n of a module is
// output channel 31 + n (VS 01 = 32, VS 06 = 37, VS 10 = 41), above every
// physical output, so "all outputs on channel 32 or higher" picks them out
// without relying on how anyone named them: on Compass Rose the Fridge 4/6/8 °C,
// Freezer 4/-12/-18 °C and Test VS circuits, on Sel Citron the two "VS - HWC"
// circuits. A circuit that also drives a real output (Freezer: channel 2 and
// VS 01) is a real circuit.
const FIRST_VIRTUAL_CHANNEL = 32
function isVirtualCircuit (circuit) {
  const outputs = circuit && circuit.zcf && Array.isArray(circuit.zcf.outputs) ? circuit.zcf.outputs : null
  const channels = outputs && outputs.length
    ? outputs.map(o => o.channel)
    : (Array.isArray(circuit && circuit.outputs) ? circuit.outputs.map(o => o.channel) : [circuit && circuit.channel])
  const known = channels.filter(Number.isInteger)
  return known.length > 0 && known.every(ch => ch >= FIRST_VIRTUAL_CHANNEL)
}

// Everything the fork adjusts on the parser's result, in one place, so the
// webapp, Signal K paths and the Victron switch pane all see the same circuits.
function prepareMapping (mapping, settings = {}) {
  const report = { inferredState: 0, categories: 0, virtualHidden: 0, userCategories: [] }
  if (!mapping || !Array.isArray(mapping.circuits)) return report
  try {
    if (mapping.filePath && fs.existsSync(mapping.filePath)) report.userCategories = parseUserCategories(fs.readFileSync(mapping.filePath))
  } catch (_) { /* names fall back to "User Category n" */ }
  report.categories = applyCategories(mapping, report.userCategories)
  if (settings.showVirtualCircuits !== true) {
    const before = mapping.circuits.length
    mapping.circuits = mapping.circuits.filter(c => !isVirtualCircuit(c))
    report.virtualHidden = before - mapping.circuits.length
  }
  report.inferredState = applyStatusFallback(mapping)
  return report
}

module.exports = { applyStatusFallback, applyCategories, parseUserCategories, isVirtualCircuit, prepareMapping, primaryCategory, FIRST_VIRTUAL_CHANNEL, GROUP_PRIORITY }
