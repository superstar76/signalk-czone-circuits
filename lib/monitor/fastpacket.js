'use strict'

// NMEA 2000 fast-packet reassembly. Frame byte 0 is
// <sequence: 3 bits><frame number: 5 bits>; frame 0 also carries the length.
// A frame out of order, or a packet left unfinished for `timeoutMs`, is dropped.
function createFastPacketReassembler (pgns, onPacket, options = {}) {
  const timeoutMs = options.timeoutMs || 2000
  const open = new Map() // "pgn:source" -> packet in progress
  function accept (frame, now = Date.now()) {
    if (!frame || !pgns.has(frame.pgn) || !frame.data || frame.data.length < 2) return
    const key = `${frame.pgn}:${frame.source}`
    const seq = frame.data[0] >> 5
    const index = frame.data[0] & 0x1f
    if (index === 0) {
      const size = frame.data[1]
      if (size < 2 || size > 223) { open.delete(key); return }
      open.set(key, { seq, size, next: 1, at: now, chunks: [Buffer.from(frame.data.subarray(2))], got: frame.data.length - 2 })
    } else {
      const p = open.get(key)
      if (!p || p.seq !== seq || p.next !== index || now - p.at > timeoutMs) { open.delete(key); return }
      p.chunks.push(Buffer.from(frame.data.subarray(1)))
      p.got += frame.data.length - 1
      p.next++
    }
    const p = open.get(key)
    if (p && p.got >= p.size) {
      open.delete(key)
      onPacket({ pgn: frame.pgn, source: frame.source, canId: frame.canId, payload: Buffer.concat(p.chunks).subarray(0, p.size) })
    }
  }
  return { accept, clear: () => open.clear() }
}

module.exports = { createFastPacketReassembler }
