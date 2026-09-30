'use strict'

// Ground truth: circuit and load lists shown by the CZone Configuration Tool,
// plus live-tested circuit IDs on the TestBench.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { parseCircuitTable, parseCircuits, parseModes } = require('../lib/zcf-circuits')

const fixtures = path.join(__dirname, 'fixtures')
const load = name => fs.readFileSync(path.join(fixtures, name))

// --- TestBench: 6 circuits in the Configuration Tool, IDs proven on the bus.
{
  const circuits = parseCircuits(load('TestBench.zcf'))
  assert.deepStrictEqual(circuits.map(c => c.name), ['Buzzer', 'Light 1', 'Light 2', 'Light 3', 'Light 4', 'Light 5'])
  const byName = Object.fromEntries(circuits.map(c => [c.name, c]))
  // Circuit IDs switched live with 27 99 <id> 00 00 xx F1 08.
  assert.strictEqual(byName.Buzzer.id, 0x05)
  assert.deepStrictEqual(['Light 1', 'Light 2', 'Light 3', 'Light 4', 'Light 5'].map(n => byName[n].id), [0x06, 0x07, 0x08, 0x09, 0x0A])
  // Output channels on Output Interface 0x01; Light 5 also drives the Buzzer
  // output, matching the observed 65284 bitmap 0x30.
  assert.deepStrictEqual(byName['Light 1'].outputs.map(o => [o.channel, o.module]), [[0, 1]])
  assert.deepStrictEqual(byName['Light 4'].outputs.map(o => [o.channel, o.module]), [[3, 1]])
  assert.deepStrictEqual(byName['Light 5'].outputs.map(o => [o.channel, o.module]).sort(), [[4, 1], [5, 1]])
  assert.deepStrictEqual(byName.Buzzer.outputs.map(o => [o.channel, o.module]), [[5, 1]])
}

// --- Compass Rose: 35 circuits / 36 loads in the Configuration Tool.
{
  const table = parseCircuitTable(load('Compass-Rose-28.06.26.zcf'))
  assert.strictEqual(table.recordCount, 44)
  const circuits = table.records.filter(r => !r.hidden)
  const expected = [
    'AFT Outlets', 'Anchor Light', 'Anchor Wash', 'Autopilot', 'DC Outlets',
    'E/R Bilge Pump', 'E/R Bilge Pump Running', 'E/R Blower', 'Engine Room Lights',
    'Freezer', 'Freezer -12⁰C', 'Freezer -18⁰C', 'Freezer 4⁰C', 'Freezer Temp Control',
    'Fresh Water Pump', 'Fridge', 'Fridge 4⁰C', 'Fridge 6⁰C', 'Fridge 8⁰C',
    'Fridge Temp Control', 'FWD Bilge Pump', 'FWD Bilge Pump Running',
    'High Bilge Water Alarm to Cerbo', 'Hot Water Cylinder', 'Instruments', 'Lights',
    'Live Bait Tank Pump', 'LPG', 'Nav Lights', 'Saltwater Pump', 'Stereo',
    'Stern Light', 'Test VS', 'Toilet', 'VHF'
  ]
  assert.deepStrictEqual(circuits.map(c => c.name), expected)
  assert(table.records.filter(r => r.hidden).every(r => r.name.startsWith('LB ') && r.kind === 'logic'))

  // Loads tab: Engine Room CXP = module 0x01, Helm CXP = module 0x02.
  // Channels: A.1-A.4 = 0-3, B.1-B.10 = 4-13, C.1-C.6 = 14-19, VS 01-10 = 0x20-0x29.
  const A = n => n - 1
  const B = n => 3 + n
  const C = n => 13 + n
  const VS = n => 0x1F + n
  const loads = {
    'Autopilot': [A(1), 1], 'Freezer': [A(3), 1], 'Fresh Water Pump': [A(4), 1],
    'Engine Room Lights': [B(1), 1], 'Saltwater Pump': [B(2), 1], 'E/R Bilge Pump': [B(3), 1],
    'E/R Blower': [B(4), 1], 'Anchor Wash': [B(5), 1], 'Live Bait Tank Pump': [B(6), 1],
    'LPG': [B(7), 1], 'Freezer Temp Control': [C(3), 1], 'AFT Outlets': [C(4), 1],
    'Hot Water Cylinder': [C(6), 1],
    'Toilet': [A(1), 2], 'Fridge': [A(3), 2], 'FWD Bilge Pump': [A(4), 2],
    'Lights': [B(1), 2], 'Anchor Light': [B(2), 2], 'Nav Lights': [B(3), 2],
    'Stern Light': [B(4), 2], 'Stereo': [B(5), 2], 'VHF': [B(6), 2], 'DC Outlets': [B(10), 2],
    'Fridge Temp Control': [C(3), 2], 'High Bilge Water Alarm to Cerbo': [C(6), 2],
    'Test VS': [VS(10), 2]
  }
  const byName = Object.fromEntries(circuits.map(c => [c.name, c]))
  for (const [name, [channel, module]] of Object.entries(loads)) {
    const out = byName[name].outputs.find(o => o.channel === channel && o.module === module && o.levelRaw > 0)
    assert(out, `${name} should drive module ${module} channel ${channel}`)
  }
  // Circuits with no outputs are the "Running" indicators.
  assert.deepStrictEqual(circuits.filter(c => c.outputs.length === 0).map(c => c.name), ['E/R Bilge Pump Running', 'FWD Bilge Pump Running'])
}

