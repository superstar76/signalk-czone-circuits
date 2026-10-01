'use strict'

const assert = require('assert')
const fs = require('fs')
const zcf = require('../lib/zcf')
const czone = require('../lib/czone')
const signalk = require('../lib/signalk')

const zcfPath = '/mnt/data/Sugar Shack-20260522-01.zcf'
if (fs.existsSync(zcfPath)) {
  const mapping = zcf.load(zcfPath)
  const find = name => mapping.circuits.find(c => c.name === name)

  assert.strictEqual(find('Galley Lights').zcfCircuitId, 0x1B)
  assert.strictEqual(find('Sink Red Nighttime').zcfCircuitId, 0x65)
  assert.strictEqual(find('Stereo').zcfCircuitId, 0x2E)
  assert.strictEqual(find('Stereo Amplifier').zcfCircuitId, 0x29)
  assert.deepStrictEqual(
    ['Instruments', 'Stereo', 'Stbd Head', 'Chart Table 12V Receptacle'].map(name => {
      const c = find(name)
      return [c.statusModule, c.statusBit]
    }),
    [[0x12, 12], [0x12, 13], [0x12, 14], [0x12, 15]]
  )
  assert.deepStrictEqual(
    ['Bimini Lights', 'Deck Spot Lights', '200L Fridge Light', 'Galley Lights', 'Master Cabin Lights'].map(name => {
      const c = find(name)
      return [c.statusModule, c.statusBit]
    }),
    [[0x1A, 4], [0x1C, 14], [0x1A, 1], [0x14, 1], [0x1A, 0]]
  )

  assert.strictEqual(find('Sink Red Nighttime').slug, 'Sink_Red_Nighttime')
  assert.strictEqual(find('Bimini Lights').slug, 'Bimini_Lights')
  assert.strictEqual(find('Bimini Lights').source, 'CZone-DC.20')
  assert.strictEqual(find('200L Fridge Light').source, 'CZone-DC.28')
  assert.strictEqual(
    signalk.statePath(find('Sink Red Nighttime')),
    'electrical.czone.Sink_Red_Nighttime.switch.state'
  )
  assert.strictEqual(
    signalk.brightnessPath(find('Galley Lights')),
    'electrical.czone.Galley_Lights.switch.brightness'
  )
  assert.strictEqual(find('Sink Red Nighttime').protocolCircuitId, 0x65)
  assert.strictEqual(signalk.circuitSource(find('Bimini Lights')), 'CZone-DC.20')
  assert.strictEqual(find('Sink Red Nighttime').protocolParameter, 0x08)
  assert.strictEqual(find('Sink Red Nighttime').protocolOperationFamily, 'level')
  assert.strictEqual(find('Sink Red Nighttime').protocolConfidence, 'capture')
  assert.strictEqual(find('Sink Red Nighttime').capabilities.switch, true)
  assert.strictEqual(find('Salon Lights').protocolCircuitId, 0x45)
  assert.strictEqual(find('Salon Lights').protocolParameter, 0x24)
  assert.strictEqual(find('Salon Lights').protocolOperationFamily, 'level')
  assert.strictEqual(find('Salon Lights').protocolConfidence, 'zcf-dimmer-capture')
  assert.strictEqual(find('Bimini Lights').protocolCircuitId, 0x44)
  assert.strictEqual(find('Bimini Lights').protocolParameter, 0x24)
  assert.strictEqual(find('Bimini Lights').protocolOperationFamily, 'level')
  assert.strictEqual(find('Bimini Lights').protocolConfidence, 'zcf-dimmer-capture')
  assert.strictEqual(find('Salon Lights').capabilities.dimmer, true)
  const dimmers = mapping.circuits.filter(c => c.capabilities.dimmer).map(c => c.name)
  assert.deepStrictEqual(dimmers, [
    '200L Fridge Light', 'Bimini Lights', 'Galley Lights', 'Galley Stove Light',
    'Master Cabin Lights', 'Port Aft Cabin Lights', 'Port Fwd Cabin Lights',
    'Port Gangway Lights', 'Port Shower & Sailocker Lights', 'Salon Lights',
    'Sink Red Nighttime', 'Stbd Gangway Lights', 'Stbd Shower lights'
  ])
  assert.deepStrictEqual(mapping.modes.map(m => [m.id, m.runtimeId, m.name]), [
    [1004, 0x4E, 'Anchored'], [1002, 0x53, 'Day Crusing'], [1003, 0x4D, 'Night Cruising'], [1007, 0x56, 'Sleep']
  ])
  assert(mapping.modes.every(m => m.signalK.state.startsWith('electrical.czone.modes.')))
}

