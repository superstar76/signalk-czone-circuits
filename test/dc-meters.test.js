'use strict'

// DC meters picked up from the ZCF alone: each meter's NMEA 2000 instance and
// DC type come from the ZCF, and the device it is read from is the one whose
// PGN 127506 declares that type. Frames are from Compass Rose, 3 Oct 2026
// (candump, two rounds of every battery message on the bus).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseMeters } = require('../lib/zcf-monitor')
const { decodeDcSender } = require('../lib/monitor/sensors')
const { createMonitor } = require('../lib/monitor')

const fixture = name => path.join(__dirname, 'fixtures', name)
const dcMeters = name => Object.fromEntries(parseMeters(fs.readFileSync(fixture(name))).meters.filter(m => m.type === 'DC').map(m => [m.name, m]))

// --- DC type and nominal voltage from the ZCF (settings record byte 28).
{
  const cr = dcMeters('Compass-Rose-28.06.26.zcf')
  assert.deepStrictEqual([cr['House Battery'].instance, cr['House Battery'].dcTypeName], [0, 'battery'])
  assert.deepStrictEqual([cr.Solar.instance, cr.Solar.dcTypeName, cr.Solar.dcType], [1, 'solar', 3])

  const ss = dcMeters('SugarShack-20260927-01.zcf')
  for (const n of ['Solar Port', 'Solar Stbd', 'Solar Arch Port', 'Solar Arch Stbd']) assert.strictEqual(ss[n].dcTypeName, 'solar', n)
  for (const n of ['Port Alternator', 'Stbd Alternator', 'Port Alt Current', 'Stbd Alt Current']) assert.strictEqual(ss[n].dcTypeName, 'alternator', n)
  for (const n of ['House Battery', 'Port Start Battery', 'Stbd Start Battery']) assert.strictEqual(ss[n].dcTypeName, 'battery', n)

  const mei = dcMeters('Meitaki-07.04.25.zcf')
  assert.deepStrictEqual([mei.Solar.dcTypeName, mei['House Battery 12V'].nominalVoltage, mei['Bow Thruster Battery 24V'].nominalVoltage], ['solar', 12, 24])
  assert.strictEqual(dcMeters('Sel-Citron-02.04.25.zcf')['12V DC'].dcTypeName, 'converter')
  assert.strictEqual(dcMeters('TestBench-2026-10-01.zcf')['5V System - MI'].dcTypeName, 'converter')
  assert.strictEqual(dcMeters('Persevere-14.07.25.zcf').Solar.dcTypeName, 'solar')
}

// --- Monitoring groups follow the DC type: a solar meter is not a battery.
{
  const { buildCatalog } = require('../lib/monitor/catalog')
  const groups = name => Object.fromEntries(buildCatalog(fs.readFileSync(fixture(name))).items.filter(i => i.source === 'zcf-meter').map(i => [i.name, i.group]))
  assert.deepStrictEqual(groups('Compass-Rose-03.10.26.zcf'), {
    'House Battery': 'Batteries', Solar: 'Solar', 'Start Battery': 'Batteries', Alternator: 'Alternators', 'Inverter Output': 'AC Power', 'AC Input': 'AC Power' })
  const ss = groups('SugarShack-20260927-01.zcf')
  assert.deepStrictEqual([ss['Solar Port'], ss['Port Alternator'], ss['House Battery'], ss['Inverter 230V']], ['Solar', 'Alternators', 'Batteries', 'AC Power'])
  assert.strictEqual(groups('TestBench-2026-10-01.zcf')['5V System - MI'], 'Converters')
}

// --- PGN 127506 first frame: what the device says the instance is.
assert.deepStrictEqual(decodeDcSender(127506, Buffer.from('400B2B0103FFFFFF', 'hex')), { instance: 1, dcType: 3, soc: false })
assert.deepStrictEqual(decodeDcSender(127506, Buffer.from('A00B9F000054FFFF', 'hex')), { instance: 0, dcType: 0, soc: true })
assert.strictEqual(decodeDcSender(127506, Buffer.from('A1FFFFFF3100FFFF', 'hex')), null) // second frame
assert.strictEqual(decodeDcSender(127508, Buffer.from('004D053601BB719F', 'hex')), null)

