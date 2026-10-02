'use strict'

// Interim, until the ZCF parser handles it: some configurations (Compass Rose,
// Persevere) have no status table, so no circuit gets a statusModule/statusBit
// and PGN 65284 state is never decoded. Every circuit then reads OFF and the
// webapp can only ever send ON.
//
// On those networks the 65284 bitmap is simply the module's output channels:
// bit n = channel n. Proven on Compass Rose (3 Oct 2026): "Lights" is module 2
// channel 4, and switching it off at the display cleared bit 4 of module 02's
// bitmap (27 99 02 36 33 0E 01 00 -> 27 99 02 36 23 0E 01 00).
//
// Only applied when the ZCF gave no circuit a status mapping at all, so
// configurations with a status table (TestBench load masks, SugarShack, …)
// are untouched.
function applyStatusFallback (mapping) {
  if (!mapping || !Array.isArray(mapping.circuits)) return 0
  if (mapping.circuits.some(c => Number.isInteger(c.statusModule))) return 0
  let applied = 0
  for (const c of mapping.circuits) {
    if (!Number.isInteger(c.module) || !Number.isInteger(c.channel) || c.channel < 0 || c.channel > 31) continue
    c.statusModule = c.module
    c.statusBit = c.channel
    c.statusMask = (1 << c.channel) >>> 0
    c.statusFormat = 'module-channel'
    c.statusConfidence = 'inferred-no-status-table'
    applied++
  }
  return applied
}

module.exports = { applyStatusFallback }
