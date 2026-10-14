'use strict'

// Third-party switches driven from CZone (lib/bridge): the linking rules, the
// Shelly and Victron drivers, and the plugin end to end with the bench
// configuration of 13 Oct 2026 (virtual circuit "Shelly Relay - Powerboard",
// held by the Output Interface as channel 6).

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { createBridge, bridgeEntries, RETRY_MS } = require('../lib/bridge')
const { createShellyDriver } = require('../lib/bridge/shelly')
const { createVictronDriver } = require('../lib/bridge/victron')

const tick = () => new Promise(resolve => setImmediate(resolve))

// A stand-in switch and a stand-in CZone circuit, on a hand-stepped clock.
function rig ({ device = false, circuit = false, sending = true } = {}) {
  let clock = 1000
  const dev = { on: device, reachable: true, refuse: false, ignore: false, writes: [] }
  const cz = { on: circuit, sending, writes: [] }
  let bridge
  const driver = {
    describe: () => 'test switch',
    read: async () => { if (!dev.reachable) throw new Error('no answer'); return dev.on },
    write: async (_e, on) => {
      if (!dev.reachable) throw new Error('no answer')
      if (dev.refuse) throw new Error('refused')
      dev.writes.push(on); if (!dev.ignore) dev.on = on
    }
  }
  bridge = createBridge({
    readCircuit: name => (name === 'Pump' ? cz.on : undefined),
    writeCircuit: (name, on) => {
      if (!cz.sending) throw new Error('NMEA 2000 sending is disabled')
      cz.writes.push(on)
      cz.on = on
      setImmediate(() => bridge.onCircuit(name, on)) // the module's status comes back
    },
    drivers: { test: driver },
    now: () => clock,
    pollMs: 1e9
  })
  bridge.start([{ circuit: 'Pump', target: 'test' }])
  return {
    bridge, dev, cz,
    later: ms => { clock += ms },
    // a press on a CZone display: the module's status says the new state
    press: async on => { cz.on = on; bridge.onCircuit('Pump', on); await tick(); await tick() },
    poll: async () => { await bridge.poll(); await tick(); await tick() }
  }
}

