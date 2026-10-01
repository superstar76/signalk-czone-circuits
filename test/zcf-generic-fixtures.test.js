'use strict'

const assert = require('assert')
const path = require('path')
const zcf = require('../lib/zcf')

const cases = [
  ['SugarShack-20260927-01.zcf', 'Sugar Shack-20260927-01', 110],
  ['TestBench.zcf', 'Test Bench', 6],
  ['Compass-Rose-28.06.26.zcf', 'Compass Rose 28.06.26', 35],
  ['Persevere-14.07.25.zcf', 'Persevere 14.07.25', 58],
  ['Sel-Citron-02.04.25.zcf', 'Sel Citron 02.04.25', 102],
  ['Meitaki-07.04.25.zcf', 'Meitaki 07.04.25', 109]
]

for (const [filename, vesselName, expectedCount] of cases) {
  const mapping = zcf.load(path.join(__dirname, 'fixtures', filename))
  assert.strictEqual(mapping.vesselName, vesselName, `${filename}: vessel/config name`)
  assert.strictEqual(mapping.circuits.length, expectedCount, `${filename}: circuit count`)
  assert(mapping.circuits.every(c => c.module === null || c.module >= 0), `${filename}: circuit module value`)
  assert(mapping.circuits.every(c => c.channel === null || (c.channel >= 0 && c.channel <= 0x29)), `${filename}: channel range`)
  assert(mapping.circuits.every(c => c.name.length > 0), `${filename}: circuit names`)
}

const testBench = zcf.load(path.join(__dirname, 'fixtures', 'TestBench.zcf'))
assert(testBench.modules.some(m => m.module === 0x01 && m.name === 'Output Interface'))
assert.strictEqual(testBench.modules.length, 4)
assert(testBench.modules.some(m => m.module === 0x10 && m.name === 'Display'))
assert(testBench.modules.find(m => m.module === 0x10).rawNameLength === 0x87)
const sugar = zcf.load(path.join(__dirname, 'fixtures', 'SugarShack-20260927-01.zcf'))
for (const [module, name] of [[0x1d, 'B&G PortHelm'], [0x07, 'B&G Screen'], [0x27, 'B&G StbdHelm'], [0xf8, 'ACOI 01 Stbd Aft'], [0x80, 'STBD Helm KeyPad']]) {
  assert(sugar.modules.some(m => m.module === module && m.name === name), `Sugar Shack module 0x${module.toString(16)} ${name} must be parsed`)
}
assert.strictEqual(sugar.modules.length, 16)
assert.strictEqual(sugar.moduleAddresses.includes(0x01), false)
assert.deepStrictEqual(
  testBench.circuits.map(c => [c.name, c.module, c.channel, c.zcfCircuitId]),
  [
    ['Buzzer', 1, 5, 0x05],
    ['Light 1', 1, 0, 0x06],
    ['Light 2', 1, 1, 0x07],
    ['Light 3', 1, 2, 0x08],
    ['Light 4', 1, 3, 0x09],
    ['Light 5', 1, 5, 0x0A]
  ]
)

console.log('Generic ZCF fixture parser tests passed')