// Battery messages on Compass Rose. Instance 0 comes from five devices,
// instance 1 from three.
const FRAMES = [
  ['19F214E3', '00 4D 05 36 01 BB 71 9F'], // 227 BMS: 13.57 V, 31.0 A, 18 °C
  ['19F212E3', 'A0 0B 9F 00 00 54 FF FF'], //     battery, SoC 84 %
  ['19F214E1', '00 56 05 EF FF FF FF A3'], // 225 inverter/charger: 13.66 V, -1.7 A (no 127506)
  ['19F214E0', '00 4A 05 23 01 FF FF A9'], // 224 shunt: 13.54 V, 29.1 A
  ['19F214E0', '01 F0 04 FF 7F FF FF A9'], //     aux input as instance 1: 12.64 V
  ['19F212E0', '60 0B A9 00 00 FF FF FF'], //     battery, no SoC
  ['19F214E4', 'EF 4D 05 38 01 BB 71 AC'], // 228 BMS again as instance 239
  ['19F212E4', '20 0B AC EF 00 54 FF FF'],
  ['19F21424', '00 64 05 7B 01 FF FF 2B'], // 36 MPPT, battery side: 13.80 V, 37.9 A
  ['19F21224', 'A0 0B 2B 00 00 FF FF FF'], //     instance 0 = battery
  ['19F21424', '01 D0 1F 41 00 FF FF 2B'], //     array: 81.44 V, 6.5 A
  ['19F21224', '40 0B 2B 01 03 FF FF FF'], //     instance 1 = solar cell
  ['19F2142E', '00 49 05 00 00 FF FF B4'], // 46 DC-DC converter: 13.53 V, 0 A
  ['19F2142E', '01 EE 04 00 00 FF FF B4'], //     12.62 V, 0 A
  ['19F2122E', 'E0 0B B4 00 00 FF FF FF'], //     instance 0 = battery
  ['19F2122E', 'E0 0B B4 01 02 FF FF FF'] //      instance 1 = converter
]

function start (fixtureName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-dc-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(fixture(fixtureName), zcfFile)
  const monitor = createMonitor({ getSelfPath: () => undefined, debug: () => {} })
  monitor.start({ trendDirectory: path.join(dir, 'trends'), monitorWire: false }, zcfFile)
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  const call = p => { let out; routes[p]({ query: {} }, { json: v => { out = v } }); return out }
  const meter = name => Object.fromEntries(call('/monitor/items').items.find(i => i.name === name).readings.map(r => [r.key, r.value]))
  const send = frames => { for (const [id, data] of frames) monitor.onRawFrame(`0 R ${id} ${data}`) }
  return { monitor, call, meter, send }
}

// --- Whatever order the devices are heard in, the result is the same.
for (const order of [FRAMES, [...FRAMES].reverse()]) {
  const { monitor, call, meter, send } = start('Compass-Rose-28.06.26.zcf')
  send(order)
  send(order) // every device repeats itself; by now each has stated its type

  // Solar: the only device that calls instance 1 "solar cell" is the MPPT.
  // No state of charge or temperature offered for a solar meter.
  assert.deepStrictEqual(meter('Solar'), { voltage: 81.44, current: 6.5 })
  // House Battery: five candidates; the one that reports state of charge wins.
  const house = meter('House Battery')
  assert.deepStrictEqual([house.voltage, house.current, house.soc], [13.57, 31, 0.84])
  assert(Math.abs(house.temperature - 291.15) < 0.01)

  const dc = call('/monitor/bus').dcMeters
  assert.deepStrictEqual([dc[0].wanted, dc[0].chosen], ['battery', 227])
  assert.deepStrictEqual([dc[1].wanted, dc[1].chosen], ['solar', 36])
  assert.strictEqual(dc[1].senders[46].type, 'converter')
  assert.strictEqual(dc[1].senders[224].type, 'not stated')
  // Battery ranking: BMS (SoC) > shunt > chargers that also report a battery > inverter (no type).
  const s = dc[0].senders
  assert(s[227].score > s[224].score && s[224].score > s[36].score && s[36].score === s[46].score && s[46].score > s[225].score)
  monitor.stop()
}

// --- BMS off the bus: the house battery falls to the shunt, not to a charger.
{
  const { monitor, call, meter, send } = start('Compass-Rose-28.06.26.zcf')
  const noBms = FRAMES.filter(([id]) => !id.endsWith('E3'))
  send(noBms)
  send(noBms)
  const house = meter('House Battery')
  assert.deepStrictEqual([house.voltage, house.current, house.soc], [13.54, 29.1, null])
  assert.strictEqual(call('/monitor/bus').dcMeters[0].chosen, 224)
  monitor.stop()
}

// --- A solar meter with only an untyped sender on its instance still shows it.
{
  const { monitor, meter, send } = start('Compass-Rose-28.06.26.zcf')
  send([['19F214E0', '01 F0 04 FF 7F FF FF A9']])
  assert.strictEqual(meter('Solar').voltage, 12.64)
  monitor.stop()
}

// --- ...but once the MPPT has been heard, nothing else stands in for it.
{
  const { monitor, call, send } = start('Compass-Rose-28.06.26.zcf')
  send([['19F21224', '40 0B 2B 01 03 FF FF FF']]) // MPPT: instance 1 = solar cell
  send([['19F214E0', '01 F0 04 FF 7F FF FF A9'], ['19F2142E', '01 EE 04 00 00 FF FF B4']])
  assert.strictEqual(call('/monitor/items').items.find(i => i.name === 'Solar').readings.find(r => r.key === 'voltage').value, null)
  send([['19F21424', '01 D0 1F 41 00 FF FF 2B']])
  assert.strictEqual(call('/monitor/items').items.find(i => i.name === 'Solar').readings.find(r => r.key === 'voltage').value, 81.44)
  monitor.stop()
}

console.log('DC meter (type from ZCF, sender by 127506) tests passed')
