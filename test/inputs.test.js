'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { STATUS_PGN, decodeModuleStatus, inputState, knowsKind } = require('../lib/monitor/inputs')
const { uniqueInputPaths } = require('../lib/monitor/catalog')
const { createMonitor } = require('../lib/monitor')

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex')

// --- The status message of a Signal Interface. Test bench, 6 Oct 2026: module
//     2 (kind 0x0D), five switches closed one after another and left closed.
{
  assert.strictEqual(STATUS_PGN, 65284)
  const steps = [
    ['27 99 02 0D 00 00 00 00', [false, false, false, false, false]],
    ['27 99 02 0D 02 00 00 00', [true, false, false, false, false]],
    ['27 99 02 0D 0A 00 00 00', [true, true, false, false, false]],
    ['27 99 02 0D 2A 00 00 00', [true, true, true, false, false]],
    ['27 99 02 0D AA 00 00 00', [true, true, true, true, false]],
    ['27 99 02 0D AA 02 00 00', [true, true, true, true, true]]
  ]
  for (const [frame, expected] of steps) {
    const s = decodeModuleStatus(hex(frame))
    assert.deepStrictEqual([s.module, s.kind], [2, 0x0d])
    assert.deepStrictEqual([0, 1, 2, 3, 4].map(n => inputState(s.kind, s.bitmap, n)), expected, frame)
  }
  // The even bits are not inputs: only 2n+1 counts.
  const even = decodeModuleStatus(hex('27 99 02 0D 55 01 00 00'))
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(n => inputState(even.kind, even.bitmap, n)), [false, false, false, false, false])
  // The top of the bitmap is read as unsigned; past it there is nothing.
  const top = decodeModuleStatus(hex('27 99 02 0D 00 00 00 80'))
  assert.strictEqual(inputState(top.kind, top.bitmap, 15), true)
  assert.strictEqual(inputState(top.kind, top.bitmap, 16), undefined)
  assert.strictEqual(inputState(top.kind, top.bitmap, -1), undefined)

  // Not a CZone status frame.
  assert.strictEqual(decodeModuleStatus(hex('13 99 02 0D AA 02 00 00')), null)
  assert.strictEqual(decodeModuleStatus(hex('27 99 02 0D AA 02 00')), null)
  assert.strictEqual(decodeModuleStatus(null), null)

  // Another kind of module (Control X PLUS, 0x36): not known, so no answer
  // rather than a guess.
  const cxp = decodeModuleStatus(hex('27 99 02 36 33 0E 01 00'))
  assert.deepStrictEqual([cxp.module, cxp.kind, knowsKind(cxp.kind), knowsKind(0x0d)], [2, 0x36, false, true])
  assert.strictEqual(inputState(cxp.kind, cxp.bitmap, 17), undefined)
}

// --- Two inputs with one name get separate paths.
{
  const item = (name, group = 'Inputs') => ({ name, group, readings: [{ candidates: [`electrical.czone.inputs.${name}.state`] }] })
  const out = uniqueInputPaths([item('Bilge'), item('Float'), item('Bilge'), item('Bilge'), { name: 'Tank', group: 'Other', readings: [] }])
  assert.deepStrictEqual(out.filter(i => i.group === 'Inputs').map(i => i.readings[0].candidates[0]),
    ['electrical.czone.inputs.Bilge.state', 'electrical.czone.inputs.Float.state', 'electrical.czone.inputs.Bilge2.state', 'electrical.czone.inputs.Bilge3.state'])
}

function boot (fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czone-inputs-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', fixture), zcfFile)
  const listeners = new Map()
  const deltas = []
  const signalk = new Map() // what Signal K holds: the last value published at each path, for ever
  const app = {
    getSelfPath: p => (signalk.has(p) ? { value: signalk.get(p), $source: 'signalk-czone-circuits' } : undefined),
    on: (event, fn) => listeners.set(event, fn),
    removeListener: event => listeners.delete(event),
    handleMessage: (_id, delta) => { for (const v of delta.updates[0].values) { deltas.push([v.path, v.value]); signalk.set(v.path, v.value) } },
    debug: () => {}
  }
  const monitor = createMonitor(app)
  monitor.start({ trendDirectory: path.join(dir, 'trends'), monitorWire: false }, zcfFile)
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  const call = (route, query = {}) => { let out; routes[route]({ query }, { json: v => { out = v }, status () { return this } }); return out }
  const bus = frame => listeners.get('canboatjs:rawoutput')(`2026-10-06T05:08:00.000Z R ${frame}`)
  const inputs = () => call('/monitor/items').items.filter(i => i.group === 'Inputs')
  return { monitor, call, bus, inputs, deltas, dir }
}

