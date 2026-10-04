'use strict'

// Confirm before off. A circuit the installer nominates (a freezer of
// long-term stores, the circuit that powers the display in use) is turned off
// from the webapp only after "are you sure?", and not at all by something
// that cannot ask (the Victron switch pane, a Signal K PUT), unless allowed.
// Turning on is never held up, and other circuits are untouched.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')
const { confirmOffFor, choices } = require('../lib/confirm-off')
const { createVictronSwitches } = require('../lib/victron/switches')

function run (fixture, settings) {
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-confirm-'))
  const emitted = []
  const putHandlers = new Map()
  const logs = []
  const app = {
    config: { configPath },
    isNmea2000OutAvailable: true,
    on: () => {},
    emit: (event, line) => { if (event === 'nmea2000out') emitted.push(line) },
    debug: m => logs.push(String(m)),
    registerPutHandler: (_context, pathName, handler) => putHandlers.set(pathName, handler),
    handleMessage: () => {},
    setPluginStatus: () => {},
    getSelfPath: () => undefined
  }
  const plugin = pluginFactory(app)
  const dir = path.join(configPath, 'plugin-config-data', 'signalk-czone-circuits')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(path.join(__dirname, 'fixtures', fixture), path.join(dir, 'installation.zcf'))
  plugin.start({ monitorWire: false, enableSending: true, ...settings })
  const routes = { get: {}, post: {} }
  plugin.registerWithRouter({ get: (p, fn) => { routes.get[p] = fn }, post: (p, fn) => { routes.post[p] = fn }, put: () => {} })
  const call = (method, route, params, query, body) => {
    const out = { status: 200, body: null }
    const res = { status: s => { out.status = s; return res }, json: v => { out.body = v; return res } }
    routes[method][route]({ params: params || {}, query: query || {}, body }, res)
    return out
  }
  const circuits = () => Object.fromEntries(call('get', '/circuits').body.circuits.map(c => [c.name.trim(), c]))
  const off = (name, query) => call('post', '/circuits/:name/off', { name }, query)
  const on = name => call('post', '/circuits/:name/on', { name })
  const put = (slug, value) => { const p = `electrical.czone.${slug}.switch.state`; return putHandlers.get(p)('vessels.self', p, value, () => {}) }
  return { plugin, circuits, off, on, put, call, emitted, logs }
}

// --- Compass Rose: Freezer and Instruments nominated -----------------------
{
  const t = run('Compass-Rose-03.10.26.zcf', {
    confirmOff: [{ circuit: 'Freezer', note: 'a reason saved by an earlier build is ignored' }, { circuit: ' instruments ' }, { circuit: 'Bait Tank' }]
  })
  const c = t.circuits()
  assert.strictEqual(c.Freezer.confirmOff, true)
  assert.strictEqual(c.Freezer.confirmOffNote, undefined) // the question is just the question
  assert.strictEqual(c.Instruments.confirmOff, true) // matched whatever the case and spacing
  assert.strictEqual(c.Lights.confirmOff, undefined)
  assert(t.logs.some(l => /no circuit named Bait Tank/.test(l)), 'a name that matches nothing is logged')

  // Webapp, off without the answer: refused, nothing sent to CZone.
  let sent = t.emitted.length
  let r = t.off('Freezer')
  assert.strictEqual(r.status, 409)
  assert.strictEqual(r.body.needsConfirm, true)
  assert.strictEqual(r.body.note, undefined)
  assert.strictEqual(t.emitted.length, sent)

  // Off with the answer: sent.
  r = t.off('Freezer', { confirm: '1' })
  assert.strictEqual(r.status, 200)
  assert(t.emitted.length > sent)

  // On is never held up.
  sent = t.emitted.length
  r = t.on('Freezer')
  assert.strictEqual(r.status, 200)
  assert(t.emitted.length > sent)

  // Any other circuit: off at once, as before.
  sent = t.emitted.length
  r = t.off('Lights')
  assert.strictEqual(r.status, 200)
  assert(t.emitted.length > sent)

  // Something that cannot ask (Signal K PUT; the Victron pane takes the same
  // path): off is not acted on, on is, and other circuits are untouched.
  sent = t.emitted.length
  let p = t.put('Freezer', false)
  assert.strictEqual(p.statusCode, 400)
  assert(/confirm before turning off/.test(p.message))
  assert.strictEqual(t.emitted.length, sent)
  assert.strictEqual(t.put('Freezer', true).statusCode, 200)
  assert.strictEqual(t.put('Lights', false).statusCode, 200)

  // The plugin configuration offers the circuits by name; a saved name this
  // configuration no longer has stays in the list so the form still saves.
  const item = t.plugin.schema().properties.confirmOff.items.properties.circuit
  assert(item.enum.includes('Freezer') && item.enum.includes('Instruments'))
  assert.strictEqual(item.enumNames[item.enum.indexOf('Bait Tank')], 'Bait Tank (not in this configuration)')
  assert(!item.enum.some(n => /Temp Control/.test(n)), 'circuits that are not shown are not offered')
  t.plugin.stop()
}

