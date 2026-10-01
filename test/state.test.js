'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')

const zcfSource = '/mnt/data/SugarShack-20260927-01.zcf'
if (!fs.existsSync(zcfSource)) {
  console.log('Step 5 state tests skipped: live ZCF not present')
  process.exit(0)
}

const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-state-'))
const putHandlers = new Map()
const deltas = []
const rawListeners = new Map()
const emitted = []
const app = {
  config: { configPath },
  isNmea2000OutAvailable: true,
  on: (event, fn) => rawListeners.set(event, fn),
  removeListener: (event) => rawListeners.delete(event),
  emit: (event, line) => { if (event === 'nmea2000out') emitted.push(line) },
  debug: () => {},
  registerPutHandler: (_context, pathName, handler) => putHandlers.set(pathName, handler),
  handleMessage: (_id, delta) => deltas.push(delta),
  setPluginStatus: () => {}
}

const plugin = pluginFactory(app)
const installationDir = path.join(configPath, 'plugin-config-data', 'signalk-czone-circuits')
fs.mkdirSync(installationDir, { recursive: true })
fs.copyFileSync(zcfSource, path.join(installationDir, 'installation.zcf'))
plugin.start({})

assert.strictEqual(putHandlers.has('electrical.czone.mode.active'), true)
assert.strictEqual(putHandlers.has('electrical.czone.modes.nightCruising.switch.state'), false)

function makeDcPayload (module, page, slot, currentRaw, levelRaw) {
  const payload = Buffer.alloc(28)
  payload[0] = 0x27
  payload[1] = 0x99
  payload[2] = module
  payload[3] = page
  payload[4 + slot * 3] = currentRaw
  payload[5 + slot * 3] = levelRaw & 0xff
  payload[6 + slot * 3] = (levelRaw >>> 8) & 0xff
  return payload
}

function fastFrames (pgnHex, sourceHex, payload, sequence = 0) {
  const frames = []
  const first = payload.subarray(0, 6)
  frames.push(`2026-09-27T06:00:00.000Z R ${pgnHex}${sourceHex} ${((sequence << 4) | 0).toString(16).padStart(2, '0')} ${payload.length.toString(16).padStart(2, '0')} ${Array.from(first, b => b.toString(16).padStart(2, '0')).join(' ')}`)
  let offset = 6
  let frameNo = 1
  while (offset < payload.length) {
    const chunk = payload.subarray(offset, offset + 7)
    frames.push(`2026-09-27T06:00:00.000Z R ${pgnHex}${sourceHex} ${((sequence << 4) | frameNo).toString(16).padStart(2, '0')} ${Array.from(chunk, b => b.toString(16).padStart(2, '0')).join(' ')}`)
    offset += chunk.length
    frameNo++
  }
  return frames
}

const galley = require('../lib/zcf').load(zcfSource).circuits.find(c => c.name === 'Galley Lights')

// PGN 65284 is the authoritative circuit state. Galley Lights is encoded in
// runtime status module 0x14, bit 1 in the ZCF status table.
rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:00.000Z R 18FF0429 27 99 14 1F 02 00 00 00')
const stateDelta = deltas.find(d => d.updates[0].values.some(v => v.path === 'electrical.czone.Galley_Lights.switch.state'))
assert(stateDelta)
assert.strictEqual(stateDelta.updates[0].values.find(v => v.path.endsWith('.switch.state')).value, true)
assert.strictEqual(stateDelta.updates[0].source.label, 'CZone-DC')
assert.strictEqual(stateDelta.updates[0].source.type, 'NMEA2000')
assert.strictEqual(stateDelta.updates[0].source.src, '41')
assert.strictEqual(stateDelta.updates[0].source.pgn, 65284)

// Repeated identical 65284 status packets must not create redundant Signal K
// deltas. The server-side cache fans the one actual change out to every client.
const deltasAfterFirstState = deltas.length
rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:00.050Z R 18FF0429 27 99 14 1F 02 00 00 00')
assert.strictEqual(deltas.length, deltasAfterFirstState)

