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
  const list = () => { let out; routes['/circuits']({ query: {}, params: {} }, { json: v => { out = v } }); return out }
  const circuits = () => Object.fromEntries(list().circuits.map(c => [c.name, c]))
  const raw = (id, data) => listeners.get('canboatjs:rawoutput')(`2026-10-03T00:00:00.000Z R ${id} ${data}`)
  return { plugin, circuits, list, raw, deltas }
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
  // (Freezer / Fridge Temp Control are on too, but are not on any display.)
  // Instruments lists Autopilot's output (module 1 channel 0) first, then its
  // own (module 2 channel 11) and VHF's. Its state is its own load: on here,
  // with the autopilot off. Read from the first load listed it showed OFF.
  assert.deepStrictEqual(c.Instruments.ownOutputs, [{ module: 2, channel: 11 }])
  assert.deepStrictEqual(c.Instruments.alsoDrives, ['Autopilot', 'VHF'])
  assert.strictEqual(c.Instruments.statusModule, 2)
  assert.strictEqual(c.Instruments.statusBit, 11)
  assert.strictEqual(c.Autopilot.state.state, 'OFF')
  assert.deepStrictEqual(on, ['Anchor Light', 'Freezer', 'Fresh Water Pump', 'Instruments', 'Lights', 'Toilet', 'VHF'])
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
  assert.strictEqual(Object.keys(c).length, 22) // 35 less 7 virtual-switch circuits and 6 not on any display
  assert(!('Fridge 4⁰C' in c) && 'Fridge' in c)
  plugin.stop()
}

// --- Circuits no CZone display lists: none of their Circuit Controls is a
//     display ("All Display Interfaces", a named display or chartplotter, or
//     the Wireless Interface).
{
  const { hasDisplayControl } = require('../lib/fork-mapping')
  const hiddenIn = (name, settings = {}) => { const m = zcf.load(path.join(__dirname, 'fixtures', name)); prepareMapping(m, settings); return m.circuits.filter(c => c.hidden).map(c => c.name.trim()).sort() }

  // Compass Rose: "Freezer Temp Control" has one control, the switch input
  // "Signal K 0 : 4" on the Helm CXP (Configuration Tool, 3 Oct 2026).
  assert.deepStrictEqual(hiddenIn('Compass-Rose-03.10.26.zcf'), [
    'E/R Bilge Pump Running', 'E/R Blower', 'FWD Bilge Pump Running', 'Freezer Temp Control', 'Fridge Temp Control', 'High Bilge Water Alarm to Cerbo'])
  assert.deepStrictEqual(hiddenIn('Compass-Rose-03.10.26.zcf', { showNonDisplayCircuits: true }), [])

  // SugarShack: the wireless remote's buttons are switch inputs on COI 04.
  const ss = hiddenIn('SugarShack-20260927-01.zcf')
  for (const n of [1, 2, 3, 4]) assert(ss.includes(`Wireless Relay Button ${n}`))
  assert(!ss.includes('Starlink') && !ss.includes('Navigation Lights'))

  // Meitaki: nearly everything is on one named display, not "All Display
  // Interfaces"; those circuits stay.
  const mei = zcf.load(path.join(__dirname, 'fixtures', 'Meitaki-07.04.25.zcf'))
  prepareMapping(mei, {})
  const winch = mei.circuits.find(c => c.name.trim() === 'Control Volt. Winch Prt')
  assert.deepStrictEqual(winch.zcf.controls.map(k => k.module), [0xf0]) // Display Companionway only
  assert.strictEqual(winch.hidden, false)
  assert(mei.circuits.filter(c => c.hidden).length <= 5)

  // Sel Citron: touch screen and Wireless Interface used separately.
  const sel = zcf.load(path.join(__dirname, 'fixtures', 'Sel-Citron-02.04.25.zcf'))
  prepareMapping(sel, {})
  assert(sel.circuits.some(c => !c.hidden && c.zcf.controls.some(k => k.module === 0x07) && !c.zcf.controls.some(k => k.module === 0)))
  assert(sel.circuits.find(c => c.name.trim() === 'Anchor Drag Buzzer').hidden)

  // Bench: every circuit is on the display; nothing hidden.
  assert.deepStrictEqual(hiddenIn('TestBench-2026-10-01.zcf'), [])

  // No control list, or no module table: nothing is hidden on missing data.
  assert.strictEqual(hasDisplayControl({ zcf: {} }, new Map()), true)
  const noTable = zcf.load(path.join(__dirname, 'fixtures', 'Compass-Rose-03.10.26.zcf'))
  noTable.modules = []
  prepareMapping(noTable, {})
  assert.strictEqual(noTable.circuits.filter(c => c.hidden).length, 0)

  // The plugin: left out of /circuits (named in notShown), still published to Signal K.
  const { plugin, list, raw, deltas } = run('Compass-Rose-03.10.26.zcf')
  raw('1CFF0400', '27 99 01 36 0C 00 01 00') // module 01: channels 2, 3 and 16 on
  const out = list()
  assert(!out.circuits.some(c => c.name === 'Freezer Temp Control'))
  assert(out.notShown.includes('Freezer Temp Control') && out.notShown.length === 6)
  const published = deltas.flatMap(d => d.updates.flatMap(u => u.values.map(v => v.path)))
  assert(published.includes('electrical.czone.Freezer_Temp_Control.switch.state'))
  plugin.stop()
}

