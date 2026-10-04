'use strict'

// [fork] Confirm before off.
//
// Some circuits must not go off by a slip of a finger: a freezer full of
// long-term stores that nobody opens for weeks, or the circuit that powers the
// display in use (turn Instruments off on the chartplotter and the
// chartplotter goes with it), the GX or the network. The plugin cannot work
// out which those are: the ZCF says which output a circuit drives, not what
// is wired to it. So the installer nominates them in the plugin configuration.
//
// A nominated circuit:
//  - turns ON from anywhere, never held up;
//  - turns OFF from the webapp (and its chartplotter view) only after an
//    "are you sure?";
//  - is not turned off by anything that cannot ask (the Victron switch pane,
//    a Signal K PUT from another app), unless the installer allows it.
// CZone's own keypads and displays are not affected: that is CZone's side.
//
// settings.confirmOff is a list of { circuit }; a plain name is accepted.

const key = s => String(s == null ? '' : s).trim().toLowerCase()

function entries (settings) {
  const list = settings && Array.isArray(settings.confirmOff) ? settings.confirmOff : []
  return list
    .map(e => (typeof e === 'string' ? { circuit: e } : e))
    .filter(e => e && key(e.circuit))
    .map(e => ({ circuit: String(e.circuit).trim() }))
}

// -> { marked: Set(circuit.name), unknown: [names that match no circuit] }
function confirmOffFor (settings, circuits) {
  const marked = new Set()
  const unknown = []
  for (const e of entries(settings)) {
    const hits = (circuits || []).filter(c => key(c.name) === key(e.circuit) || key(c.slug) === key(e.circuit))
    if (!hits.length) { unknown.push(e.circuit); continue }
    for (const c of hits) marked.add(c.name)
  }
  return { marked, unknown }
}

// The names offered in the plugin configuration: every circuit shown, plus any
// name already saved that this configuration no longer has, so that an old
// entry never stops the form from saving.
function choices (settings, circuits) {
  const names = []
  const seen = new Set()
  for (const c of circuits || []) {
    if (c.hidden) continue
    const n = String(c.name).trim()
    if (n && !seen.has(key(n))) { seen.add(key(n)); names.push({ value: n, label: n }) }
  }
  names.sort((a, b) => a.label.localeCompare(b.label))
  for (const e of entries(settings)) {
    if (!seen.has(key(e.circuit))) { seen.add(key(e.circuit)); names.push({ value: e.circuit, label: `${e.circuit} (not in this configuration)` }) }
  }
  return names
}

module.exports = { confirmOffFor, choices, entries }