// A real state transition must still publish normally.
rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:00.075Z R 18FF0429 27 99 14 1F 00 00 00 00')
assert.strictEqual(deltas.length, deltasAfterFirstState + 1)

// 65284 state must not create or rewrite brightness.
const brightnessBeforeStatus = deltas.filter(d => d.updates[0].values.some(v => v.path === 'electrical.czone.Galley_Lights.switch.brightness')).length
rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:00.100Z R 18FF0429 27 99 14 1F 00 00 00 00')
const brightnessAfterStatus = deltas.filter(d => d.updates[0].values.some(v => v.path === 'electrical.czone.Galley_Lights.switch.brightness')).length
assert.strictEqual(brightnessAfterStatus, brightnessBeforeStatus)

// 130822 supplies brightness/level telemetry only. It must not synthesize
// switch.state from current/level telemetry.
const galleyStatusPage = Math.floor(galley.statusBit / 8)
const galleyStatusSlot = galley.statusBit % 8
const dcPayload = makeDcPayload(galley.statusModule, galleyStatusPage, galleyStatusSlot, 60, 0x07e8) // 6.0 A, 100%
for (const frame of fastFrames('1CFF06', '29', dcPayload)) rawListeners.get('canboatjs:rawoutput')(frame)
const brightnessDelta = deltas.find(d => d.updates[0].values.some(v => v.path === 'electrical.czone.Galley_Lights.switch.brightness'))
assert(brightnessDelta)
assert.strictEqual(brightnessDelta.updates[0].values.find(v => v.path.endsWith('.switch.brightness')).value, 1)
assert.strictEqual(brightnessDelta.updates[0].source.label, 'CZone-DC')
assert.strictEqual(brightnessDelta.updates[0].source.type, 'NMEA2000')
assert.strictEqual(brightnessDelta.updates[0].source.src, '41')
assert.strictEqual(brightnessDelta.updates[0].source.pgn, 130822)

// 50% and 0% transitions are decoded from the DC level field.
const halfPayload = makeDcPayload(galley.statusModule, galleyStatusPage, galleyStatusSlot, 32, 0x05f4) // (1524-1024)/10 = 50%
for (const frame of fastFrames('1CFF06', '29', halfPayload, 1)) rawListeners.get('canboatjs:rawoutput')(frame)
const halfBrightness = deltas.slice().reverse().find(d => d.updates[0].values.some(v => v.path === 'electrical.czone.Galley_Lights.switch.brightness')).updates[0].values.find(v => v.path.endsWith('.switch.brightness'))
assert.strictEqual(halfBrightness.value, 0.5)

const offPayload = makeDcPayload(galley.statusModule, galleyStatusPage, galleyStatusSlot, 0, 0x0400)
for (const frame of fastFrames('1CFF06', '29', offPayload, 2)) rawListeners.get('canboatjs:rawoutput')(frame)
const telemetryStateAfterOff = deltas.slice().reverse().find(d => d.updates[0].values.some(v => v.path === 'electrical.czone.Galley_Lights.switch.state'))
assert.strictEqual(telemetryStateAfterOff.updates[0].values.find(v => v.path.endsWith('.switch.state')).value, false)

// A received/echoed Night Mode activation becomes the confirmed active Mode.
rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:01.000Z R 1CFF0029 27 99 4D 00 00 24 F1 00')
const modeDelta = deltas.at(-1)
assert.strictEqual(modeDelta.updates[0].values[0].path, 'electrical.czone.mode.active')
assert.strictEqual(modeDelta.updates[0].values[0].value, 'nightCruising')