// --- A circuit's own loads: how it is wired, not everything it switches.
{
  const { ownLoads } = require('../lib/fork-mapping')
  const { buildCatalog } = require('../lib/monitor/catalog')
  const load = f => { const m = zcf.load(path.join(__dirname, 'fixtures', f)); prepareMapping(m, { showVirtualCircuits: true, showNonDisplayCircuits: true }); return m }
  const by = m => Object.fromEntries(m.circuits.map(c => [c.name.trim(), c]))

  // Bench: Light 5 lists the Buzzer's DC6 (channel 5) first, then its own DC5.
  const bench = by(load('TestBench-2026-10-01.zcf'))
  assert.deepStrictEqual(bench['Light 5'].ownOutputs, [{ module: 1, channel: 4 }])
  assert.deepStrictEqual(bench['Light 5'].alsoDrives, ['Buzzer'])
  assert.deepStrictEqual(bench.Buzzer.ownOutputs, [{ module: 1, channel: 5 }])
  assert.deepStrictEqual(bench.Buzzer.alsoDrives, [])
  assert.strictEqual(bench['Light 5'].statusBit, 4) // the status table already said so
  // Its current is its lamp, not lamp plus buzzer.
  const items = buildCatalog(fs.readFileSync(path.join(__dirname, 'fixtures', 'TestBench-2026-10-01.zcf'))).items
  assert.deepStrictEqual(items.find(i => i.group === 'Circuit current' && i.name === 'Light 5').outputs, [{ module: 1, channel: 4 }])
  assert.deepStrictEqual(items.find(i => i.group === 'Circuit current' && i.name === 'Buzzer').outputs, [{ module: 1, channel: 5 }])

  // Two loads of its own stay two (Compass Rose Fresh Water Pump); a virtual
  // switch is not a load (Freezer: channel 2 and VS 1).
  const cr = by(load('Compass-Rose-03.10.26.zcf'))
  assert.deepStrictEqual(cr['Fresh Water Pump'].ownOutputs, [{ module: 1, channel: 3 }, { module: 2, channel: 10 }])
  assert.deepStrictEqual(cr.Freezer.ownOutputs, [{ module: 1, channel: 2 }])
  // Seven loads of its own (Persevere Lighting).
  assert.strictEqual(by(load('Persevere-14.07.25.zcf')).Lighting.ownOutputs.length, 7)
  // A group owns nothing (SugarShack All Lights On), and keeps all its loads for current.
  const ss = by(load('SugarShack-20260927-01.zcf'))
  assert.deepStrictEqual(ss['All Lights On'].ownOutputs, [])
  assert.strictEqual(ss['All Lights On'].alsoDrives.length, 13)
  assert.deepStrictEqual(ss['Anchor Light'].ownOutputs, [{ module: 28, channel: 1 }])
  // Plain lists work too (the monitor's circuit list).
  const a = { name: 'A', outputs: [{ module: 1, channel: 0 }] }
  const b = { name: 'B', outputs: [{ module: 1, channel: 0 }, { module: 1, channel: 1 }] }
  const got = ownLoads([a, b], c => c.outputs)
  assert.deepStrictEqual(got.get(b), { own: [{ module: 1, channel: 1 }], alsoDrives: ['A'] })
  assert.deepStrictEqual(got.get(a), { own: [{ module: 1, channel: 0 }], alsoDrives: [] })
}

console.log('Fork mapping tests passed')
