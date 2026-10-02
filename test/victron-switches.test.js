'use strict'

// Venus OS switch pane bridge, against an in-memory D-Bus (no daemon needed).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createVictronSwitches } = require('../lib/victron/switches')

const objects = {}
const signals = []
const bus = {
  exportInterface: (obj, p, iface) => { objects[p] = obj },
  requestName: (name, flags, cb) => cb(null, 1),
  sendSignal: (p, iface, member, sig, body) => signals.push({ p, member, body }),
  invoke: (msg, cb) => cb(new Error('no localsettings'))
}
const puts = []
const sk = { 'electrical.czone.Light_2.switch.state': { value: true } }
let deltaListener = null
const app = {
  getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-')),
  putSelfPath: (p, v, cb) => { puts.push([p, v]); if (cb) cb({ state: 'COMPLETED', statusCode: 200 }) },
  getSelfPath: p => sk[p],
  streambundle: { getSelfBus: () => ({ onValue: fn => { deltaListener = fn; return () => {} } }) }
}
const zcf = path.join(__dirname, 'fixtures', 'TestBench-2026-10-01.zcf')
let hostControls = null
const calls = []
const sw = createVictronSwitches(app, { controls: () => hostControls, getCurrent: p => (p === 'electrical.czone.Light_2.current' ? 1.5 : null), version: 'test' })

sw.start({ victronSwitches: true }, zcf, { bus }).then(status => {
  assert.strictEqual(status.running, true)
  assert.strictEqual(status.channels, 6)
  const get = p => objects[p].GetValue()
  // Root device identity
  assert.deepStrictEqual(get('/State'), ['i', 0x100])
  assert.deepStrictEqual(get('/DeviceInstance'), ['i', 100])
  // One channel per circuit, grouped by CZone category
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Name'), ['s', 'Light 1'])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Settings/CustomName'), ['s', 'Light 1'])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Settings/Group'), ['s', 'Lighting'])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Settings/Type'), ['i', 1])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Settings/ValidTypes'), ['i', 0b011])
  // Seeded from Signal K, plus the circuit current
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/State'), ['i', 1])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/Status'), ['i', 0x09])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/Current'), ['d', 1.5])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Current'), ['ai', []])
  // Pane -> CZone without host controls: Signal K PUT on the plugin's own path
  assert.strictEqual(objects['/SwitchableOutput/Light_3/State'].SetValue([[{ type: 'i' }], [1]]), 0)
  assert.deepStrictEqual(puts, [['electrical.czone.Light_3.switch.state', true]])
  // With host controls (as index.js provides): called directly; a refusal
  // (e.g. sending disabled) is returned to the pane as an error.
  hostControls = { state: (slug, on) => { calls.push([slug, on]); if (slug === 'Light_4') throw new Error('NMEA 2000 sending is disabled') } }
  assert.strictEqual(objects['/SwitchableOutput/Light_1/State'].SetValue([[{ type: 'i' }], [1]]), 0)
  assert.deepStrictEqual(calls, [['Light_1', true]])
  assert.strictEqual(objects['/SwitchableOutput/Light_4/State'].SetValue([[{ type: 'i' }], [1]]), 1)
  assert.match(sw.status().recent[0].result, /sending is disabled/)
  // Invalid type for a non-dimmer is refused; momentary is allowed
  assert.strictEqual(objects['/SwitchableOutput/Light_3/Settings/Type'].SetValue([[{ type: 'i' }], [2]]), 1)
  assert.strictEqual(objects['/SwitchableOutput/Light_3/Settings/Type'].SetValue([[{ type: 'i' }], [0]]), 0)
  // Current shown in the label while on (Light 2 is on at 1.5 A)
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/Settings/CustomName'), ['s', 'Light 2 · 1.5 A'])
  // A rename from the GUI keeps the name, not the amps
  objects['/SwitchableOutput/Light_2/Settings/CustomName'].SetValue([[{ type: 's' }], ['Saloon · 1.5 A']])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/Settings/CustomName'), ['s', 'Saloon · 1.5 A'])
  sk['electrical.czone.Light_2.switch.state'] = { value: false }
  deltaListener({ path: 'electrical.czone.Light_2.switch.state', value: false })
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/Settings/CustomName'), ['s', 'Saloon'])
  // CZone -> pane: a state delta updates State and Status and signals it
  sk['electrical.czone.Light_1.switch.state'] = { value: true }
  deltaListener({ path: 'electrical.czone.Light_1.switch.state', value: true })
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/State'), ['i', 1])
  assert(signals.some(s => s.p === '/SwitchableOutput/Light_1/State' && s.member === 'PropertiesChanged'))
  // GetItems lists every path with Value and Text
  const items = objects['/'].GetItems()
  assert(items.length > 60)
  assert(items.every(([p, kv]) => p.startsWith('/') && kv[0][0] === 'Value' && kv[1][0] === 'Text'))
  // A circuit that was already on before this service was listening (Compass
  // Rose, Anchor Light): no delta ever comes, the regular re-sync picks it up.
  assert.deepStrictEqual(get('/SwitchableOutput/Light_5/State'), ['i', 0])
  sk['electrical.czone.Light_5.switch.state'] = { value: true }
  sw._resync()
  assert.deepStrictEqual(get('/SwitchableOutput/Light_5/State'), ['i', 1])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_5/Status'), ['i', 0x09])
  // A pane tap is not undone by the re-sync while CZone has yet to confirm…
  sk['electrical.czone.Light_3.switch.state'] = { value: false }
  assert.strictEqual(objects['/SwitchableOutput/Light_3/State'].SetValue([[{ type: 'i' }], [1]]), 0)
  sw._resync()
  assert.deepStrictEqual(get('/SwitchableOutput/Light_3/State'), ['i', 1])
  // …but a command CZone never acted on snaps back after the grace period.
  const realNow = Date.now
  Date.now = () => realNow() + 6000
  sw._resync()
  Date.now = realNow
  assert.deepStrictEqual(get('/SwitchableOutput/Light_3/State'), ['i', 0])
  sw.stop()
  console.log('Victron switch pane tests passed')
}).catch(err => { console.error(err); process.exit(1) })