// AC status uses runtime module 0xF8 and status subtype 0x0A. The bitmap is
// still bytes 4..7. The fixture starts with Galley + Salon receptacles ON
// (bits 7 and 6), then exercises Washer bit 3 and Receptacles Port bit 4.
{
  const acPath = name => `electrical.czone.${name.replace(/ /g, '_')}.switch.state`
  const before = deltas.length
  rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:02.000Z R 1CFF040B 27 99 F8 0A C0 00 00 00')
  const galleyAc = deltas.find(d => d.updates[0].values.some(v => v.path === acPath('Receptacles Galley')))
  const salonAc = deltas.find(d => d.updates[0].values.some(v => v.path === acPath('Receptacles Salon')))
  assert(galleyAc)
  assert(salonAc)
  assert.strictEqual(galleyAc.updates[0].values.find(v => v.path === acPath('Receptacles Galley')).value, true)
  assert.strictEqual(salonAc.updates[0].values.find(v => v.path === acPath('Receptacles Salon')).value, true)

  rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:02.100Z R 1CFF040B 27 99 F8 0A C8 00 00 00')
  const washerOn = deltas.slice(before).reverse().find(d => d.updates[0].values.some(v => v.path === acPath('Washer')))
  assert(washerOn)
  assert.strictEqual(washerOn.updates[0].values.find(v => v.path === acPath('Washer')).value, true)

  rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:02.200Z R 1CFF040B 27 99 F8 0A D0 00 00 00')
  const portOn = deltas.slice(before).reverse().find(d => d.updates[0].values.some(v => v.path === acPath('Receptacles Port')))
  assert(portOn)
  assert.strictEqual(portOn.updates[0].values.find(v => v.path === acPath('Receptacles Port')).value, true)

  rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:02.300Z R 1CFF040B 27 99 F8 0A C0 00 00 00')
  const portOff = deltas.slice(before).reverse().find(d => d.updates[0].values.some(v => v.path === acPath('Receptacles Port')))
  assert.strictEqual(portOff.updates[0].values.find(v => v.path === acPath('Receptacles Port')).value, false)

  console.log('AC CZone 65284 status mapping tests passed')
}

// Virtual Timed Water Heater circuits do not have same-named status records.
// Their ZCF extended outputs structurally map them to the AC status table: bit
// 0 = Water Heater Port and bit 1 = Water Heater Stbd. A returning 65284 packet
// must therefore update the corresponding virtual circuit state.
{
  const portPath = 'electrical.czone.Timed_Port_Water_Heater.switch.state'
  const stbdPath = 'electrical.czone.Timed_Stbd_Water_Heater.switch.state'
  const before = deltas.length
  rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:03.000Z R 1CFF040B 27 99 F8 0A 01 00 00 00')
  const port = deltas.slice(before).find(d => d.updates[0].values.some(v => v.path === portPath))
  assert(port)
  assert.strictEqual(port.updates[0].values.find(v => v.path === portPath).value, true)

  rawListeners.get('canboatjs:rawoutput')('2026-09-27T06:00:03.100Z R 1CFF040B 27 99 F8 0A 02 00 00 00')
  const stbd = deltas.slice(before).find(d => d.updates[0].values.some(v => v.path === stbdPath))
  assert(stbd)
  assert.strictEqual(stbd.updates[0].values.find(v => v.path === stbdPath).value, true)
  console.log('Virtual Timed Water Heater runtime status tests passed')
}

plugin.stop()
console.log('Signal K CZone observed state and Mode observation tests passed')

// Alpha.19 regression: observed 130822 state/brightness must use the
// actual NMEA-2000 source address, not the ZCF module ID.
{
  const sk = require('../lib/signalk')
  const circuit = { slug: 'Deck_Spot_Lights', source: 'CZone-DC.3' }
  const d = sk.circuitDelta(sk.statePath(circuit), true, circuit, sk.nmea2000Source(7, 130822))
  assert.strictEqual(d.updates[0].source.label, 'CZone-DC')
  assert.strictEqual(d.updates[0].source.type, 'NMEA2000')
  assert.strictEqual(d.updates[0].source.src, '7')
  assert.strictEqual(d.updates[0].source.pgn, 130822)
  console.log('Observed NMEA source regression test passed')
}

