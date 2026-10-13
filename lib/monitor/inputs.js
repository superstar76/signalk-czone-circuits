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
// COI (kind 0x1F). From Matt Mitchell's Sugar Shack capture, 6 Oct 2026: a
// COI's own status message (65284) carries its outputs only. Its switch inputs
// are in PGN 65308 (0xFF1C), sent on change:
//
//   27 99 <module dipswitch> 03 <input bitmap, 32 bits, low byte first>
//
// COI inputs are numbered from 16 in the ZCF, and input i is bit 2(i-16)+1:
// the same odd-bit pattern as the Signal Interface. Three switches on two
// modules agree: module 1A input 19 -> 80 00, 1A input 20 -> 00 02, 1C input
// 17 -> 08 00. A Signal Interface sends the same bitmap in 65308 too (with 00
// in byte 3), so both messages are read for it.
//
// Other kinds (Control X PLUS is 0x36) are not known yet; their inputs stay
// "not decoded" until a capture shows where they sit.

const STATUS_PGN = 65284
const INPUT_PGN = 65308

// kind -> where its inputs are: the messages that carry them, and the ZCF
// number of its first input (input i is bit 2(i - first) + 1).
const LAYOUT = {
  0x0d: { pgns: [STATUS_PGN, INPUT_PGN], first: 0 }, // Signal Interface
  0x1f: { pgns: [INPUT_PGN], first: 16 } // COI
}

// data: the 8 bytes of a PGN 65284 frame -> { module, kind, bitmap } or null
function decodeModuleStatus (data) {
  if (!data || data.length !== 8 || data[0] !== 0x27 || data[1] !== 0x99) return null
  return { module: data[2], kind: data[3], bitmap: data.readUInt32LE(4) }
}

// data: the 8 bytes of a PGN 65308 frame -> { module, bitmap } or null. Byte 3
// is 03 from a COI and 00 from a Signal Interface; its meaning is not known.
function decodeInputMessage (data) {
  if (!data || data.length !== 8 || data[0] !== 0x27 || data[1] !== 0x99) return null
  return { module: data[2], bitmap: data.readUInt32LE(4) }
}

// By CAN ID, not by the parsed PGN: this plugin's parser reports every
// 0xFFxx proprietary PGN as 130816+ (except 65284), so 65308 arrives as 130844.
// Here the data-page bit is checked as well: 0 for 65308.
const isInputMessage = canId => Number.isInteger(canId) && ((canId >>> 8) & 0x3ffff) === 0x0ff1c

const knowsKind = kind => Object.prototype.hasOwnProperty.call(LAYOUT, kind)

// true / false, or undefined when this kind of module is not known, this
// message does not carry its inputs, or the input is outside the bitmap.
function inputState (kind, bitmap, input, pgn = STATUS_PGN) {
  if (!knowsKind(kind) || !Number.isInteger(input)) return undefined
  const layout = LAYOUT[kind]
  if (!layout.pgns.includes(pgn)) return undefined
  const n = input - layout.first
  if (n < 0) return undefined
  const bit = 2 * n + 1
  if (bit > 31) return undefined
  return ((bitmap >>> bit) & 1) === 1
}

module.exports = { STATUS_PGN, INPUT_PGN, decodeModuleStatus, decodeInputMessage, inputState, knowsKind, isInputMessage }