assert.deepStrictEqual([...czone.on(0x65)], [0x27,0x99,0x65,0x00,0x00,0x08,0xF1,0x08])
assert.deepStrictEqual([...czone.off(0x65)], [0x27,0x99,0x65,0x00,0x00,0x08,0xF2,0x08])
assert.deepStrictEqual([...czone.dimmerOn(0x45, 0x24)[0]], [0x27,0x99,0x45,0x00,0x00,0x24,0xF5,0x08])
assert.deepStrictEqual([...czone.dimmerOn(0x45, 0x24)[1]], [0x27,0x99,0x45,0x00,0x00,0x24,0x95,0x08])
assert.deepStrictEqual([...czone.dimmerOn(0x45, 0x24)[2]], [0x27,0x99,0x45,0x00,0x00,0x24,0x43,0x08])
assert.deepStrictEqual([...czone.dimmerOff(0x45, 0x24)[0]], [0x27,0x99,0x45,0x00,0x00,0x24,0xF5,0x08])
assert.deepStrictEqual([...czone.dimmerOff(0x45, 0x24)[1]], [0x27,0x99,0x45,0x00,0x00,0x24,0x95,0x08])
assert.deepStrictEqual([...czone.dimmerOff(0x45, 0x24)[2]], [0x27,0x99,0x45,0x00,0x00,0x24,0x42,0x08])
assert.deepStrictEqual([...czone.switchComplete(0x2e, 0x24)], [0x27,0x99,0x2e,0x00,0x00,0x24,0x40,0x08])
assert.deepStrictEqual([...czone.level(0x65, 50)], [0x27,0x99,0x65,0x00,0x32,0x08,0xFC,0x08])
assert.deepStrictEqual([...czone.level(0x45, 75, 0x24)], [0x27,0x99,0x45,0x00,0x4B,0x24,0xFC,0x08])
const currentZcfPath = '/mnt/data/SugarShack-20260927-01.zcf'
if (fs.existsSync(currentZcfPath)) {
  const current = zcf.load(currentZcfPath)
  const currentStatusMappingCount = current.circuits.filter(c => Number.isInteger(c.statusModule) && Number.isInteger(c.statusBit)).length
  assert.strictEqual(currentStatusMappingCount, 100)
  assert.deepStrictEqual(
    current.modes.map(m => [m.id, m.runtimeId, m.modeGroupId, m.name, m.actionCount, m.parsedActionCount, m.truncated]),
    [
      [1004, 0x4E, 0x01, 'Anchored', 18, 18, false],
      [1002, 0x53, 0x01, 'Day Crusing', 19, 19, false],
      [1003, 0x4D, 0x01, 'Night Cruising', 16, 16, false],
      [1007, 0x56, 0x01, 'Sleep', 26, 26, false]
    ]
  )
  assert.deepStrictEqual(
    current.modes.map(m => m.actions.map(a => a.value)),
    [
      [1000,1000,0,0,0,0,0,500,0,0,0,0,0,1000,0,0,0,0],
      [1000,0,1000,900,1000,1000,1000,1000,1000,0,1000,0,0,1000,1000,0,0,1000,1000],
      [1000,0,700,200,1000,1000,1000,100,1000,1000,1000,200,1000,1000,1000,1000],
      [0,300,0,0,0,0,0,0,0,0,0,100,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
    ]
  )
}

console.log('CZone circuit skeleton tests passed')
