'use strict'

// Per-circuit current from the CZone output tables on the bus.
//
// PGN 130822 (DC modules) and 130817 (AC / Output Interface) are 28-byte fast
// packets: 27 99 <hdr> <hdr> then 8 slots of [current][level u16 LE].
//   130822: byte 2 = module dipswitch, byte 3 = page
//   130817: byte 2 = page, byte 3 = module dipswitch
// Slot n on page p is output channel p*8+n, numbered as in the ZCF circuit
// table (COI DC5-16 = 0-11, DC1-4 = 12-15; OI DCn = n-1).
// Current byte is 0.1 A. Verified on SugarShack (27 Sep 2026 log): every off
// channel reads 0, on channels read plausible loads (Starlink 3.1 A, router
// 1.4 A, AIS 0.3 A), and the value tracks the load between packets.

const CURRENT_PGNS = new Set([130822, 130817])
const STALE_MS = 60e3

function decodeCurrentPacket (pgn, payload) {
  if (!CURRENT_PGNS.has(pgn) || !payload || payload.length < 28) return null
  if (payload[0] !== 0x27 || payload[1] !== 0x99) return null
  const module = pgn === 130822 ? payload[2] : payload[3]
  const page = pgn === 130822 ? payload[3] : payload[2]
  const slots = []
  for (let i = 0; i < 8; i++) {
    const o = 4 + i * 3
    slots.push({ channel: page * 8 + i, amps: payload[o] / 10, level: payload[o + 1] | (payload[o + 2] << 8) })
  }
  return { module, page, slots }
}

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

module.exports = { decodeCurrentPacket, createCircuitCurrents, CURRENT_PGNS }
