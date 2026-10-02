'use strict'

// A circuit's temperature, picked up by name alone: the temperature input is
// called "<circuit name> Temperature". Compass Rose (ZCF of 3 Oct 2026):
// circuits Fridge and Freezer, inputs "Fridge Temperature" and "Freezer
// Temperature" (third-party senders, NMEA 2000 source refrigeration / freezer).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildCatalog, temperatureLinks } = require('../lib/monitor/catalog')
const { createMonitor } = require('../lib/monitor')
const { labelWith, stripSuffix, temperatureText, temperatureUnitFrom, createVictronSwitches } = require('../lib/victron/switches')

const fixture = name => path.join(__dirname, 'fixtures', name)

// --- Which circuits pair with which inputs.
{
  const cr = buildCatalog(fs.readFileSync(fixture('Compass-Rose-03.10.26.zcf')))
  assert.deepStrictEqual(cr.links.map(l => [l.circuit, l.input, l.path]), [
    ['Freezer', 'Freezer Temperature', 'electrical.czone.Freezer.temperature'],
    ['Fridge', 'Fridge Temperature', 'electrical.czone.Fridge.temperature']])
  // No temperature inputs configured: nothing pairs (Sel Citron, Meitaki, SugarShack, Persevere).
  for (const f of ['Sel-Citron-02.04.25.zcf', 'Meitaki-07.04.25.zcf', 'SugarShack-20260927-01.zcf', 'Persevere-14.07.25.zcf']) {
    assert.deepStrictEqual(buildCatalog(fs.readFileSync(fixture(f))).links, [], f)
  }
  // Bench: "Ruuvi Tag" and "Victron Temp Sensor" are not named after a circuit.
  assert.deepStrictEqual(buildCatalog(fs.readFileSync(fixture('TestBench-2026-10-01.zcf'))).links, [])

  // The rule itself.
  const circuits = ['Cockpit Freezer', 'Freezer', 'Freezer Temp Control', 'Fridge - Salon', 'Hot Water Cylinder', 'Lights'].map((name, id) => ({ id, name, outputs: [] }))
  const temp = name => ({ id: name, name, group: 'Temperatures', readings: [{}] })
  const links = temperatureLinks(circuits, [temp('Cockpit Freezer Temperature'), temp('FREEZER TEMP'), temp('Fridge Salon Temperature'), temp('Engine Room Temperature'), temp('Hot Water Cylinder Temperature - High'), { id: 'x', name: 'Lights Temperature', group: 'Tanks', readings: [{}] }])
  assert.deepStrictEqual(links.map(l => [l.circuit, l.input]), [['Cockpit Freezer', 'Cockpit Freezer Temperature'], ['Freezer', 'FREEZER TEMP'], ['Fridge - Salon', 'Fridge Salon Temperature']])
  // Two inputs with the same name: neither is trusted.
  assert.deepStrictEqual(temperatureLinks(circuits, [temp('Freezer Temperature'), temp('Freezer Temp')]), [])
}

