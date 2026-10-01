'use strict'

// Ground truth: Meters and Inputs tabs of the CZone Configuration Tool.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { parseMeters, parseInputs } = require('../lib/zcf-monitor')

const fixtures = path.join(__dirname, 'fixtures')
const load = name => fs.readFileSync(path.join(fixtures, name))
const pick = (list, keys) => list.map(x => Object.fromEntries(keys.map(k => [k, x[k]])))

// --- TestBench: Meter Interface (0x04) DC1 House Battery, AC1 Power In,
//     AC2 Power Out; virtual DC Victron Shunt. Signal Interface (0x02) inputs
//     1-5 Switch to Neg, input 6 10-180 Ohm sender "Tank Level".
{
  const buf = load('TestBench.zcf')
  const m = parseMeters(buf)
  // Instances come from the DC/AC meter settings tables, not the meter list.
  // House Battery instance 0 confirmed live (Meter Interface, source 9);
  // Victron Shunt instance 2 confirmed live (Cerbo sends PGN 127508 instance 2)
  // and matches the Configuration Tool.
  assert.deepStrictEqual(pick(m.meters, ['name', 'type', 'module', 'instance']), [
    { name: 'Victron Shunt', type: 'DC', module: 0, instance: 2 },
    { name: 'House Battery', type: 'DC', module: 4, instance: 0 },
    { name: 'Power In', type: 'AC', module: 4, instance: 0 },
    { name: 'Power Out', type: 'AC', module: 4, instance: 1 }
  ])
  const i = parseInputs(buf)
  assert.deepStrictEqual(i.inputs.map(x => [x.name, x.module, x.input, x.wiring]), [
    ['Switch 1', 2, 0, 'switchToNeg'], ['Switch 2', 2, 1, 'switchToNeg'], ['Switch 3', 2, 2, 'switchToNeg'],
    ['Switch 4', 2, 3, 'switchToNeg'], ['Switch 5', 2, 4, 'switchToNeg'], ['Tank Level', 2, 5, 'resistive']
  ])
}

// --- Compass Rose: 2 DC / 2 AC virtual meters; inputs = 4 switch inputs on the
//     CXPs (Engine Room 0x01, Helm 0x02) + 6 third-party senders.
{
  const buf = load('Compass-Rose-28.06.26.zcf')
  const m = parseMeters(buf)
  assert.deepStrictEqual(pick(m.meters, ['name', 'type', 'virtual', 'instance']), [
    { name: 'House Battery', type: 'DC', virtual: true, instance: 0 },
    { name: 'Solar', type: 'DC', virtual: true, instance: 1 },
    { name: 'Inverter Output', type: 'AC', virtual: true, instance: 0 },
    { name: 'AC Input', type: 'AC', virtual: true, instance: 1 }
  ])
  const i = parseInputs(buf).inputs
  const senders = i.filter(x => x.thirdParty)
  assert.deepStrictEqual(senders.map(x => [x.name, x.type]), [
    ['Fridge Temperature', 'temperature'], ['Freezer Temperature', 'temperature'],
    ['Engine Room Temperature', 'temperature'], ['Cabin Temperature', 'temperature'],
    ['Fuel Level', 'tank'], ['Atmospheric Pressure', 'pressure']
  ])
  assert.deepStrictEqual(pick(senders.filter(x => x.type === 'tank'), ['fluidType', 'instance']), [{ fluidType: 'fuel', instance: 0 }])
  assert.deepStrictEqual(i.filter(x => !x.thirdParty).map(x => [x.name, x.module, x.wiring]), [
    ['BMS Pre-Alarm', 1, 'switchToPos'], ['Anchor Up', 2, 'switchToPos'],
    ['High Bilge Water Alarm', 2, 'switchToNeg'], ['Ignition', 2, 'switchToPos']
  ])
}

// --- Meter settings tables: every DC and AC meter gets its instance from
//     them (bench 1 Oct 2026 ZCF: Victron Shunt 2, 5V System - Victron 3,
//     House Battery 0, 5V System - MI 1).
{
  const m = parseMeters(load('TestBench-2026-10-01.zcf')).meters
  assert.deepStrictEqual(m.map(x => [x.name, x.meterId, x.instance]), [
    ['Victron Shunt', 1, 2], ['5V System - Victron', 4, 3], ['House Battery', 0, 0],
    ['5V System - MI', 1, 1], ['Power In', 0, 0], ['Power Out', 1, 1]
  ])
  for (const file of fs.readdirSync(fixtures).filter(f => f.endsWith('.zcf'))) {
    for (const x of parseMeters(load(file)).meters) assert.strictEqual(x.instanceFrom, 'settings', `${file}: ${x.name}`)
  }
}

// --- Every fixture: both tables must walk exactly.
for (const file of fs.readdirSync(fixtures).filter(f => f.endsWith('.zcf'))) {
  const buf = load(file)
  assert(parseMeters(buf), `${file}: meters table`)
  const i = parseInputs(buf)
  assert(i, `${file}: inputs table`)
  assert.strictEqual(i.inputs.length, i.count)
}

console.log('ZCF meters/inputs tests passed')
