'use strict'

// Third-party switches driven from CZone.
//
// A CZone circuit (normally a virtual circuit added in the CZone configuration
// for the purpose, with no output of its own) is linked to a switch that is not
// on the CZone network: a Victron switchable output (a Shelly added to the GX,
// a GX relay, ...) or a Shelly reached directly on the network.
//
//   CZone circuit changes (display, keypad, webapp)  -> the switch follows
//   the switch changes (Victron pane, VRM, its app)  -> the CZone circuit follows
//
// The CZone side needs nothing new: a virtual circuit is held by a CZone module
// like any other circuit (on the bench, the Output Interface reports it as
// channel 6 in its status message), and the plugin already reads that state and
// can send it. Only the switch side differs, in a driver:
//
//   driver.read(entry)  -> Promise<true|false>
//   driver.write(entry, on) -> Promise
//
// Rules, so the two sides never fight:
//   - a side is only acted on when it changes, and only if the other side
//     differs;
//   - our own change coming back is recognised and not passed on again;
//   - at start (or when a side is first seen) the switch is taken as the truth
//     and the CZone circuit is set to match it;
//   - a change one side could not take (switch unreachable or refusing,
//     NMEA 2000 sending off or not ready yet) is kept and retried every
//     RETRY_MS until it is taken or that side is changed some other way.
//
// Self-contained (no CZone or Signal K code here) so it can move to another
// plugin as it is: give it readCircuit/writeCircuit and the drivers.

const POLL_MS = 2000
const SETTLE_MS = 6000
const RETRY_MS = 15000