// --- The label: temperature, then current while on; same place in the GX's
//     alphabetical list either way; compact form before the name is cut.
{
  const K = c => c + 273.15
  assert.strictEqual(labelWith('Freezer', K(-8.2), 2.9, 'C'), 'Freezer (-8.2 °C, 2.9 A)')
  assert.strictEqual(labelWith('Fridge', K(5.06), null, 'C'), 'Fridge (5.1 °C)')
  assert.strictEqual(labelWith('Lights', null, 1.9, 'C'), 'Lights (1.9 A)')
  assert.strictEqual(labelWith('Lights', null, null, 'C'), 'Lights')
  assert.strictEqual(labelWith('Freezer', K(-18), 2.9, 'F'), 'Freezer (-0.4 °F, 2.9 A)')
  assert.strictEqual(labelWith('Freezer', 265.02, null, 'K'), 'Freezer (265.0 K)')
  assert.strictEqual(labelWith('Fridge', K(-0.04), null, 'C'), 'Fridge (0.0 °C)') // never "-0.0"
  // 32 bytes is all a label gets: first the compact temperature, then the name gives way.
  assert.strictEqual(labelWith('Cockpit Freezer', K(-18.2), 3.0, 'C'), 'Cockpit Freezer (-18°C, 3.0 A)')
  const long = labelWith('Aft Cabin Wine Fridge Number Two', K(11.6), 1.2, 'C')
  assert(Buffer.byteLength(long) <= 32 && long.endsWith(' (12°C, 1.2 A)'), long)
  for (const s of ['Freezer (-8.2 °C, 2.9 A)', 'Cockpit Freezer (-18°C, 3.0 A)', 'Fridge (5.1 °C)', 'Lights (1.9 A)', 'Freezer (265.0 K)', 'Freezer (-0.4 °F, 2.9 A)', 'Lights · 1.9 A']) {
    assert(!/[()·]/.test(stripSuffix(s)), s) // a rename typed on the GX keeps the name only
  }
  assert.strictEqual(stripSuffix('Pump (aft)'), 'Pump (aft)')
  assert.strictEqual(stripSuffix('Pump (aft) (1.2 A)'), 'Pump (aft)')

  const off = ['Freezer', 'Freezer Temp Set-point', 'Fridge', 'Fridge Temp Set-point']
  const live = ['Freezer (-8.2 °C, 2.9 A)', 'Freezer Temp Set-point', 'Fridge (5.1 °C)', 'Fridge Temp Set-point']
  for (const cmp of [(a, b) => (a < b ? -1 : a > b ? 1 : 0), (a, b) => a.localeCompare(b)]) {
    assert.deepStrictEqual([...off].reverse().sort(cmp), off)
    assert.deepStrictEqual([...live].reverse().sort(cmp), live)
  }

  assert.deepStrictEqual(['celsius', 'fahrenheit', 'Fahrenheit', 'kelvin', undefined, 0].map(temperatureUnitFrom), ['C', 'F', 'F', 'K', 'C', 'C'])
  assert.strictEqual(temperatureText(273.15, 'C', true), '0°C')
}

// --- Through the monitor: values off the bus (PGN 130312, kelvin), published
//     at electrical.czone.<slug>.temperature, and five minutes before a quiet
//     sender is dropped.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-temp-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(fixture('Compass-Rose-03.10.26.zcf'), zcfFile)
  const published = []
  const monitor = createMonitor({ getSelfPath: () => undefined, debug: () => {}, handleMessage: (_id, d) => published.push(...d.updates[0].values) })
  monitor.start({ trendDirectory: path.join(dir, 'trends'), monitorWire: false }, zcfFile)
  const frame = (instance, source, kelvin) => { const b = Buffer.from([0xff, instance, source, 0, 0, 0xff, 0xff, 0xff]); b.writeUInt16LE(Math.round(kelvin * 100), 3); return `0 R 19FD0865 ${[...b].map(x => x.toString(16).padStart(2, '0')).join(' ')}` }
  const items = buildCatalog(fs.readFileSync(zcfFile)).items
  const sender = name => { const i = items.find(x => x.name === name); const [, instance, source] = /^temperature:(\d+):(\d+)$/.exec(i.readings[0].bus); return [Number(instance), Number(source)] }

  assert.strictEqual(monitor.temperatureFor('Lights'), null) // no input named after it
  assert.strictEqual(monitor.temperatureFor('Freezer').kelvin, null) // paired, nothing heard yet
  monitor.onRawFrame(frame(...sender('Freezer Temperature'), 264.95))
  monitor.onRawFrame(frame(...sender('Fridge Temperature'), 278.25))
  assert.strictEqual(monitor.temperatureFor('Freezer').kelvin, 264.95)
  assert.strictEqual(monitor.temperatureFor('Fridge').kelvin, 278.25)
  assert.strictEqual(monitor.temperatureFor('Freezer').path, 'electrical.czone.Freezer.temperature')

  monitor.publishTemperatures()
  assert.deepStrictEqual(published.filter(v => /temperature$/.test(v.path)), [
    { path: 'electrical.czone.Freezer.temperature', value: 264.95 }, { path: 'electrical.czone.Fridge.temperature', value: 278.25 }])

  // Four minutes without a frame: still shown. Six: dropped, and Signal K is told once.
  const realNow = Date.now
  Date.now = () => realNow() + 4 * 60e3
  assert.strictEqual(monitor.temperatureFor('Freezer').kelvin, 264.95)
  Date.now = () => realNow() + 6 * 60e3
  assert.strictEqual(monitor.temperatureFor('Freezer').kelvin, null)
  published.length = 0
  monitor.publishTemperatures(); monitor.publishTemperatures()
  assert.deepStrictEqual(published.filter(v => v.path === 'electrical.czone.Freezer.temperature'), [{ path: 'electrical.czone.Freezer.temperature', value: null }])
  Date.now = realNow
  monitor.stop()
}