// --- Sel Citron (fixture saved 02.04.25): 102 circuits in that revision; the
// current Configuration Tool shows 110 after 9 additions and 1 rename.
{
  const table = parseCircuitTable(load('Sel-Citron-02.04.25.zcf'))
  assert.strictEqual(table.recordCount, 116)
  const circuits = table.records.filter(r => !r.hidden)
  assert.strictEqual(circuits.length, 102)
  const byName = Object.fromEntries(table.records.map(r => [r.name, r]))
  // Module dipswitches: COI 01-08 = 0x01..0x80, ACOI 01 = 0x03, ACOI 02 = 0x06.
  // COI channel order: DC5-DC16 = 0-11, DC1-DC3 = 12-14. ACOI: ACn = n-1. VSn = 0x1F+n.
  const COI = dc => (dc >= 5 ? dc - 5 : dc + 11)
  const expect = [
    ['Bilge Pump - Port E/R', 0x01, COI(1)], ['Fan - Port AFT Cabin', 0x01, COI(16)],
    ['Galley Lights', 0x02, COI(6)], ['Pantry Light', 0x04, COI(13)],
    ['Radar', 0x08, COI(3)], ['Boat Router', 0x08, COI(15)],
    ['Autopilot', 0x10, COI(1)], ['Cockpit Monitor', 0x20, COI(16)],
    ['Salon Lights', 0x40, COI(9)], ['Compass Lights', 0x80, COI(15)],
    ['VS - HWC STBD', 0x80, 0x1F + 9], ['VS - HWC Port', 0x80, 0x1F + 10],
    ['Hot Water Cylinder - STBD', 0x03, 0], ['Salon Air Conditioner', 0x06, 2]
  ]
  for (const [name, module, channel] of expect) {
    assert(byName[name].outputs.some(o => o.module === module && o.channel === channel && o.levelRaw > 0), `${name} -> module ${module} channel ${channel}`)
  }
  assert(table.records.filter(r => r.hidden).every(r => /^(LB |Permit |SoC )/.test(r.name)))
}

