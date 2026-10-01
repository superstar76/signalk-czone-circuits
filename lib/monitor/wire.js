'use strict'

// Reads sensor PGNs straight off the CAN interface with candump.
//
// Signal K hands plugins the frames it receives from other devices, but not
// the frames the GX itself transmits (bench, 1 Oct 2026: Ruuvi and Victron
// temperature sensors are sent by the Cerbo at address 0x65 as PGN
// 130312/130316; CZone displays, NMEA Reader and candump all see them, the
// plugin's canboatjs:rawoutput listener received none). candump sees the wire
// exactly as a CZone display does. The kernel filter below passes only the
// sensor PGNs, so the extra load is a few frames a second.
//
// Venus OS ships candump. Elsewhere (no candump, no interface) this quietly
// does nothing and the Signal K fallback paths are used.

const { spawn } = require('child_process')

// <can_id>:<mask> on DP + PF + PS (8 hex digits = extended frame).
const FILTERS = ['01FD0800', '01FD0C00', '01FD0A00', '01F21100', '01F21400', '01F21200'].map(id => `${id}:01FFFF00`)
const LINE = /\s([0-9A-Fa-f]{8})\s+\[(\d)\]\s+((?:[0-9A-Fa-f]{2}\s*)+)$/

function parseCandumpLine (line) {
  const m = LINE.exec(String(line).trimEnd())
  if (!m) return null
  return `0 R ${m[1].toUpperCase()} ${m[3].trim()}`
}

function createWireListener ({ device = 'vecan0', onLine, log = () => {} } = {}) {
  let child = null
  let stopped = true
  let restartTimer = null
  let buffer = ''
  let state = { running: false, device, lines: 0, error: null }

  function start () {
    stopped = false
    launch()
  }

  function launch () {
    if (stopped) return
    try {
      child = spawn('candump', [`${device},${FILTERS.join(',')}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      state = { ...state, running: false, error: err.message }
      return
    }
    state = { ...state, running: false, error: null }
    child.on('spawn', () => { state.running = true })
    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = parseCandumpLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        if (raw) { state.lines++; try { onLine(raw) } catch (_) {} }
      }
    })
    child.stderr.on('data', d => { state.error = d.toString().trim().slice(0, 200) })
    child.on('error', err => {
      state = { ...state, running: false, error: err.code === 'ENOENT' ? 'candump not installed' : err.message }
      child = null
      if (err.code !== 'ENOENT') scheduleRestart()
    })
    child.on('exit', code => {
      state.running = false
      child = null
      if (!stopped && state.error !== 'candump not installed') {
        log(`candump on ${device} exited (${code}); restarting in 30 s`)
        scheduleRestart()
      }
    })
  }

  function scheduleRestart () {
    clearTimeout(restartTimer)
    if (!stopped) restartTimer = setTimeout(launch, 30e3)
  }

  function stop () {
    stopped = true
    clearTimeout(restartTimer)
    if (child) { try { child.kill() } catch (_) {} }
    child = null
    state.running = false
  }

  return { start, stop, status: () => ({ ...state }) }
}

module.exports = { createWireListener, parseCandumpLine, FILTERS }
