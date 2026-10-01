'use strict'
const assert = require('assert')
const path = require('path')
const zcf = require('../lib/zcf')

const fixtures = path.join(__dirname, 'fixtures')

// The structural parser must not depend on the old E8 03 signature scan.
// Every valid circuit record is shown; only Modes and logic blocks are excluded.
// Duplicate names and zero-control circuits are not visibility filters.
const expectedCounts = new Map([
  ['TestBench.zcf', 6],
  ['Compass-Rose-28.06.26.zcf', 35],
  ['Persevere-14.07.25.zcf', 58],
  ['Sel-Citron-02.04.25.zcf', 102],
  ['Meitaki-07.04.25.zcf', 109],
  ['SugarShack-20260927-01.zcf', 110]
])

for (const [file, count] of expectedCounts) {
  const mapping = zcf.load(path.join(fixtures, file))
  assert.strictEqual(mapping.circuits.length, count, `${file}: structural circuit count`)
  assert(mapping.circuits.every(c => c.module === null || c.module === null || c.module >= 0), `${file}: no circuit may use module 0`)
  assert(mapping.circuits.every(c => c.name.length > 0), `${file}: circuit names`)
}

const meitaki = zcf.load(path.join(fixtures, 'Meitaki-07.04.25.zcf'))
const audible = meitaki.circuits.find(c => c.name === 'Audible Alarm')
assert(audible, 'Meitaki Audible Alarm must remain visible')
assert(meitaki.circuits.filter(c => c.name === 'Audible Alarm').length >= 1)
assert.strictEqual(meitaki.circuits.some(c => c.name === 'OI12/LB6 AlarmPumpBilgeEngine on'), false)

// Real zero-control circuits remain visible because visibility is based on
// record kind, not on whether a control-circuit exists.
for (const [file, names] of [
  ['Sel-Citron-02.04.25.zcf', ['Salon Air Conditioner']],
  ['Meitaki-07.04.25.zcf', ['Cabin Fans', 'Cockpit USB']],
  ['SugarShack-20260927-01.zcf', ['Solar Arch Port Charger CHG', 'Solar Arch Stbd Charger CHG', 'Solar Port Charger CHG', 'Solar Stbd Charger CHG']]
]) {
  const mapping = zcf.load(path.join(fixtures, file))
  for (const name of names) assert(mapping.circuits.some(c => c.name === name), `${file}: ${name} must remain`)
}

// Control-circuit metadata is decoded but does not control visibility.
const sugar = zcf.load(path.join(fixtures, 'SugarShack-20260927-01.zcf'))
const fuelXfer = sugar.circuits.find(c => c.name === 'Fuel Xfer')
assert(fuelXfer && fuelXfer.zcf.controls.length === 1)
assert.strictEqual(fuelXfer.zcf.controls[0].controlModule, 'All Display Interfaces')
assert.strictEqual(fuelXfer.zcf.controls[0].description, 'Utility 12v below mast')
const wireless = sugar.circuits.find(c => c.name === '200L Fridge Light')
assert(wireless && wireless.zcf.controls.some(c => c.controlModule === 'COI 05 Stbd Aft Under Fridge'))

console.log('Structural ZCF fixture regression tests passed')