function createBridge ({
  log = () => {},
  readCircuit = () => undefined, // name -> true | false | undefined (not known yet)
  writeCircuit = () => { throw new Error('No CZone writer') }, // (name, on)
  drivers = {},
  now = () => Date.now(),
  pollMs = POLL_MS,
  settleMs = SETTLE_MS,
  retryMs = RETRY_MS
} = {}) {
  let links = []
  let timer = null
  let polling = false

  function describe (entry) {
    const d = drivers[entry.target]
    return d && typeof d.describe === 'function' ? d.describe(entry) : `${entry.target}`
  }

  function start (entries = []) {
    stop()
    links = entries
      .filter(e => e && e.circuit && drivers[e.target])
      .map(entry => ({ entry, driver: drivers[entry.target], cz: undefined, dev: undefined, want: undefined, wantCz: undefined, retryAt: 0, pending: null, error: null, last: null, at: null }))
    if (!links.length) return
    log(`Bridge: ${links.map(l => `"${l.entry.circuit}" <-> ${describe(l.entry)}`).join('; ')}`)
    timer = setInterval(() => { poll().catch(() => {}) }, pollMs)
    if (timer.unref) timer.unref()
    poll().catch(() => {})
  }

  function stop () {
    if (timer) clearInterval(timer)
    timer = null
    links = []
  }

  function note (link, text) {
    link.last = text
    link.at = now()
    log(`Bridge "${link.entry.circuit}": ${text}`)
  }

  async function toDevice (link, on, why) {
    link.pending = { side: 'device', value: on, until: now() + settleMs }
    note(link, `${why}: switching ${describe(link.entry)} ${on ? 'ON' : 'OFF'}`)
    try {
      await link.driver.write(link.entry, on)
      link.error = null
    } catch (err) {
      link.pending = null
      link.retryAt = now() + retryMs // link.want is kept: tried again later
      link.error = `Could not switch ${describe(link.entry)}: ${err.message}`
      log(`Bridge "${link.entry.circuit}": ${link.error}`)
    }
  }

  function toCzone (link, on, why) {
    link.pending = { side: 'czone', value: on, until: now() + settleMs }
    note(link, `${why}: switching CZone circuit ${on ? 'ON' : 'OFF'}`)
    try {
      writeCircuit(link.entry.circuit, on)
      link.error = null
    } catch (err) {
      link.pending = null
      link.wantCz = on
      link.retryAt = now() + retryMs
      link.error = `Could not switch the CZone circuit: ${err.message}`
      log(`Bridge "${link.entry.circuit}": ${link.error}`)
    }
  }

  function seeCircuit (link, on) {
    if (on !== true && on !== false) return
    const before = link.cz
    link.cz = on
    if (before === undefined) {
      if (link.dev !== undefined && link.dev !== on) toCzone(link, link.dev, 'Out of step at start (the switch is taken as right)')
      return
    }
    if (before === on) return
    if (link.pending && link.pending.side === 'czone' && link.pending.value === on) { link.pending = null; link.wantCz = undefined; return } // our own change
    link.wantCz = undefined
    link.want = on
    link.retryAt = 0
    if (link.dev === on) link.want = undefined
    else if (link.dev !== undefined) toDevice(link, on, 'CZone circuit switched')
    // switch not seen yet: taken when it is (see poll)
  }

  function seeDevice (link, on) {
    if (on !== true && on !== false) return
    const before = link.dev
    link.dev = on
    if (before === undefined) {
      if (link.want === undefined && link.cz !== undefined && link.cz !== on) toCzone(link, on, 'Out of step at start (the switch is taken as right)')
      return
    }
    if (before === on) return
    if (link.pending && link.pending.side === 'device' && link.pending.value === on) { link.pending = null; link.want = undefined; return } // our own change
    link.want = undefined
    if (link.cz !== undefined && link.cz !== on) toCzone(link, on, 'Switch changed elsewhere')
  }

  // From the plugin's CZone state decoding: called as each status arrives, so
  // a display press reaches the switch without waiting for the next poll.
  function onCircuit (name, on) {
    for (const link of links) if (link.entry.circuit === name) seeCircuit(link, on)
  }

  async function poll () {
    if (polling) return
    polling = true
    try {
      for (const link of links) {
        if (link.pending && now() > link.pending.until) {
          note(link, `No confirmation from the ${link.pending.side === 'czone' ? 'CZone circuit' : 'switch'}`)
          link.pending = null
          link.retryAt = now() + retryMs // anything still wanted waits its turn
        }
        seeCircuit(link, readCircuit(link.entry.circuit))
        // A switch change the CZone circuit has not taken yet.
        if (link.wantCz !== undefined && !link.pending) {
          if (link.cz === link.wantCz) link.wantCz = undefined
          else if (now() >= link.retryAt) toCzone(link, link.wantCz, 'Switch changed (trying the CZone circuit again)')
        }
        try {
          const on = await link.driver.read(link.entry)
          if (link.error && /^Not reachable/.test(link.error)) link.error = null
          seeDevice(link, on)
          // A CZone change the switch has not taken yet.
          if (link.want !== undefined && !link.pending) {
            if (link.dev === link.want) link.want = undefined
            else if (now() >= link.retryAt) await toDevice(link, link.want, 'CZone circuit switched (trying again)')
          }
        } catch (err) {
          if (!link.error || /^Not reachable/.test(link.error)) link.error = `Not reachable: ${err.message}`
        }
      }
    } finally {
      polling = false
    }
  }

  function status () {
    return links.map(l => ({
      circuit: l.entry.circuit,
      target: describe(l.entry),
      czone: l.cz === undefined ? null : l.cz,
      device: l.dev === undefined ? null : l.dev,
      inStep: l.cz !== undefined && l.dev !== undefined ? l.cz === l.dev : null,
      pending: l.pending ? { side: l.pending.side, value: l.pending.value } : null,
      error: l.error,
      last: l.last,
      at: l.at
    }))
  }

  const circuits = () => new Set(links.map(l => l.entry.circuit))

  return { start, stop, onCircuit, poll, status, circuits }
}

// Saved settings -> bridge entries. Bad or incomplete rows are dropped.
//   { circuit, target: 'victron', output: '<service>#<id>' }
//   { circuit, target: 'shelly', host: '192.168.1.204', channel: 0 }
function bridgeEntries (list) {
  const out = []
  for (const row of Array.isArray(list) ? list : []) {
    if (!row || typeof row.circuit !== 'string' || !row.circuit.trim()) continue
    const circuit = row.circuit.trim()
    if (row.target === 'victron' && typeof row.output === 'string' && /^com\.victronenergy\.[\w.]+#[\w-]+$/.test(row.output)) {
      const [service, id] = row.output.split('#')
      out.push({ circuit, target: 'victron', service, output: id, label: row.label || '' })
    } else if (row.target === 'shelly' && typeof row.host === 'string' && /^[\w.-]+(:\d{1,5})?$/.test(row.host.trim())) {
      const channel = Number.isInteger(Number(row.channel)) && Number(row.channel) >= 0 ? Number(row.channel) : 0
      out.push({ circuit, target: 'shelly', host: row.host.trim(), channel, label: row.label || '' })
    }
  }
  return out
}

module.exports = { createBridge, bridgeEntries, POLL_MS, SETTLE_MS, RETRY_MS }
