'use strict'

// Per-circuit current from the CZone output tables on the bus.
//
// PGN 130822 (DC modules) and 130817 (AC / Output Interface) are 28-byte fast
// packets: 27 99 <hdr> <hdr> then 8 slots of [current][level u16 LE].
//   130822: byte 2 = module dipswitch, byte 3 = page
//   130817: byte 2 = page, byte 3 = module dipswitch
// Slot n on page p is output channel p*8+n, numbered as in the ZCF circuit
// table (COI DC5-16 = 0-11, DC1-4 = 12-15; OI DCn = n-1).
// Current byte is 0.1 A. An output whose level word is OFF (0x0400) reads 0 A:
// the bench Output Interface reports a constant 1 (0.1 A) floor on every
// output, on or off (1 Oct 2026 capture), so the byte alone can't be trusted
// when the output is off. Verified on SugarShack (27 Sep 2026 log): every off
// channel reads 0, on channels read plausible loads (Starlink 3.1 A, router
// 1.4 A, AIS 0.3 A), and the value tracks the load between packets.
//
// PGN 130825 (Control X PLUS) carries the same table packed tighter: a 27-byte
// fast packet, 27 99 <module> <page> <00>, then 8 records of 22 bits each,
// least significant bit first: 11 bits of current (0.1 A) and 11 bits of level
// (0 = off, 1000 = fully on). Record n on page p is output channel p*8+n.
// These modules do not send 130822/130817 at all. Worked out on Compass Rose
// (3 Oct 2026, no CZone display on the network): "Lights" (module 2, channel 4)
// switched on and off moved exactly that record between level 0 / 0 A and
// level 1000 / 0.4-0.5 A, and every record with level 1000 matched a bit set in
// the module's PGN 65284 state bitmap (Freezer 3.0-3.1 A, water pump 0 A, …).
// As with the other tables, a record whose level is off reads 0 A.

const { createFastPacketReassembler } = require('./fastpacket')

const CURRENT_PGNS = new Set([130822, 130817, 130825])
const STALE_MS = 60e3

// `width` bits starting at bit `start` of the buffer, least significant first.
function bits (buf, start, width) {
  let v = 0
  for (let i = 0; i < width; i++) {
    const b = start + i
    if ((buf[b >> 3] >> (b & 7)) & 1) v |= 1 << i
  }
  return v
}

function decodePackedTable (payload) {
  if (payload.length < 27) return null
  const page = payload[3]
  const slots = []
  for (let i = 0; i < 8; i++) {
    const start = 40 + i * 22
    const raw = bits(payload, start, 11)
    const level = bits(payload, start + 11, 11)
    const off = level === 0
    slots.push({ channel: page * 8 + i, amps: off ? 0 : raw / 10, level, off })
  }
  return { module: payload[2], page, slots }
}

function decodeCurrentPacket (pgn, payload) {
  if (!CURRENT_PGNS.has(pgn) || !payload) return null
  // 27 99 = BEP/CZone. Navico equipment uses PGN 130822 too, with 13 99.
  if (payload[0] !== 0x27 || payload[1] !== 0x99) return null
  if (pgn === 130825) return decodePackedTable(payload)
  if (payload.length < 28) return null
  const module = pgn === 130822 ? payload[2] : payload[3]
  const page = pgn === 130822 ? payload[3] : payload[2]
  const slots = []
  for (let i = 0; i < 8; i++) {
    const o = 4 + i * 3
    const level = payload[o + 1] | (payload[o + 2] << 8)
    const off = level === 0x0400 || level === 0
    slots.push({ channel: page * 8 + i, amps: off ? 0 : payload[o] / 10, level, off })
  }
  return { module, page, slots }
}

const createTableReassembler = (onPacket, options) => createFastPacketReassembler(CURRENT_PGNS, onPacket, options)

// circuits: [{ id, name, path, outputs: [{ module, channel }] }]
function createCircuitCurrents (circuits) {
  const channels = new Map() // "module:channel" -> { amps, at }
  const byChannel = new Map() // "module:channel" -> [circuit]
  for (const c of circuits) {
    for (const o of c.outputs) {
      const key = `${o.module}:${o.channel}`
      if (!byChannel.has(key)) byChannel.set(key, [])
      byChannel.get(key).push(c)
    }
  }

  function circuitAmps (c, now = Date.now()) {
    let sum = 0
    let seen = false
    for (const key of new Set(c.outputs.map(o => `${o.module}:${o.channel}`))) {
      const ch = channels.get(key)
      if (!ch || now - ch.at > STALE_MS) continue
      sum += ch.amps
      seen = true
    }
    return seen ? Math.round(sum * 10) / 10 : undefined
  }

  // Returns the circuits touched by this packet with their new current.
  function accept (pgn, payload, now = Date.now()) {
    const packet = decodeCurrentPacket(pgn, payload)
    if (!packet) return []
    const touched = new Set()
    for (const s of packet.slots) {
      const key = `${packet.module}:${s.channel}`
      channels.set(key, { amps: s.amps, at: now })
      for (const c of byChannel.get(key) || []) touched.add(c)
    }
    return [...touched].map(c => ({ circuit: c, amps: circuitAmps(c, now) }))
  }

  return { accept, circuitAmps, size: () => channels.size }
}

module.exports = { decodeCurrentPacket, createCircuitCurrents, createTableReassembler, CURRENT_PGNS }
