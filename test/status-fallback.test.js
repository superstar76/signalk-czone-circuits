'use strict'

// Configurations without a ZCF status table (Compass Rose, Persevere): circuit
// state comes from PGN 65284 with bit n = output channel n. Frames below are
// from Compass Rose, 3 Oct 2026 ("Lights" switched off at the CZone display).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')
const { applyStatusFallback } = require('../lib/status-fallback')
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
  // Outputs beyond the 32-bit bitmap (setpoint circuits) stay unmapped.
  assert.strictEqual(c['Fridge 4⁰C'].statusModule, null)
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

console.log('Status fallback tests passed')
