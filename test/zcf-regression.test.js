'use strict'
const assert = require('assert')
const path = require('path')
const zcf = require('../lib/zcf')

const file = path.join(__dirname, 'fixtures', 'SugarShack-20260927-01.zcf')
const mapping = zcf.load(file)

const bimini = mapping.circuits.find(c => c.name === 'Bimini Lights')
const deck = mapping.circuits.find(c => c.name === 'Deck Spot Lights')
assert(bimini, 'Bimini Lights must be present in supplied ZCF')
assert(deck, 'Deck Spot Lights must be present in supplied ZCF')
assert.deepStrictEqual(
  { module: bimini.module, channel: bimini.channel, slot: bimini.slot, zcfCircuitId: bimini.zcfCircuitId },
  { module: 26, channel: 4, slot: 4, zcfCircuitId: 0x44 }
)
assert.deepStrictEqual(
  { module: deck.module, channel: deck.channel, slot: deck.slot, zcfCircuitId: deck.zcfCircuitId },
  { module: 28, channel: 14, slot: 6, zcfCircuitId: 0x21 }
)

// 200L Fridge's circuit record contains the same E8 03 bytes that occur in
// status records. Status mapping is structural: it reads the separate status
// table after the circuit table and therefore cannot confuse the circuit bytes
// with the status record.
const fridge100 = mapping.circuits.find(c => c.name === '100L Fridge')
const fridge200 = mapping.circuits.find(c => c.name === '200L Fridge')
assert.strictEqual(fridge100.statusModule, 0x14)
assert.strictEqual(fridge100.statusBit, 13)
assert.strictEqual(fridge200.statusModule, 0x1A)
assert.strictEqual(fridge200.statusBit, 13)
assert.strictEqual(fridge200.statusMask, 1 << 13)

// These are configuration-module identities. The captured 65284 runtime
// status frames use different module bytes (Bimini 26, Deck 28). Do not
// silently equate those namespaces; that mapping is the next regression target.
console.log('Supplied ZCF regression fixture loaded; config module identities verified')

// Circuit-menu categories are decoded from the ZCF category bitfields. These
// checks intentionally use several circuits that exercise both single and
// multiple category assignments.
const categoryCases = [
  ['Salon Lights', ['DC'], ['Lighting']],
  ['Bimini Lights', ['DC'], ['Lighting']],
  ['Port Gangway Bilge Pump', ['DC'], ['Pumps']],
  ['Anchor Light', ['DC'], ['Lighting', 'Navigation']],
  ['Chartplotter Port', ['DC'], ['Navigation']],
  ['Stereo', ['DC'], ['Entertainment']],
  ['Starlink', ['DC'], ['Entertainment']],
  ['Nemeis', ['DC'], ['Navigation', 'Entertainment']],
  ['Underwater Lights', ['DC'], ['Lighting', 'Entertainment']]
]
for (const [name, master, sub] of categoryCases) {
  const circuit = mapping.circuits.find(c => c.name === name)
  assert(circuit, `missing category fixture circuit: ${name}`)
  assert.deepStrictEqual(circuit.masterCategories, master, `${name} master categories`)
  assert.deepStrictEqual(circuit.subCategories, sub, `${name} sub categories`)
  assert.strictEqual(circuit.userSubCategories.length, 0, `${name} user categories`)
  assert(Number.isInteger(circuit.zcf.category.subCategoryBits), `${name} raw subcategory bitmap`)
  assert(Number.isInteger(circuit.zcf.category.categoryWord), `${name} raw category word`)
}
