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
let deltaListener = null
const app = {
  getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-')),
  putSelfPath: (p, v, cb) => { puts.push([p, v]); if (cb) cb({ state: 'COMPLETED', statusCode: 200 }) },
  getSelfPath: p => (p === 'electrical.czone.Light_2.switch.state' ? { value: true } : undefined),
  streambundle: { getSelfBus: () => ({ onValue: fn => { deltaListener = fn; return () => {} } }) }
}
const zcf = path.join(__dirname, 'fixtures', 'TestBench-2026-10-01.zcf')
const sw = createVictronSwitches(app, { getCurrent: p => (p === 'electrical.czone.Light_2.current' ? 1.5 : null), version: 'test' })

sw.start({ victronSwitches: true }, zcf, { bus }).then(status => {
  assert.strictEqual(status.running, true)
  assert.strictEqual(status.channels, 6)
  const get = p => objects[p].GetValue()
  // Root device identity
  assert.deepStrictEqual(get('/State'), ['i', 0x100])
  assert.deepStrictEqual(get('/DeviceInstance'), ['i', 100])
  // One channel per circuit, grouped by CZone category
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Name'), ['s', 'Light 1'])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Settings/Group'), ['s', 'Lighting'])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Settings/Type'), ['i', 1])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Settings/ValidTypes'), ['i', 0b011])
  // Seeded from Signal K, plus the circuit current
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/State'), ['i', 1])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/Status'), ['i', 0x09])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_2/Current'), ['d', 1.5])
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/Current'), ['ai', []])
  // Pane -> CZone: SetValue on State becomes a Signal K PUT on the plugin's own path
  assert.strictEqual(objects['/SwitchableOutput/Light_3/State'].SetValue([[{ type: 'i' }], [1]]), 0)
  assert.deepStrictEqual(puts, [['electrical.czone.Light_3.switch.state', true]])
  // Invalid type for a non-dimmer is refused; momentary is allowed
  assert.strictEqual(objects['/SwitchableOutput/Light_3/Settings/Type'].SetValue([[{ type: 'i' }], [2]]), 1)
  assert.strictEqual(objects['/SwitchableOutput/Light_3/Settings/Type'].SetValue([[{ type: 'i' }], [0]]), 0)
  // CZone -> pane: a state delta updates State and Status and signals it
  deltaListener({ path: 'electrical.czone.Light_1.switch.state', value: true })
  assert.deepStrictEqual(get('/SwitchableOutput/Light_1/State'), ['i', 1])
  assert(signals.some(s => s.p === '/SwitchableOutput/Light_1/State' && s.member === 'PropertiesChanged'))
  // GetItems lists every path with Value and Text
  const items = objects['/'].GetItems()
  assert(items.length > 60)
  assert(items.every(([p, kv]) => p.startsWith('/') && kv[0][0] === 'Value' && kv[1][0] === 'Text'))
  sw.stop()
  console.log('Victron switch pane tests passed')
}).catch(err => { console.error(err); process.exit(1) })
