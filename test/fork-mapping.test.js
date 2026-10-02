'use strict'

// Configurations without a ZCF status table (Compass Rose, Persevere): circuit
// state comes from PGN 65284 with bit n = output channel n. Frames below are
// from Compass Rose, 3 Oct 2026 ("Lights" switched off at the CZone display).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')
const { applyStatusFallback, isVirtualCircuit, prepareMapping } = require('../lib/fork-mapping')
const zcf = require('../lib/zcf')

function run (fixture) {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-fallback-'))
  const listeners = new Map()
  const deltas = []
  const app = {
    config: { configPath },
    isNmea2000OutAvailable: true,
    on: (event, fn) => listeners.set(event, fn),
    removeListener: event => listeners.delete(event),
    emit: () => {},
    debug: () => {},
    registerPutHandler: () => {},
    handleMessage: (_id, delta) => deltas.push(delta),
    setPluginStatus: () => {},
    getSelfPath: () => undefined
  }
  const plugin = pluginFactory(app)
  const dir = path.join(configPath, 'plugin-config-data', 'signalk-czone-circuits')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(__dirname, 'fixtures', fixture), path.join(dir, 'installation.zcf'))
  plugin.start({ monitorWire: false })
  const routes = {}
  plugin.registerWithRouter({ get: (p, fn) => { routes[p] = fn }, post: () => {}, put: () => {} })
  const circuits = () => { let out; routes['/circuits']({ query: {}, params: {} }, { json: v => { out = v } }); return Object.fromEntries(out.circuits.map(c => [c.name, c])) }
  const raw = (id, data) => listeners.get('canboatjs:rawoutput')(`2026-10-03T00:00:00.000Z R ${id} ${data}`)
  return { plugin, circuits, raw, deltas }
}

{
  const { plugin, circuits, raw } = run('Compass-Rose-28.06.26.zcf')
  raw('1CFF0402', '27 99 02 36 33 0E 01 00')
  raw('1CFF0400', '27 99 01 36 0C 00 01 00')
  let c = circuits()
  assert.strictEqual(c.Lights.statusModule, 2)
  assert.strictEqual(c.Lights.statusBit, 4)
  assert.strictEqual(c.Lights.statusConfidence, 'inferred-no-status-table')
  const on = Object.values(c).filter(x => x.state && x.state.state === 'ON').map(x => x.name).sort()
  assert.deepStrictEqual(on, ['Anchor Light', 'Freezer', 'Freezer Temp Control', 'Fresh Water Pump', 'Fridge Temp Control', 'Lights', 'Toilet', 'VHF'])
  assert.strictEqual(c['Nav Lights'].state.state, 'OFF')
  // Display switches Lights off: bit 4 of module 02 clears.
  raw('1CFF0402', '27 99 02 36 23 0E 01 00')
  c = circuits()
  assert.strictEqual(c.Lights.state.state, 'OFF')
  assert.strictEqual(c['Anchor Light'].state.state, 'ON')
  // Virtual-switch circuits (setpoints) are hidden by default.
  assert(!('Fridge 4⁰C' in c))
  plugin.stop()
}

// A configuration that has a status table is left exactly as the parser made it.
{
  const mapping = zcf.load(path.join(__dirname, 'fixtures', 'TestBench.zcf'))
  const before = JSON.stringify(mapping.circuits.map(c => [c.name, c.statusModule, c.statusBit, c.statusMask]))
  assert(mapping.circuits.some(c => Number.isInteger(c.statusModule)))
  assert.strictEqual(applyStatusFallback(mapping), 0)
  assert.strictEqual(JSON.stringify(mapping.circuits.map(c => [c.name, c.statusModule, c.statusBit, c.statusMask])), before)
}

// --- Virtual-switch circuits and the Refrigeration category (Compass Rose).
{
  const VIRTUAL = ['Freezer -12⁰C', 'Freezer -18⁰C', 'Freezer 4⁰C', 'Fridge 4⁰C', 'Fridge 6⁰C', 'Fridge 8⁰C', 'Test VS']
  const load = () => zcf.load(path.join(__dirname, 'fixtures', 'Compass-Rose-28.06.26.zcf'))
  const all = load()
  assert.deepStrictEqual(all.circuits.filter(isVirtualCircuit).map(c => c.name).sort(), VIRTUAL)
  const hidden = load()
  const report = prepareMapping(hidden, {})
  assert.strictEqual(report.virtualHidden, 7)
  assert.strictEqual(hidden.circuits.length, all.circuits.length - 7)
  const byName = Object.fromEntries(hidden.circuits.map(c => [c.name, c]))
  // Freezer drives a real output (channel 2) as well as VS 01: it stays.
  assert(byName.Freezer && byName.Fridge && !byName['Test VS'])
  for (const name of ['Freezer', 'Fridge', 'Freezer Temp Control', 'Fridge Temp Control']) assert.deepStrictEqual(byName[name].subCategories, ['Refrigeration'])
  assert.deepStrictEqual(byName.Lights.subCategories, ['Lighting'])
  assert.deepStrictEqual(byName['AFT Outlets'].subCategories, [])
  // Opt in to see them.
  const shown = load()
  assert.strictEqual(prepareMapping(shown, { showVirtualCircuits: true }).virtualHidden, 0)
  assert.strictEqual(shown.circuits.length, all.circuits.length)
}