;(async () => {
  // --- In step at start: nothing is sent either way.
  {
    const r = rig({ device: false, circuit: false })
    await r.poll(); await r.poll()
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[], []])
    assert.deepStrictEqual(r.bridge.status()[0], { circuit: 'Pump', target: 'test switch', czone: false, device: false, inStep: true, pending: null, error: null, last: null, at: null })
    r.bridge.stop()
  }

  // --- A display press switches the switch, once; its echo is not sent back.
  {
    const r = rig()
    await r.poll()
    await r.press(true)
    assert.deepStrictEqual(r.dev.writes, [true])
    for (let i = 0; i < 5; i++) { r.later(2000); await r.poll(); r.bridge.onCircuit('Pump', true) }
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[true], []])
    await r.press(false)
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[true, false], []])
    await r.poll() // the switch read back: in step, and its change is ours, not passed on
    assert.deepStrictEqual([r.dev.writes, r.cz.writes, r.bridge.status()[0].inStep, r.bridge.status()[0].pending], [[true, false], [], true, null])
    r.bridge.stop()
  }

  // --- The switch changed elsewhere (Victron pane, VRM, its app): the CZone
  //     circuit follows, once; the circuit's echo is not sent back.
  {
    const r = rig()
    await r.poll()
    r.dev.on = true
    await r.poll()
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[], [true]])
    assert.strictEqual(r.bridge.status()[0].pending, null) // the circuit's echo was recognised as ours
    for (let i = 0; i < 5; i++) { r.later(2000); await r.poll() }
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[], [true]])
    assert.strictEqual(r.bridge.status()[0].inStep, true)
    r.bridge.stop()
  }

  // --- Out of step at start: nothing is switched either way (a GX relay
  //     comes back off after a reboot; taking it as right turned Instruments
  //     off on Compass Rose). The next real change on either side syncs.
  {
    const r = rig({ device: false, circuit: true }) // e.g. Instruments on, relay just rebooted off
    for (let i = 0; i < 4; i++) { r.later(RETRY_MS + 1); await r.poll() }
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[], []])
    assert.deepStrictEqual([r.bridge.status()[0].inStep, r.bridge.status()[0].czone, r.bridge.status()[0].device], [false, true, false])
    assert.match(r.bridge.status()[0].last, /Out of step at start: nothing switched/)
    await r.press(false) // the circuit switched on a display: the switch follows
    await r.press(true)
    r.later(2000); await r.poll()
    assert.deepStrictEqual([r.dev.writes, r.cz.writes, r.bridge.status()[0].inStep], [[true], [], true])
    r.bridge.stop()
  }
  {
    const r = rig({ device: false, circuit: true })
    await r.poll()
    r.dev.on = true; r.later(2000); await r.poll() // the switch changed elsewhere: still in step after
    r.dev.on = false; r.later(2000); await r.poll() // ...and switched off elsewhere: the circuit follows
    assert.deepStrictEqual([r.dev.writes, r.cz.writes, r.bridge.status()[0].inStep], [[], [false], true])
    r.bridge.stop()
  }

  // --- The circuit first seen after the switch, and different: nothing is
  //     switched either.
  {
    const r = rig({ circuit: null, device: true })
    await r.poll()
    r.cz.on = false
    r.bridge.onCircuit('Pump', false)
    await tick(); await tick()
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[], []])
    assert.match(r.bridge.status()[0].last, /Out of step at start/)
    r.bridge.stop()
  }

  // --- The host refuses for good (a circuit that asks before turning off):
  //     said once, never retried; turning it on still works.
  {
    let refusals = 0
    const r = rig({ device: true, circuit: true })
    const real = r.bridge
    r.bridge.stop()
    let clock = 5000
    const cz = { on: true, writes: [] }
    const dev = { on: true, writes: [] }
    const b = createBridge({
      readCircuit: () => cz.on,
      writeCircuit: (_n, on) => {
        if (!on) { refusals++; const e = new Error('not switched off: this circuit asks before turning off'); e.permanent = true; throw e }
        cz.writes.push(on); cz.on = on
      },
      drivers: { test: { read: async () => dev.on, write: async (_e, on) => { dev.writes.push(on); dev.on = on } } },
      now: () => clock,
      pollMs: 1e9
    })
    b.start([{ circuit: 'Instruments', target: 'test' }])
    await b.poll()
    dev.on = false; clock += 2000; await b.poll() // relay switched off elsewhere
    for (let i = 0; i < 4; i++) { clock += RETRY_MS + 1; await b.poll() }
    assert.deepStrictEqual([refusals, cz.on, cz.writes], [1, true, []])
    assert.match(b.status()[0].error, /not switched off: this circuit asks before turning off/)
    dev.on = true; clock += 2000; await b.poll() // back on elsewhere: in step again, nothing sent
    assert.deepStrictEqual([b.status()[0].inStep, cz.writes, refusals], [true, [], 1])
    b.stop()
    void real
  }

  // --- A switch that accepts the command but does not change: after a while
  //     that is said, and the link is not left waiting for ever.
  {
    const r = rig()
    await r.poll()
    r.dev.ignore = true
    await r.press(true)
    await r.poll()
    assert.deepStrictEqual(r.bridge.status()[0].pending, { side: 'device', value: true })
    r.later(10000); await r.poll()
    assert.strictEqual(r.bridge.status()[0].pending, null)
    assert.match(r.bridge.status()[0].last, /No confirmation from the switch/)
    assert.deepStrictEqual(r.dev.writes, [true]) // not sent again at once
    r.later(RETRY_MS + 1); await r.poll()
    assert.deepStrictEqual(r.dev.writes, [true, true]) // tried again in its turn
    r.dev.ignore = false
    for (let i = 0; i < 3; i++) { r.later(RETRY_MS + 1); await r.poll() }
    assert.deepStrictEqual([r.dev.writes, r.cz.writes, r.bridge.status()[0].inStep], [[true, true, true], [], true])
    r.bridge.stop()
  }

  // --- A press while the switch is unreachable is kept and tried again (not
  //     every poll), then taken; no bounce back to CZone.
  {
    const r = rig()
    await r.poll()
    r.dev.reachable = false
    await r.press(true)
    assert.deepStrictEqual(r.dev.writes, [])
    await r.poll()
    assert.match(r.bridge.status()[0].error, /Could not switch|Not reachable/)
    r.dev.reachable = true
    await r.poll() // too soon to try again
    assert.deepStrictEqual(r.dev.writes, [])
    r.later(RETRY_MS + 1)
    await r.poll()
    assert.deepStrictEqual([r.dev.writes, r.cz.writes], [[true], []])
    r.later(2000); await r.poll()
    assert.deepStrictEqual([r.dev.writes, r.cz.writes, r.bridge.status()[0].error, r.bridge.status()[0].inStep], [[true], [], null, true])
    r.bridge.stop()
  }

  // --- The switch refuses: reported, tried again later.
  {
    const r = rig()
    await r.poll()
    r.dev.refuse = true
    await r.press(true)
    assert.match(r.bridge.status()[0].error, /Could not switch test switch: refused/)
    r.dev.refuse = false
    r.later(RETRY_MS + 1); await r.poll()
    assert.deepStrictEqual(r.dev.writes, [true])
    r.bridge.stop()
  }

  // --- NMEA 2000 sending off: the switch still follows CZone; the CZone
  //     circuit cannot follow the switch, says why, and catches up once
  //     sending is allowed.
  {
    const r = rig({ sending: false })
    await r.poll()
    await r.press(true)
    assert.deepStrictEqual(r.dev.writes, [true])
    r.later(2000); await r.poll()
    r.dev.on = false
    await r.poll()
    assert.deepStrictEqual(r.cz.writes, [])
    assert.match(r.bridge.status()[0].error, /sending is disabled/)
    r.cz.sending = true
    await r.poll()
    assert.deepStrictEqual(r.cz.writes, []) // not before the retry time
    r.later(RETRY_MS + 1); await r.poll()
    assert.deepStrictEqual(r.cz.writes, [false])
    r.later(2000); await r.poll()
    assert.deepStrictEqual([r.cz.writes, r.bridge.status()[0].inStep], [[false], true])
    r.bridge.stop()
  }

  // --- The switch changed elsewhere while a CZone change was waiting to be
  //     retried: the newer change wins and nothing is retried.
  {
    const r = rig()
    await r.poll()
    r.dev.reachable = false
    await r.press(true)
    r.dev.reachable = true
    r.dev.on = false // unchanged as far as the bridge knows
    r.dev.on = true // someone switched it on at the switch
    r.later(1); await r.poll()
    r.later(RETRY_MS + 1); await r.poll()
    assert.deepStrictEqual(r.dev.writes, [])
    r.bridge.stop()
  }

  // --- A circuit not yet seen does not get switched on a guess.
  {
    const r = rig({ circuit: null }) // no status from the module yet
    await r.poll()
    r.dev.on = true
    await r.poll()
    assert.deepStrictEqual(r.cz.writes, [])
    r.bridge.stop()
  }

  // --- Settings rows.
  assert.deepStrictEqual(bridgeEntries([
    { circuit: 'Shelly Relay - Powerboard', target: 'victron', output: 'com.victronenergy.acload.shelly_28372F37CD6C_0#0', label: 'Power Board' },
    { circuit: ' Power ', target: 'shelly', host: '192.168.1.204', channel: '1' },
    { circuit: 'Test', target: 'shelly', host: '127.0.0.1:8099' },
    { circuit: 'Bad', target: 'shelly', host: 'http://x/' },
    { circuit: 'Bad', target: 'victron', output: 'nonsense' },
    { circuit: '', target: 'shelly', host: '1.2.3.4' },
    null
  ]), [
    { circuit: 'Shelly Relay - Powerboard', target: 'victron', service: 'com.victronenergy.acload.shelly_28372F37CD6C_0', output: '0', label: 'Power Board' },
    { circuit: 'Power', target: 'shelly', host: '192.168.1.204', channel: 1, label: '' },
    { circuit: 'Test', target: 'shelly', host: '127.0.0.1:8099', channel: 0, label: '' }
  ])

  // --- Shelly driver, against a stand-in answering as the bench PM1 did.
  const shelly = { output: true, sets: [], password: false }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (shelly.password) { res.statusCode = 401; return res.end('{}') }
    if (u.pathname === '/rpc/Switch.GetStatus') {
      if (u.searchParams.get('id') !== '0') { res.statusCode = 500; return res.end('{"code":-105}') }
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ id: 0, source: 'WS_in', output: shelly.output, apower: 0.0, voltage: 239.1, current: 0.0 }))
    }
    if (u.pathname === '/rpc/Switch.Set') {
      shelly.output = u.searchParams.get('on') === 'true'
      shelly.sets.push(shelly.output)
      return res.end(JSON.stringify({ was_on: !shelly.output }))
    }
    res.statusCode = 404; res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const host = `127.0.0.1:${server.address().port}`
  {
    const d = createShellyDriver()
    assert.strictEqual(await d.read({ host, channel: 0 }), true)
    await d.write({ host, channel: 0 }, false)
    assert.deepStrictEqual([shelly.sets, await d.read({ host, channel: 0 })], [[false], false])
    assert.strictEqual(d.describe({ host: '192.168.1.204', channel: 0 }), 'Shelly 192.168.1.204')
    await assert.rejects(d.read({ host, channel: 1 }), /HTTP 500/)
    shelly.password = true
    await assert.rejects(d.read({ host, channel: 0 }), /password/)
    shelly.password = false
    await assert.rejects(createShellyDriver({ timeoutMs: 300 }).read({ host: '127.0.0.1:1', channel: 0 }), /ECONNREFUSED|no answer/)
  }

  // --- Victron driver, against a stand-in D-Bus with the PM1 as the bench showed it.
  {
    const calls = []
    const items = {
      'com.victronenergy.acload.shelly_28372F37CD6C_0': {
        '/CustomName': 'Power Board', '/ProductName': 'Shelly Switch', '/SwitchableOutput/0/State': 1,
        '/SwitchableOutput/0/Name': 'Channel 0', '/SwitchableOutput/0/Settings/CustomName': 'Power Board', '/SwitchableOutput/0/Settings/Type': 1
      },
      'com.victronenergy.switch.relay': { '/SwitchableOutput/1/State': 0, '/SwitchableOutput/1/Name': 'Relay 1', '/ProductName': 'GX relays' },
      // The GX's own relays, as Compass Rose showed them (15 Oct 2026): relay 1
      // is the alarm relay, relay 2 is manual. Values come back as numbers.
      'com.victronenergy.system': {
        '/Dc/Battery/Soc': 84,
        '/SwitchableOutput/0/Name': 'GX internal relay 1', '/SwitchableOutput/0/Settings/CustomName': '', '/SwitchableOutput/0/Settings/Function': 0, '/SwitchableOutput/0/Settings/Type': 1, '/SwitchableOutput/0/State': 0,
        '/SwitchableOutput/1/Name': 'GX internal relay 2', '/SwitchableOutput/1/Settings/CustomName': '', '/SwitchableOutput/1/Settings/Function': 2, '/SwitchableOutput/1/Settings/Type': 1, '/SwitchableOutput/1/State': 0
      },
      'com.victronenergy.switch.virtual_dimmer': { '/SwitchableOutput/0/State': 1, '/SwitchableOutput/0/Name': 'Saloon dimmer', '/SwitchableOutput/0/Settings/Type': 2 },
      'com.victronenergy.battery.ttyS5': { '/Soc': 84 },
      'com.victronenergy.switch.czone_circuits': { '/SwitchableOutput/Light_1/State': 1 }
    }
    const variant = v => [[{ type: typeof v === 'number' ? 'i' : 's' }], [v]]
    const bus = {
      invoke (msg, cb) {
        calls.push(msg)
        if (msg.member === 'ListNames') return cb(null, ['org.freedesktop.DBus', ...Object.keys(items), 'com.victronenergy.settings'])
        const svc = items[msg.destination]
        if (!svc) return cb(new Error('no such service'))
        if (msg.member === 'GetItems') {
          if (msg.destination === 'com.victronenergy.switch.relay') return cb(new Error('Unknown method GetItems')) // falls back to trying channels
          return cb(null, Object.keys(svc).map(p => [p, [['Value', variant(svc[p])]]]))
        }
        if (msg.member === 'GetValue') return msg.path in svc ? cb(null, variant(svc[msg.path])) : cb(new Error('no such path'))
        if (msg.member === 'SetValue') { svc[msg.path] = msg.body[0][1]; return cb(null, 0) }
        cb(new Error('?'))
      }
    }
    const d = createVictronDriver({ getBus: () => bus })
    const pm1 = { service: 'com.victronenergy.acload.shelly_28372F37CD6C_0', output: '0', label: 'Power Board' }
    assert.strictEqual(await d.read(pm1), true)
    await d.write(pm1, false)
    const set = calls.find(c => c.member === 'SetValue')
    assert.deepStrictEqual([set.path, set.signature, set.body], ['/SwitchableOutput/0/State', 'v', [['i', 0]]])
    assert.strictEqual(await d.read(pm1), false)
    assert.strictEqual(d.describe(pm1), 'Power Board (GX)')
    await assert.rejects(d.read({ service: 'com.victronenergy.battery.ttyS5', output: '0' }), /no such path/)
    // The list for the settings page: the PM1 by its name, the GX relay found
    // without GetItems, not the battery, not this plugin's own pane.
    // The GX's relays are offered only when Manual; the alarm relay is listed
    // with the reason and cannot be picked; a dimmer is not an on/off switch.
    const list = await d.list()
    assert.deepStrictEqual(list.map(o => [o.label, o.value, o.available, o.reason]), [
      ['GX internal relay 1', 'com.victronenergy.system#0', false, 'used by the GX as alarm relay'],
      ['GX internal relay 2', 'com.victronenergy.system#1', true, undefined],
      ['GX relays Relay 1', 'com.victronenergy.switch.relay#1', true, undefined],
      ['Power Board', 'com.victronenergy.acload.shelly_28372F37CD6C_0#0', true, undefined],
      ['Saloon dimmer', 'com.victronenergy.switch.virtual_dimmer#0', false, 'not an on/off output']
    ])
    const sys = items['com.victronenergy.system']
    const relay2 = { service: 'com.victronenergy.system', output: '1', label: 'GX internal relay 2' }
    await d.write(relay2, true)
    assert.strictEqual(sys['/SwitchableOutput/1/State'], 1)
    assert.strictEqual(await d.read(relay2), true)
    // The alarm relay is never written, however it got linked.
    const relay1 = { service: 'com.victronenergy.system', output: '0' }
    await assert.rejects(d.write(relay1, true), /not switched: used by the GX as alarm relay/)
    assert.strictEqual(sys['/SwitchableOutput/0/State'], 0)
    // A linked relay handed to the GX later (here: tank pump) stops being switched.
    sys['/SwitchableOutput/1/Settings/Function'] = 3
    await assert.rejects(d.write(relay2, false), /used by the GX as tank pump/)
    assert.strictEqual(sys['/SwitchableOutput/1/State'], 1)
    sys['/SwitchableOutput/1/Settings/Function'] = 2
    await d.write(relay2, false)
    assert.strictEqual(sys['/SwitchableOutput/1/State'], 0)
  }

  // --- The plugin, end to end: bench configuration, a stand-in Shelly, the
  //     Output Interface's status frames as captured on 13 Oct 2026.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czone-bridge-'))
    const dataDir = path.join(dir, 'plugin-config-data', 'signalk-czone-circuits')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench-Shelly-2026-10-13.zcf'), path.join(dataDir, 'installation.zcf'))
    const listeners = new Map()
    const out = []
    const app = {
      config: { configPath: dir },
      debug () {}, error () {}, setPluginStatus () {}, setPluginError () {},
      on: (e, fn) => listeners.set(e, fn), removeListener: e => listeners.delete(e),
      emit: (e, line) => { if (e === 'nmea2000out') out.push(line) },
      handleMessage () {}, registerPutHandler () {},
      isNmea2000OutAvailable: true,
      getSelfPath: () => undefined
    }
    const plugin = require('../index')(app)
    shelly.output = false; shelly.sets = []
    plugin.start({ enableSending: true, bridges: [{ circuit: 'Shelly Relay - Powerboard', target: 'shelly', host }] })
    const bus = frame => listeners.get('canboatjs:rawoutput')(`2026-10-13T05:00:00.000Z R ${frame}`)
    const routes = {}
    plugin.registerWithRouter({ get: (p, fn) => { routes[p] = fn }, post () {} })
    const linkStatus = () => { let v; routes['/bridge/status']({}, { json: x => { v = x } }); return v.links[0] }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

    bus('1CFF0401 27 99 01 0F 00 00 00 00') // channel 6 off
    await wait(150)
    // Display press, as captured: the Output Interface reports bit 6 on.
    bus('1CFF0401 27 99 01 0F 40 00 00 00')
    await wait(150)
    assert.deepStrictEqual(shelly.sets, [true])
    await plugin._bridgePoll() // read back: on, our own change
    assert.deepStrictEqual(out, []) // nothing sent to CZone for it
    // Switched off at the Shelly: the plugin sends the CZone OFF for circuit 0x0B.
    shelly.output = false
    await plugin._bridgePoll()
    const frames = out.map(l => l.split(',').slice(6).join(' ').toUpperCase())
    assert(frames.some(f => /^27 99 0B 00 00 \w\w F2 08$/.test(f)), frames.join('\n'))
    bus('1CFF0401 27 99 01 0F 00 00 00 00')
    await wait(50)
    const st = linkStatus()
    assert.deepStrictEqual([st.circuit, st.czone, st.device, st.inStep], ['Shelly Relay - Powerboard', false, false, true])
    assert.deepStrictEqual(shelly.sets, [true]) // not sent back
    plugin.stop()
  }

  // --- The same, with the circuit nominated to confirm before off (as
  //     Instruments is on Compass Rose), and out of step at start.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czone-bridge-'))
    const dataDir = path.join(dir, 'plugin-config-data', 'signalk-czone-circuits')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench-Shelly-2026-10-13.zcf'), path.join(dataDir, 'installation.zcf'))
    const listeners = new Map()
    const out = []
    const app = {
      config: { configPath: dir },
      debug () {}, error () {}, setPluginStatus () {}, setPluginError () {},
      on: (e, fn) => listeners.set(e, fn), removeListener: e => listeners.delete(e),
      emit: (e, line) => { if (e === 'nmea2000out') out.push(line) },
      handleMessage () {}, registerPutHandler () {},
      isNmea2000OutAvailable: true,
      getSelfPath: () => undefined
    }
    const plugin = require('../index')(app)
    shelly.output = false; shelly.sets = []
    plugin.start({ enableSending: true, confirmOff: ['Shelly Relay - Powerboard'], bridges: [{ circuit: 'Shelly Relay - Powerboard', target: 'shelly', host }] })
    const bus = frame => listeners.get('canboatjs:rawoutput')(`2026-10-13T05:00:00.000Z R ${frame}`)
    const routes = {}
    plugin.registerWithRouter({ get: (p, fn) => { routes[p] = fn }, post () {} })
    const linkStatus = () => { let v; routes['/bridge/status']({}, { json: x => { v = x } }); return v.links[0] }
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
    const offFrames = () => out.map(l => l.split(',').slice(6).join(' ').toUpperCase()).filter(f => /^27 99 0B 00 00 \w\w F2 08$/.test(f))

    // Out of step at start: circuit on, Shelly off (as a relay after a reboot). Nothing is switched.
    bus('1CFF0401 27 99 01 0F 40 00 00 00')
    await wait(150)
    await plugin._bridgePoll(); await plugin._bridgePoll()
    assert.deepStrictEqual([out, shelly.sets], [[], []])
    assert.deepStrictEqual([linkStatus().inStep, linkStatus().czone, linkStatus().device], [false, true, false])
    // Shelly on, then off, elsewhere: the circuit is never turned off; the link says why.
    shelly.output = true; await plugin._bridgePoll()
    shelly.output = false; await plugin._bridgePoll()
    await plugin._bridgePoll()
    assert.deepStrictEqual(offFrames(), [])
    assert.match(linkStatus().error, /not switched off: this circuit asks before turning off/)
    plugin.stop()
  }

  // --- A linked circuit is left out of this plugin's own Victron switch pane:
  //     the switch it drives has its own place there.
  {
    const { createVictronSwitches } = require('../lib/victron/switches')
    const objects = {}
    const paneBus = {
      exportInterface: (obj, p) => { objects[p] = obj },
      requestName: (_n, _f, cb) => cb(null, 1),
      sendSignal () {},
      invoke: (_m, cb) => cb(new Error('no localsettings'))
    }
    const paneApp = { getDataDirPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'vsw-')), getSelfPath: () => undefined, putSelfPath () {}, streambundle: { getSelfBus: () => ({ onValue: () => () => {} }) } }
    const zcf = path.join(__dirname, 'fixtures', 'TestBench-Shelly-2026-10-13.zcf')
    const linked = createVictronSwitches(paneApp, { version: 'test' })
    const st = await linked.start({ victronSwitches: true, bridges: [{ circuit: 'Shelly Relay - Powerboard', target: 'shelly', host: '192.168.1.204' }] }, zcf, { bus: paneBus })
    assert.strictEqual(st.channels, 6)
    assert(!Object.keys(objects).some(p => /Shelly_Relay/.test(p)))
    linked.stop()
    for (const k of Object.keys(objects)) delete objects[k]
    const plain = createVictronSwitches(paneApp, { version: 'test' })
    const st2 = await plain.start({ victronSwitches: true }, zcf, { bus: paneBus })
    assert.strictEqual(st2.channels, 7)
    assert(Object.keys(objects).some(p => /Shelly_Relay/.test(p)))
    plain.stop()
  }

  server.close()
  console.log('Third-party switch (bridge) tests passed')
})().catch(err => { console.error(err); process.exit(1) })