// --- The bench: five switches on module 2, driving the lights on module 1.
//     Time is stepped by hand so the trend rows are the same on every run.
{
  const realNow = Date.now
  const t0 = Math.floor(realNow() / 600e3) * 600e3 // the start of a ten-minute summary
  let clock = t0
  Date.now = () => clock
  try {
    const b = boot('TestBench-2026-10-01.zcf')
    const after = (ms, frame) => { clock += ms; if (frame) b.bus(frame) }
    const state = () => b.inputs().map(i => [i.name, i.mapped, i.readings[0].value])
    const p = n => `electrical.czone.inputs.Switch_${n}.state`
    // the trend as [seconds since the start, level]
    const trend = n => b.call('/trend', { path: p(n), range: '1h' }).data.map(r => [Math.round((r[0] - t0) / 100) / 10, r[1]])
    // what the page's fast update gets for switch n: [on, since, last time on], times in seconds since the start
    const sec = ms => (typeof ms === 'number' ? (ms - t0) / 1000 : ms)
    const fast = n => {
      const got = b.call('/monitor/inputs')
      assert.strictEqual(got.now, clock)
      const i = got.inputs[b.inputs().find(x => x.name === `Switch ${n}`).id]
      return i && [i.on, sec(i.since), i.lastOn && [sec(i.lastOn.at), i.lastOn.ms, sec(i.lastOn.until)]]
    }
    assert.deepStrictEqual(b.call('/monitor/inputs').inputs, {}) // nothing heard yet

    // Before the module has been heard the row says what is missing.
    assert.deepStrictEqual(b.inputs().map(i => i.name), ['Switch 1', 'Switch 2', 'Switch 3', 'Switch 4', 'Switch 5'])
    assert(b.inputs().every(i => !i.mapped && i.note === 'No status message from module 0x02 yet' && i.readings[0].unit === 'bool'))

    // 2 s: all open.
    after(2000, '1CFF041B 27 99 02 0D 00 00 00 00')
    assert.deepStrictEqual(state(), [1, 2, 3, 4, 5].map(n => [`Switch ${n}`, true, false]))
    assert.deepStrictEqual(b.deltas, [1, 2, 3, 4, 5].map(n => [p(n), false]))
    b.monitor.sample()
    // Found open when the plugin started: since when is not known.
    assert.deepStrictEqual([1, 2, 3, 4, 5].map(fast), [1, 2, 3, 4, 5].map(() => [false, null, null]))

    // 4 s: switches 1 and 2 closed. Published as booleans, once per change.
    b.deltas.length = 0
    after(2000, '1CFF041B 27 99 02 0D 0A 00 00 00')
    after(2000, '1CFF041B 27 99 02 0D 0A 00 00 00')
    assert.deepStrictEqual(b.deltas, [[p(1), true], [p(2), true]])
    assert.deepStrictEqual(state().map(s => s[2]), [true, true, false, false, false])
    // The fast update: on since the change (4 s), not since the repeat (6 s).
    assert.deepStrictEqual(fast(1), [true, 4, null])
    assert.deepStrictEqual(fast(3), [false, null, null])

    // The lights they drive come on at module 1: that is the circuits' message
    // and does not touch the inputs. Nor does another module's bitmap, whether
    // of a kind that is not known or another Signal Interface with all open.
    b.deltas.length = 0
    after(100, '1CFF0401 27 99 01 0F 03 00 00 00')
    after(100, '1CFF0409 27 99 04 0E AA 02 00 00')
    after(100, '1CFF041C 27 99 03 0D 00 00 00 00')
    assert.deepStrictEqual(b.deltas, [])
    assert.deepStrictEqual(state().map(s => s[2]), [true, true, false, false, false])

    // 12 s: the next trend sample. 14 s: all open again, and a light switched
    // from the webapp with its switch open (as on 1 Oct 2026): the input stays off.
    after(5700); b.monitor.sample()
    after(2000, '1CFF041B 27 99 02 0D 00 00 00 00')
    after(100, '1CFF0401 27 99 01 0F 01 00 00 00')
    assert.deepStrictEqual(state().map(s => s[2]), [false, false, false, false, false])

    // The trend: 1 while on, 0 while off, under the same path, and each change
    // stored when it happened with the old value just before it (a square step).
    assert.deepStrictEqual(trend(1), [[2, 0], [4, 0], [4, 1], [14, 1], [14, 0]])
    assert.deepStrictEqual(trend(3), [[2, 0], [12, 0]]) // never changed: the first sample and the latest
    assert.strictEqual(b.call('/monitor/values').values[p(1)], false)
    // Off since 14 s; last on from 4 s for 10 s. The 5-second list carries the same.
    assert.deepStrictEqual(fast(1), [false, 14, [4, 10000, 14]])
    assert.deepStrictEqual(fast(3), [false, null, null])
    const s1 = b.inputs()[0]
    assert.deepStrictEqual([sec(s1.since), sec(s1.lastOn.at), s1.lastOn.ms], [14, 4, 10000])
    assert.strictEqual(b.inputs()[2].lastOn, null)

    // A tap on a momentary switch (bench, 6 Oct 2026: input 4 gave 80 00 then
    // 00 00 within the second). Both changes are published at once, and the
    // trend keeps the press although it is far shorter than a ten-second sample.
    after(7900); b.monitor.sample() // 22 s
    b.deltas.length = 0
    after(1000, '1CFF041B 27 99 02 0D 80 00 00 00') // 23 s
    after(400, '1CFF041B 27 99 02 0D 00 00 00 00') // 23.4 s
    assert.deepStrictEqual(b.deltas, [[p(4), true], [p(4), false]])
    // The page may ask only after the press is over: it is told when and how long.
    assert.deepStrictEqual(fast(4), [false, 23.4, [23, 400, 23.4]])
    after(8600); b.monitor.sample() // 32 s
    assert.deepStrictEqual(trend(4), [[2, 0], [23, 0], [23, 1], [23.4, 1], [23.4, 0], [32, 0]])

    // All five closed.
    after(2000, '1CFF041B 27 99 02 0D AA 02 00 00')
    assert.deepStrictEqual(state().map(s => s[2]), [true, true, true, true, true])

    // The module goes quiet: after two minutes the inputs are no longer shown
    // as live (the last value is not passed off as current).
    after(125e3)
    assert(b.inputs().every(i => !i.mapped && i.readings[0].value === null))
    assert.strictEqual(b.inputs()[0].note, 'Module 0x02 is reporting, but not this input')
    assert.deepStrictEqual(b.call('/monitor/inputs').inputs, {}) // a quiet module's inputs are not passed off as current
    // It comes back with switch 1 open and 5 closed. What happened while it was
    // quiet is not known, so no times are made up; the next change is timed again.
    after(1000, '1CFF041B 27 99 02 0D 00 02 00 00')
    assert.deepStrictEqual(fast(1), [false, null, [4, 10000, 14]])
    assert.deepStrictEqual(fast(5), [true, null, null])
    after(3000, '1CFF041B 27 99 02 0D 00 00 00 00')
    assert.deepStrictEqual(fast(5), [false, 163, [null, null, 163]]) // on from an unknown time until 163 s
    after(1000, '1CFF041B 27 99 02 0D 00 02 00 00')
    after(500, '1CFF041B 27 99 02 0D 00 00 00 00')
    assert.deepStrictEqual(fast(5), [false, 164.5, [164, 500, 164.5]])
    b.monitor.stop()
    // The ten-minute summary (long charts) of switch 4: every regular sample
    // found it off, so the average is 0; the presses show as the maximum.
    // The changes stored between samples do not count as time on.
    const summaryDir = path.join(b.dir, 'trends', p(4), 'summary')
    const summary = fs.readFileSync(path.join(summaryDir, fs.readdirSync(summaryDir)[0]), 'utf8').trim().split('\n').filter(l => /^\d/.test(l))
    assert.deepStrictEqual(summary, [`${t0},0,0,1`])
  } finally { Date.now = realNow }
}

// --- Compass Rose: its inputs are on Control X PLUS modules (kind 0x36). Where
//     they sit in that module's bitmap is not known yet, so nothing is claimed.
{
  const b = boot('Compass-Rose-03.10.26.zcf')
  assert.deepStrictEqual(b.inputs().map(i => [i.name, i.module, i.input]), [['BMS Pre-Alarm', 1, 24], ['Anchor Up', 2, 17], ['High Bilge Water Alarm', 2, 18], ['Ignition', 2, 24]])
  b.bus('1CFF0400 27 99 01 36 0C 00 01 00') // frames from the boat, 3 Oct 2026
  b.bus('1CFF0402 27 99 02 36 33 0E 01 00')
  assert.deepStrictEqual(b.deltas.filter(d => d[0].includes('.inputs.')), [])
  assert(b.inputs().every(i => !i.mapped && i.note === 'Input state is not decoded yet for this kind of module (0x36)'))
  b.monitor.stop()
}

console.log('switch input tests passed')