// --- Every sub-category named, user-defined ones read from the ZCF, and one
//     group per circuit.
{
  const { parseUserCategories, primaryCategory } = require('../lib/fork-mapping')
  const load = name => { const m = zcf.load(path.join(__dirname, 'fixtures', name)); const report = prepareMapping(m, {}); return { report, by: Object.fromEntries(m.circuits.map(c => [c.name.trim(), c])) } }
  const names = name => parseUserCategories(fs.readFileSync(path.join(__dirname, 'fixtures', name)))

  // User Definable Circuit Display Category 1..5 (General Settings tab).
  assert.deepStrictEqual(names('Meitaki-07.04.25.zcf'), ['Winches', 'Furlers', 'Lithium', '', ''])
  assert.deepStrictEqual(names('Sel-Citron-02.04.25.zcf'), ['Telecommunications', '', '', '', ''])
  for (const f of ['Compass-Rose-28.06.26.zcf', 'Persevere-14.07.25.zcf', 'SugarShack-20260927-01.zcf', 'TestBench-2026-10-01.zcf', 'TestBench.zcf']) assert.deepStrictEqual(names(f), ['', '', '', '', ''], f)
  assert.deepStrictEqual(parseUserCategories(Buffer.alloc(10)), [])

  // Compass Rose: LPG is ticked House/Habitat in the Configuration Tool.
  const cr = load('Compass-Rose-28.06.26.zcf').by
  assert.deepStrictEqual(cr.LPG.subCategories, ['House/Habitat'])
  assert.deepStrictEqual([cr.VHF.group, cr['Nav Lights'].group, cr.Stereo.group, cr.Fridge.group, cr['Fresh Water Pump'].group], ['Communications', 'Navigation', 'Entertainment', 'Refrigeration', 'Pumps'])
  assert.strictEqual(cr['AFT Outlets'].group, 'DC') // nothing ticked: stays under its master category

  // Compass Rose 03.10.26, categories tidied up in the Configuration Tool: the
  // two bilge pumps are ticked Bilge Pumps only (category word bit 13).
  const cr2 = load('Compass-Rose-03.10.26.zcf').by
  assert.deepStrictEqual(cr2['E/R Bilge Pump'].subCategories, ['Bilge Pumps'])
  assert.strictEqual(cr2['FWD Bilge Pump'].group, 'Bilge Pumps')
  assert.strictEqual(cr2['E/R Bilge Pump Running'].group, 'Indicators and Alarms')
  assert.deepStrictEqual([cr2['Fresh Water Pump'].group, cr2['Engine Room Lights'].group, cr2.Instruments.group, cr2.Autopilot.group], ['Pumps', 'Lighting', 'Vessel Management', 'Vessel Management'])
  assert.strictEqual(Object.values(cr2).filter(c => c.group === 'DC' || c.group === 'AC').length, 0) // nothing left uncategorised
  assert.strictEqual(primaryCategory(['Pumps', 'Bilge Pumps']), 'Bilge Pumps')

  // Meitaki: the owner's own categories come first.
  const mei = load('Meitaki-07.04.25.zcf')
  assert.deepStrictEqual(mei.report.userCategories, ['Winches', 'Furlers', 'Lithium', '', ''])
  assert.deepStrictEqual(mei.by['Control Volt. Winch Prt'].subCategories, ['Winches', 'Power'])
  assert.strictEqual(mei.by['Control Volt. Winch Prt'].group, 'Winches')
  assert.strictEqual(mei.by['Furler Jib - IN'].group, 'Furlers')
  assert.strictEqual(mei.by['Lithium - Charge Battery'].group, 'Lithium')

  // Sel Citron and Persevere: names the parser did not have.
  const sel = load('Sel-Citron-02.04.25.zcf').by
  assert.strictEqual(sel['Starlink Router'].group, 'Telecommunications')
  assert(sel['Salon Air Conditioner'].subCategories.includes('Climate'))
  assert(sel['Washing Machine'].subCategories.includes('Appliances'))
  const per = load('Persevere-14.07.25.zcf').by
  assert(per.Starlink.subCategories.includes('Communications') && per.Starlink.subCategories.includes('Accessories'))
  assert.strictEqual(per.Starlink.group, 'Communications')

  // No circuit in any sample is left with a bit that has no name.
  for (const f of fs.readdirSync(path.join(__dirname, 'fixtures'))) {
    const m = zcf.load(path.join(__dirname, 'fixtures', f))
    prepareMapping(m, { showVirtualCircuits: true })
    for (const c of m.circuits) {
      const bits = c.zcf.category.subCategoryBits >>> 0
      const word = c.zcf.category.categoryWord
      const ones = n => n.toString(2).split('1').length - 1
      const ticked = ones(bits) + ones(word & 0x0f) + ones((word >> 7) & 0x1f) + ones(word & 0x2000)
      assert.strictEqual(c.subCategories.length, ticked, `${f}: ${c.name}`)
      assert.strictEqual(bits & 0xffff, 0, `${f}: ${c.name} uses a low flag bit`)
      assert.strictEqual(word & 0xd000, 0, `${f}: ${c.name} uses an unnamed category-word bit`)
    }
  }
  assert.strictEqual(primaryCategory(['Lighting', 'Navigation']), 'Navigation')
  assert.strictEqual(primaryCategory([]), null)
}

// Sel Citron: the two "VS - HWC" circuits are the only ones on virtual channels.
{
  const m = zcf.load(path.join(__dirname, 'fixtures', 'Sel-Citron-02.04.25.zcf'))
  assert.deepStrictEqual(m.circuits.filter(isVirtualCircuit).map(c => c.name.trim()).sort(), ['VS - HWC Port', 'VS - HWC STBD'])
}

// The plugin itself: hidden from /circuits, so also from Signal K and the pane.
{
  const { plugin, circuits } = run('Compass-Rose-28.06.26.zcf')
  const c = circuits()
  assert.strictEqual(Object.keys(c).length, 28)
  assert(!('Fridge 4⁰C' in c) && 'Fridge' in c)
  plugin.stop()
}

console.log('Fork mapping tests passed')
