'use strict'

// A Victron switchable output, on the GX's D-Bus: anything Venus OS lists in
// its switch pane, whatever kind of service carries it. Tested on the bench,
// 13 Oct 2026, with a Shelly PM1 added to the Cerbo, which appears as
//
//   com.victronenergy.acload.shelly_28372F37CD6C_0
//     /CustomName                              'Power Board'
//     /SwitchableOutput/0/State                1 (on) / 0 (off), writable
//     /SwitchableOutput/0/Settings/CustomName  'Power Board'
//     /SwitchableOutput/0/Settings/Type        1 (on/off)
//
// The service name carries the device's MAC address, so it does not change
// when the output is renamed; the name is shown, the service is stored.

const OWN_SERVICE = 'com.victronenergy.switch.czone_circuits' // this plugin's own switch pane
const IFACE = 'com.victronenergy.BusItem'

function errText (err) {
  return Array.isArray(err) ? err.join(' ') : String((err && err.message) || err)
}

// dbus-native hands a variant over as [[signature], [value]].
function unwrap (v) {
  if (Array.isArray(v) && v.length === 2 && Array.isArray(v[0]) && Array.isArray(v[1])) return v[1][0]
  return v
}

function createVictronDriver ({ getBus } = {}) {
  function call (msg) {
    const bus = getBus()
    return new Promise((resolve, reject) => {
      bus.invoke(msg, (err, res) => err ? reject(new Error(errText(err))) : resolve(res))
    })
  }
  const getValue = (service, path) => call({ destination: service, path, interface: IFACE, member: 'GetValue' }).then(unwrap)

  async function read (entry) {
    const v = await getValue(entry.service, `/SwitchableOutput/${entry.output}/State`)
    if (typeof v !== 'number') throw new Error('no switchable output there')
    return v !== 0
  }

  async function write (entry, on) {
    const r = await call({ destination: entry.service, path: `/SwitchableOutput/${entry.output}/State`, interface: IFACE, member: 'SetValue', signature: 'v', body: [['i', on ? 1 : 0]] })
    if (typeof r === 'number' && r !== 0) throw new Error(`the GX refused (${r})`)
  }

  // Every switchable output on the GX, for the settings page.
  async function list () {
    const names = await call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'ListNames' })
    const services = (names || []).filter(n => /^com\.victronenergy\./.test(n) && n !== OWN_SERVICE && !/^com\.victronenergy\.(settings|system|logger|platform|modbustcp)$/.test(n))
    const out = []
    for (const service of services) {
      let ids = []
      try {
        const items = await call({ destination: service, path: '/', interface: IFACE, member: 'GetItems' })
        const paths = Array.isArray(items) ? items.map(i => i[0]) : Object.keys(items || {})
        ids = [...new Set(paths.map(p => /^\/SwitchableOutput\/([^/]+)\/State$/.exec(p)).filter(Boolean).map(m => m[1]))]
      } catch (_) {
        // No GetItems: try the usual first channels.
        for (const id of ['0', '1', '2', '3']) {
          try { if (typeof await getValue(service, `/SwitchableOutput/${id}/State`) === 'number') ids.push(id) } catch (_) {}
        }
      }
      for (const id of ids) {
        const text = async p => { try { const v = await getValue(service, p); return typeof v === 'string' && v.trim() ? v.trim() : '' } catch (_) { return '' } }
        const name = (await text(`/SwitchableOutput/${id}/Settings/CustomName`)) || (await text('/CustomName')) ||
          [await text('/ProductName'), await text(`/SwitchableOutput/${id}/Name`)].filter(Boolean).join(' ') || service
        out.push({ value: `${service}#${id}`, label: name, service, output: id })
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label))
  }

  return {
    describe: entry => (entry.label ? `${entry.label} (GX)` : `${entry.service} output ${entry.output}`),
    read,
    write,
    list
  }
}

module.exports = { createVictronDriver, OWN_SERVICE }
