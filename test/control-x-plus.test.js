'use strict'

// Control X PLUS modules report output current and level in PGN 130825, not
// 130822/130817. Payloads below are from Compass Rose, 3 Oct 2026, while
// "Lights" (module 2, channel 4) was switched on and off. No CZone display was
// on the network.
const assert = require('assert')
const { decodeCurrentPacket, createCircuitCurrents, createTableReassembler, CURRENT_PGNS } = require('../lib/monitor/currents')

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex')
const HEAD = (module, page) => `27 99 0${module} 0${page} `
const M2_P0_OFF = hex(HEAD(2, 0) + '00 00 40 1F 00 D0 17 00 00 00 00 00 00 00 40 00 D0 07 00 00 00 00 00')
const M2_P0_ON = hex(HEAD(2, 0) + '00 00 40 1F 00 D0 17 00 00 00 00 00 05 40 5F 00 D0 07 00 00 00 00 00')
const M2_P1 = hex(HEAD(2, 1) + '00 00 00 00 00 D0 07 00 F4 11 00 7D 00 00 00 00 D0 07 00 00 00 00 00')
const M2_P2 = hex(HEAD(2, 2) + '00 00 40 1F 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00')
const M1_P0 = hex(HEAD(1, 0) + '00 00 00 00 00 00 F0 01 F4 01 00 7D 00 00 00 00 00 00 00 00 00 00 00')
const M1_P2 = hex(HEAD(1, 2) + '00 01 40 1F 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00')

assert(CURRENT_PGNS.has(130825))
const on = p => p.slots.filter(s => !s.off).map(s => s.channel)
const amps = p => Object.fromEntries(p.slots.filter(s => s.amps).map(s => [s.channel, s.amps]))

// --- Lights off / on: only record 4 changes; level 0 <-> 1000, 0 A <-> 0.5 A.
{
  const off = decodeCurrentPacket(130825, M2_P0_OFF)
  const lit = decodeCurrentPacket(130825, M2_P0_ON)
  assert.strictEqual(off.module, 2)
  assert.strictEqual(off.page, 0)
  assert.deepStrictEqual(on(off), [0, 1, 5])
  assert.deepStrictEqual(on(lit), [0, 1, 4, 5])
  assert.deepStrictEqual([lit.slots[4].amps, lit.slots[4].level], [0.5, 1000])
  assert.deepStrictEqual([off.slots[4].amps, off.slots[4].level], [0, 0])
  assert.deepStrictEqual(amps(lit), { 4: 0.5, 5: 0.1 })
  // Channel 2 (Fridge) is off but its raw current reads 1: off means 0 A.
  assert.strictEqual(off.slots[2].amps, 0)
}

// --- Every "on" record matches the modules' PGN 65284 state bitmaps from the
//     same morning (module 02: 0x00010E33 plus DC Outlets; module 01: 0x0001000C).
{
  assert.deepStrictEqual(on(decodeCurrentPacket(130825, M2_P1)), [9, 10, 11, 13])
  assert.deepStrictEqual(amps(decodeCurrentPacket(130825, M2_P1)), { 11: 0.4 })
  assert.deepStrictEqual(on(decodeCurrentPacket(130825, M2_P2)), [16])
  const m1 = decodeCurrentPacket(130825, M1_P0)
  assert.deepStrictEqual(on(m1), [2, 3])
  assert.deepStrictEqual(amps(m1), { 2: 3.1 }) // Freezer compressor; water pump on but idle
  const m1p2 = decodeCurrentPacket(130825, M1_P2)
  assert.deepStrictEqual(on(m1p2), [16])
  assert.deepStrictEqual(amps(m1p2), { 16: 0.1 })
}

// --- Not ours: Navico uses PGN 130822 with manufacturer bytes 13 99.
assert.strictEqual(decodeCurrentPacket(130822, hex('13 99 FF 01 00 02 04 32 00 02 83 02 00 14 9B')), null)
assert.strictEqual(decodeCurrentPacket(130825, hex('13 99 02 00 00 00 40 1F 00 D0 17 00 00 00 00 00 05 40 5F 00 D0 07 00 00 00 00 00')), null)

// --- From CAN frames to circuit current, as captured (fast packet, 4 frames).
{
  const circuits = [
    { id: 15, name: 'Lights', path: 'electrical.czone.Lights.current', outputs: [{ module: 2, channel: 4 }] },
    { id: 9, name: 'Instruments', path: 'electrical.czone.Instruments.current', outputs: [{ module: 1, channel: 0 }, { module: 2, channel: 11 }, { module: 2, channel: 9 }] }
  ]
  const currents = createCircuitCurrents(circuits)
  const seen = []
  const re = createTableReassembler(p => { for (const t of currents.accept(p.pgn, p.payload)) seen.push([t.circuit.name, t.amps]) })
  const frame = d => re.accept({ pgn: 130825, source: 2, canId: 0x1DFF0902, data: hex(d) })
  for (const d of ['A0 1B 27 99 02 00 00 00', 'A1 40 1F 00 D0 17 00 00', 'A2 00 00 00 05 40 5F 00', 'A3 D0 07 00 00 00 00 00']) frame(d)
  assert.deepStrictEqual(seen, [['Lights', 0.5]])
  for (const d of ['C0 1B 27 99 02 01 00 00', 'C1 00 00 00 D0 07 00 F4', 'C2 11 00 7D 00 00 00 00', 'C3 D0 07 00 00 00 00 00']) frame(d)
  assert.deepStrictEqual(seen[1], ['Instruments', 0.4])
  // A frame out of order drops the packet instead of producing a wrong table.
  const before = seen.length
  for (const d of ['E0 1B 27 99 02 00 00 00', 'E2 00 00 00 05 40 5F 00', 'E3 D0 07 00 00 00 00 00']) frame(d)
  assert.strictEqual(seen.length, before)
}

console.log('Control X PLUS current tests passed')
