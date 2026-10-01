'use strict'

const assert = require('assert')
const fs = require('fs')
const zcf = require('../lib/zcf')

const zcfPath = '/mnt/data/TestBench.zcf'
if (!fs.existsSync(zcfPath)) {
  console.log('Bench status tests skipped: TestBench.zcf not present')
  process.exit(0)
}

const mapping = zcf.load(zcfPath)
const find = name => mapping.circuits.find(c => c.name === name)

assert.deepStrictEqual(
  ['Light 1', 'Light 2', 'Light 3', 'Light 4', 'Light 5'].map(name => {
    const c = find(name)
    return [c.statusModule, c.statusMask, c.statusBit, c.statusFormat]
  }),
  [
    [0x01, 0x01, 0, 'load-table-mask'],
    [0x01, 0x02, 1, 'load-table-mask'],
    [0x01, 0x04, 2, 'load-table-mask'],
    [0x01, 0x08, 3, 'load-table-mask'],
    [0x01, 0x10, 4, 'load-table-mask']
  ]
)

// The companion Buzzer load owns bit 5 (0x20), but there is no logical
// circuit named Buzzer in the TestBench circuit table. Light 5 therefore uses
// its own 0x10 load mask even when the physical status bitmap reports 0x30.
assert.strictEqual(find('Light 5').statusMask, 0x10)
assert.strictEqual(mapping.circuits.some(c => c.name === 'Buzzer'), true)

console.log('TestBench load-table status mapping tests passed')