// --- The installer allows other apps to turn them off ----------------------
{
  const t = run('Compass-Rose-03.10.26.zcf', { confirmOff: [{ circuit: 'Freezer' }], confirmOffAllowElsewhere: true })
  assert.strictEqual(t.put('Freezer', false).statusCode, 200)
  assert.strictEqual(t.off('Freezer').status, 409) // the webapp still asks
  t.plugin.stop()
}

// --- Nothing nominated: nothing changes ------------------------------------
{
  const t = run('Compass-Rose-03.10.26.zcf', {})
  assert.strictEqual(t.circuits().Freezer.confirmOff, undefined)
  assert.strictEqual(t.off('Freezer').status, 200)
  assert.strictEqual(t.put('Freezer', false).statusCode, 200)
  assert.strictEqual(t.plugin.schema().properties.confirmOff.items.properties.circuit.enum.includes('Freezer'), true)
  assert.deepStrictEqual(Object.keys(t.plugin.schema().properties.confirmOff.items.properties), ['circuit'])
  t.plugin.stop()
}

// --- Modes are not held up (SugarShack: Sleep turns Instruments off) --------
{
  const t = run('SugarShack-20260927-01.zcf', { confirmOff: [{ circuit: 'Instruments' }] })
  const sent = t.emitted.length
  const r = t.call('post', '/modes/:name/activate', { name: 'Sleep' })
  assert.strictEqual(r.status, 200)
  assert(t.emitted.length > sent)
  // ... while the circuit's own button still asks.
  assert.strictEqual(t.off('Instruments').status, 409)
  t.plugin.stop()
}

// --- The library on its own -------------------------------------------------
{
  const circuits = [{ name: 'Freezer ', slug: 'Freezer' }, { name: 'Audible Alarm', slug: 'Audible_Alarm' }, { name: 'Audible Alarm', slug: 'Audible_Alarm_2' }, { name: 'Hidden', slug: 'Hidden', hidden: true }]
  const r = confirmOffFor({ confirmOff: ['freezer', { circuit: 'Audible Alarm', note: 'x' }, { circuit: '' }, null, { circuit: 'Gone' }] }, circuits)
  assert.deepStrictEqual([...r.marked], ['Freezer ', 'Audible Alarm']) // both alarms share the name
  assert.deepStrictEqual(r.unknown, ['Gone'])
  assert.strictEqual(confirmOffFor({}, circuits).marked.size, 0)
  assert.strictEqual(confirmOffFor(null, null).marked.size, 0)
  assert.deepStrictEqual(choices({}, circuits).map(n => n.value), ['Audible Alarm', 'Freezer'])
}

// --- Victron switch pane: a refused off leaves the switch on ---------------
const objects = {}
const signals = []
const bus = {
  exportInterface: (obj, p) => { objects[p] = obj },
  requestName: (name, flags, cb) => cb(null, 1),
  sendSignal: (p, iface, member, sig, body) => signals.push({ p, member, body }),
  invoke: (msg, cb) => cb(new Error('no localsettings'))
}
const sk = { 'electrical.czone.Light_2.switch.state': { value: true } }
const app = {
  getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-')),
  putSelfPath: () => { throw new Error('the pane must use the plugin controls') },
  getSelfPath: p => sk[p],
  streambundle: { getSelfBus: () => ({ onValue: () => () => {} }) }
}
const asked = []
const sw = createVictronSwitches(app, {
  controls: () => ({
    state: (slug, on) => { asked.push([slug, on]); if (slug === 'Light_2' && !on) throw new Error('"Light 2" is set to confirm before turning off.') },
    getState: () => ({ state: 'ON' })
  }),
  version: 'test'
})
sw.start({ victronSwitches: true }, path.join(__dirname, 'fixtures', 'TestBench-2026-10-01.zcf'), { bus }).then(async () => {
  const state = '/SwitchableOutput/Light_2/State'
  assert.strictEqual(objects[state].GetValue()[1], 1)
  signals.length = 0
  assert.strictEqual(objects[state].SetValue(['i', 0]), 1, 'the write is refused')
  assert.deepStrictEqual(asked.at(-1), ['Light_2', false])
  assert.strictEqual(objects[state].GetValue()[1], 1, 'still on')
  await new Promise(resolve => setTimeout(resolve, 120))
  const again = signals.filter(s => s.member === 'ItemsChanged').some(s => JSON.stringify(s.body).includes(state))
  assert(again, 'the pane is told the state again, so its switch goes back')
  // Another switch turns off as usual.
  assert.strictEqual(objects['/SwitchableOutput/Light_1/State'].SetValue(['i', 0]), 0)
  sw.stop()
  console.log('Confirm before off tests passed')
}).catch(err => { console.error(err); process.exit(1) })
