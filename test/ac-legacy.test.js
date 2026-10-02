'use strict'

// AC from the older PGNs 127503 (input) / 127504 (output), as bridged on
// Compass Rose by a Node-RED flow (payload built exactly as that flow does),
// alongside the newer 127744 / 127747. One AC meter, one set of readings.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { decodeSensorPacket, FAST_SENSOR_PGNS, sensorRank } = require('../lib/monitor/sensors')
const { createFastPacketReassembler } = require('../lib/monitor/fastpacket')
const { createMonitor } = require('../lib/monitor')

function payload (instance, volts, amps, hz, watts) {
  const d = Buffer.alloc(20)
  d.writeUInt8(instance, 0); d.writeUInt8(1, 1); d.writeUInt8(0xFC, 2)
  d.writeUInt16LE(Math.round(volts * 100), 3)
  d.writeUInt16LE(Math.round(amps * 10), 5)
  d.writeUInt16LE(Math.round(hz * 100), 7)
  d.writeUInt16LE(0xFFFF, 9)
  d.writeUInt32LE(Math.round(watts), 11)
  d.writeUInt32LE(0xFFFFFFFF, 15)
  d.writeInt8(127, 19)
  return d
}
// Split a payload into fast-packet CAN frames.
function frames (p, seq = 0) {
  const out = [Buffer.concat([Buffer.from([seq << 5, p.length]), p.subarray(0, 6)])]
  for (let o = 6, n = 1; o < p.length; o += 7, n++) {
    const chunk = Buffer.alloc(7, 0xFF); p.copy(chunk, 0, o, Math.min(o + 7, p.length))
    out.push(Buffer.concat([Buffer.from([(seq << 5) | n]), chunk]))
  }
  return out
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join(' ')

// --- Decoding
{
  const got = Object.fromEntries(decodeSensorPacket(127504, payload(0, 231.4, 5.3, 50.02, 1226)).map(v => [v.key, v.value]))
  assert.deepStrictEqual(got, { 'acVoltage:0:0': 231.4, 'acCurrent:0:0': 5.3, 'acFrequency:0:0': 50.02, 'acPower:0:0': 1226 })
  const input = Object.fromEntries(decodeSensorPacket(127503, payload(1, 238, 0, 49.9, 0)).map(v => [v.key, v.value]))
  assert.deepStrictEqual(input, { 'acVoltage:1:0': 238, 'acCurrent:1:0': 0, 'acFrequency:1:0': 49.9, 'acPower:1:0': 0 })
  // Not available fields are left out; a packet with no lines says nothing.
  const na = payload(0, 0, 0, 0, 0); na.writeUInt16LE(0xFFFF, 5); na.writeUInt32LE(0xFFFFFFFF, 11)
  assert.deepStrictEqual(decodeSensorPacket(127504, na).map(v => v.key), ['acVoltage:0:0', 'acFrequency:0:0'])
  const none = payload(0, 230, 1, 50, 230); none[1] = 0
  assert.deepStrictEqual(decodeSensorPacket(127504, none), [])
  assert(sensorRank(127504) > sensorRank(127747))
}

// --- Reassembly: three CAN frames per message
{
  const seen = []
  const re = createFastPacketReassembler(FAST_SENSOR_PGNS, p => seen.push(p))
  for (const f of frames(payload(0, 230, 2, 50, 460), 3)) re.accept({ pgn: 127504, source: 101, data: f })
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].payload.length, 20)
  assert.strictEqual(decodeSensorPacket(127504, seen[0].payload)[0].value, 230)
}

// --- Through the monitor: Compass Rose's AC meters (Inverter Output = AC
//     instance 0, AC Input = 1) from the bridged PGNs, as sent by Signal K (0x65).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-ac-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'Compass-Rose-28.06.26.zcf'), zcfFile)
  const monitor = createMonitor({ getSelfPath: () => undefined, debug: () => {} })
  monitor.start({ trendDirectory: path.join(dir, 'trends'), monitorWire: false }, zcfFile)
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  const call = p => { let out; routes[p]({ query: {} }, { json: v => { out = v } }); return out }
  const send = (id, p, seq) => { for (const f of frames(p, seq)) monitor.onRawFrame(`0 R ${id} ${hex(f)}`) }
  const meter = name => Object.fromEntries(call('/monitor/items').items.find(i => i.name === name).readings.map(r => [r.key, r.value]))

  send('19F21065', payload(0, 231.4, 5.3, 50.02, 1226), 1) // 127504, AC output, instance 0
  send('19F20F65', payload(1, 238.1, 6.0, 49.98, 1400), 2) // 127503, AC input, instance 1
  assert.deepStrictEqual(meter('Inverter Output'), { voltage: 231.4, current: 5.3, power: 1226, frequency: 50.02 })
  assert.deepStrictEqual(meter('AC Input'), { voltage: 238.1, current: 6, power: 1400, frequency: 49.98 })

  // The newer PGNs for the same connection arrive too (another device, 0x2E):
  // the reading stays with the older pair instead of flipping between them.
  monitor.onRawFrame('0 R 19F3032E 01 00 FA 08 FF FF EA 01') // 127747 conn 0: 229.8 V, 49.0 Hz
  monitor.onRawFrame('0 R 19F3002E 01 00 63 00 10 27 00 00') // 127744 conn 0: 9.9 A, 10000 W
  assert.deepStrictEqual(meter('Inverter Output'), { voltage: 231.4, current: 5.3, power: 1226, frequency: 50.02 })
  const bus = call('/monitor/bus')
  assert.strictEqual(bus.sensorOwners['acVoltage:0:0'], '101/127504')
  assert.deepStrictEqual(bus.contested['acVoltage:0:0'].sort(), ['101/127504', '46/127747'])
  assert.strictEqual(bus.sensorsSeen['acVoltage:0:0@46'].value, 229.8) // still visible in diagnostics
  monitor.stop()
}

// --- Only the newer PGNs on the bus (bench Meter Interface): used as before.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-ac-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'Compass-Rose-28.06.26.zcf'), zcfFile)
  const monitor = createMonitor({ getSelfPath: () => undefined, debug: () => {} })
  monitor.start({ trendDirectory: path.join(dir, 'trends'), monitorWire: false }, zcfFile)
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  monitor.onRawFrame('0 R 19F3032E 01 00 FA 08 FF FF EA 01')
  let out; routes['/monitor/items']({ query: {} }, { json: v => { out = v } })
  assert.strictEqual(out.items.find(i => i.name === 'Inverter Output').readings.find(r => r.key === 'voltage').value, 229.8)
  monitor.stop()
}

console.log('AC (127503/127504) tests passed')