// --- In the switch pane: label follows the temperature and the GX's unit.
{
  const objects = {}
  let unit = 'celsius'
  const bus = {
    exportInterface: (obj, p) => { objects[p] = obj },
    requestName: (name, flags, cb) => cb(null, 1),
    sendSignal: () => {},
    invoke: (msg, cb) => (msg.path === '/Settings/System/Units/Temperature' ? cb(null, [[{ type: 's' }], [unit]]) : cb(new Error('no localsettings')))
  }
  const temps = { Light_2: 277.35 }
  const states = { Light_2: { state: 'ON', percent: 100 }, Light_3: { state: 'OFF', percent: 0 } }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-temp-'))
  const app = { getDataDirPath: () => dir, getSelfPath: () => undefined, streambundle: { getSelfBus: () => ({ onValue: () => () => {} }) } }
  const label = n => objects[`/SwitchableOutput/${n}/Settings/CustomName`].GetValue()[1]
  const make = () => createVictronSwitches(app, { controls: () => ({ getState: s => states[s] || null }), getCurrent: p => (p === 'electrical.czone.Light_2.current' ? 1.5 : null), getTemperature: s => (s in temps ? temps[s] : null), version: 'test' })
  ;(async () => {
    let sw = make()
    await sw.start({ victronSwitches: true }, fixture('TestBench-2026-10-01.zcf'), { bus })
    sw._resync()
    assert.strictEqual(label('Light_2'), 'Light 2 (4.2 °C, 1.5 A)')
    assert.strictEqual(label('Light_3'), 'Light 3')
    assert.deepStrictEqual(sw.status().diag.temperatureUnit, { setting: 'celsius', used: 'C' })
    states.Light_2 = { state: 'OFF', percent: 0 } // off: the temperature stays
    sw._resync()
    assert.strictEqual(label('Light_2'), 'Light 2 (4.2 °C)')
    delete temps.Light_2 // sender quiet
    sw._resync()
    assert.strictEqual(label('Light_2'), 'Light 2')
    sw.stop()

    unit = 'fahrenheit'
    temps.Light_2 = 277.35
    sw = make()
    await sw.start({ victronSwitches: true }, fixture('TestBench-2026-10-01.zcf'), { bus })
    sw._resync()
    assert.strictEqual(label('Light_2'), 'Light 2 (39.6 °F)')
    sw.stop()

    sw = make() // switched off in the settings
    await sw.start({ victronSwitches: true, victronSwitchTemperature: false }, fixture('TestBench-2026-10-01.zcf'), { bus })
    sw._resync()
    assert.strictEqual(label('Light_2'), 'Light 2')
    sw.stop()
    console.log('Circuit temperature tests passed')
  })().catch(err => { console.error(err); process.exit(1) })
}