// --- Meitaki (07.04.25): Configuration Tool shows 115 = 107 circuits + 8 Modes.
{
  const buf = load('Meitaki-07.04.25.zcf')
  const table = parseCircuitTable(buf)
  assert.strictEqual(table.recordCount, 131)
  assert.deepStrictEqual(parseModes(buf).map(m => m.name).sort(),
    ['All Off', 'Furlers Off', 'Offshore', 'Onboard', 'Onboard Lte', 'Pumps and Fridges', 'Sailing', 'Winches'])
  const circuits = parseCircuits(buf)
  // Exact circuit list from the Configuration Tool (black entries).
  const toolCircuits = [
    "AIS Ping",
    "Alarm Signal Bilge Pump Running",
    "Anchor Light",
    "Audible Alarm",
    "Cabin Fans",
    "Cockpit USB",
    "Control Volt. Anchor Winch",
    "Control Volt. Bow Thruster",
    "Control Volt. Hydraulic",
    "Control Volt. Stern Thruster",
    "Control Volt. Thruster Operation",
    "Control Volt. Winch Prt",
    "Control Volt. Winch Stbd",
    "Electric Toil. Guest Aft Port",
    "Electric Toil. Guest Fwd Port",
    "Electric Toil. Owner Fwd Stbd",
    "Fan Pedestals",
    "Fan Window Deckhouse",
    "Fans Engine",
    "Fans Generator",
    "Freezer",
    "Furler Jib - IN",
    "Furler Jib - OUT",
    "Furler Main - IN",
    "Furler Main - OUT",
    "Furler Reacher - IN",
    "Furler Reacher - OUT",
    "Furlers On/Off",
    "Light Anchor",
    "Light Cockpit",
    "Light Compass",
    "Light Dimmer Helmstation",
    "Light Engineroom",
    "Light Galley Window",
    "Light Garage",
    "Light Guest Aft Ambi",
    "Light Guest Aft Main Cabin",
    "Light Guest Head Prt Ambi",
    "Light Guest Prt Ambi",
    "Light Guest Prt Main",
    "Light Guest Stbd Ambi",
    "Light Guest Stbd Main",
    "Light Hallway Aft",
    "Light Hallway Fwd",
    "Light Head Aft",
    "Light Head Middle",
    "Light Head Owner Ambi",
    "Light Head Owner Main",
    "Light Lazarette",
    "Light Main Saloon",
    "Light Navigation",
    "Light Navstation Saloon",
    "Light Owner Ambi",
    "Light Owner Main",
    "Light Red Cabin/HeadGuestAft",
    "Light Red Cockpit",
    "Light Red Guest Prt",
    "Light Red Guest Stbd",
    "Light Red Owner Cabin/Head",
    "Light Red Sal/Hall/Pantry",
    "Light Sail Locker",
    "Light Saloon Ambi",
    "Light Saloon Reading Prt",
    "Light Saloon Reading Stbd",
    "Light Spreaders",
    "Light Spreaders Dim 20",
    "Light Spreaders Dimmer",
    "Light Steaming",
    "Light Stern",
    "Light Table Saloon",
    "Light Tricolour",
    "Lithium - Charge Battery",
    "Lithium - Switch Over To",
    "Nav. AIS",
    "Nav. Autopilot",
    "Nav. Chartplotter Helmstations",
    "Nav. Chartplotter Navstation",
    "Nav. Instruments",
    "Nav. Network Switch",
    "Nav. Radar",
    "Outlets 12V DC",
    "Pump Bilge Engine \"Man.Override\"",
    "Pump Bilge Mast \"Man.Override\"",
    "Pump Bilge Middle \"Man.Override\"",
    "Pump Bilge Sail Locker",
    "Pump Deckwash",
    "Pump Engine Bilge",
    "Pump Freshwater",
    "Pump Graywater Engineroom",
    "Pump Graywater Owner Cabin",
    "Pump Manual With Hose",
    "Radios",
    "Refridgerator Galley",
    "Refridgerator Saloon",
    "Starlink",
    "Tank BLK Water Toil Aft \"Empty\"",
    "Tank BLK Water Toil Aft \"Full\"",
    "Tank BLK Water Toil Port \"Empty\"",
    "Tank BLK Water Toil Port \"Full\"",
    "Tank BLK Water Toil Stbd \"Empty\"",
    "Tank BLK Water Toil Stbd \"Full\"",
    "Tank Water \"Empty\"",
    "VHF",
    "Weather Station",
    "WiFi and Cerbo GX",
    "Winch Prt",
    "Winch Stbd"
    ]
  assert.deepStrictEqual(circuits.map(c => c.name.trim()).sort(), [...toolCircuits].sort())
  // "Audible Alarm" is stored three times; 0x01 and 0x02 have no controls and
  // are internal copies, 0x20 is the user-facing circuit.
  const internal = table.records.filter(r => r.kind === 'internal')
  assert.deepStrictEqual(internal.map(r => [r.name, r.id]), [['Audible Alarm', 0x01], ['Audible Alarm', 0x02]])
  assert.strictEqual(circuits.find(c => c.name === 'Audible Alarm').id, 0x20)
  assert.strictEqual(table.records.filter(r => r.kind === 'logic').length, 14)
  // Output Interfaces: DCn = channel n-1; module = dipswitch read LSB-first.
  const dip = s => [...s].reduce((a, c, i) => a | (c === '1' ? 1 << i : 0), 0)
  const byName = {}
  for (const c of circuits) byName[c.name] = byName[c.name] || c
  for (const [d, name, dc] of [['10000000', 'Pump Deckwash', 1], ['01001000', 'Audible Alarm', 5],
    ['00111100', 'Winch Stbd', 5], ['10000100', 'Lithium - Switch Over To', 6], ['01000110', 'Cockpit USB', 3]]) {
    assert(byName[name].outputs.some(o => o.module === dip(d) && o.channel === dc - 1), `${name}`)
  }
}

// --- SugarShack: the four live-captured Mode IDs.
{
  const modes = Object.fromEntries(parseModes(load('SugarShack-20260927-01.zcf')).map(m => [m.name, m.id]))
  assert.deepStrictEqual(modes, { Anchored: 0x4E, 'Day Crusing': 0x53, 'Night Cruising': 0x4D, Sleep: 0x56 })
}

// --- Every fixture: the table must walk exactly (count and byte length).
for (const file of fs.readdirSync(fixtures).filter(f => f.endsWith('.zcf'))) {
  const table = parseCircuitTable(load(file))
  assert(table, `${file}: circuit table not found`)
  assert.strictEqual(table.records.length, table.recordCount)
  assert(table.records.every(r => Number.isInteger(r.id) && r.name.length > 0))
}

console.log('ZCF structural circuit table tests passed')
