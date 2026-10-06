'use strict'

// Switch input state, from the CZone module status message.
//
// PGN 65284 (0xFF04), one frame about every two seconds from each module:
//
//   27 99 <module dipswitch> <module kind> <state bitmap, 32 bits, low byte first>
//
// For an output module the bitmap is its circuits (the host plugin decodes
// that). For a module with switch inputs it carries the inputs, and where each
// input sits depends on the kind of module.
//
// Signal Interface (kind 0x0D). Worked out on the test bench, 6 Oct 2026:
// module 2 with five switches to negative on inputs 1-5 (0-4 in the ZCF).
// Closing them one after another, leaving each closed, gave
//
//   none  00 00     1  02 00     2  0A 00     3  2A 00     4  AA 00     5  AA 02
//
// so input n (counted from 0) is bit 2n+1. The same module sends the same
// bitmap in PGN 65308, and each closure also sent a switch command for the
// light it controls with index 1, 3, 5, 7, 9: the same numbers.
// The bit follows the switch, not the circuit it drives: on 1 Oct 2026 Light 1
// was on (switched from the webapp, module 1 bitmap 01) for twelve seconds
// while this module's bitmap stayed 00 00.
// The message is also sent when an input changes, not only every two seconds:
// two quick taps and one three-second hold on a momentary switch (input 4)
// each gave 80 00 and then 00 00, so a short press is not missed.
// Each input has a second bit (2n) that was never seen set. The bench
// switches are double throw with both directions on the one input, so it is
// not a direction; what it is for is not known.
//
// Other kinds (Control X PLUS is 0x36) are not known yet; their inputs stay
// "not decoded" until a capture shows where they sit.

const STATUS_PGN = 65284

// kind -> bit of input n (n counted from 0, as in the ZCF)
const INPUT_BIT = {
  0x0d: input => 2 * input + 1
}

// data: the 8 bytes of a PGN 65284 frame -> { module, kind, bitmap } or null
function decodeModuleStatus (data) {
  if (!data || data.length !== 8 || data[0] !== 0x27 || data[1] !== 0x99) return null
  return { module: data[2], kind: data[3], bitmap: data.readUInt32LE(4) }
}

const knowsKind = kind => typeof INPUT_BIT[kind] === 'function'

// true / false, or undefined when this kind of module is not known or the
// input is outside the bitmap.
function inputState (kind, bitmap, input) {
  if (!knowsKind(kind) || !Number.isInteger(input) || input < 0) return undefined
  const bit = INPUT_BIT[kind](input)
  if (bit > 31) return undefined
  return ((bitmap >>> bit) & 1) === 1
}

module.exports = { STATUS_PGN, decodeModuleStatus, inputState, knowsKind }
