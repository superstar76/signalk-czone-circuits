'use strict'

// Minimal Victron "VeDbus" service on dbus-native, modelled on velib_python's
// vedbus.py, which every Venus OS driver uses:
//
//   - one D-Bus service name (e.g. com.victronenergy.switch.czone)
//   - every value is an object path implementing com.victronenergy.BusItem
//     (GetValue / SetValue / GetText), and emits PropertiesChanged(a{sv})
//   - the root "/" also implements GetItems (all paths) and GetValue (dict),
//     and emits ItemsChanged(a{sa{sv}}) for batched updates (used by gui-v2)
//
// Values are dbus-native variants: ['i', 1], ['d', 1.5], ['s', 'x'].
// An invalid value is the empty int array ['ai', []], as in vedbus.py.

const IFACE = 'com.victronenergy.BusItem'

const BUSITEM = {
  name: IFACE,
  methods: {
    GetValue: ['', 'v', [], ['value']],
    SetValue: ['v', 'i', ['value'], ['result']],
    GetText: ['', 's', [], ['text']]
  },
  signals: { PropertiesChanged: ['a{sv}', ['changes']] }
}

const ROOT = {
  name: IFACE,
  methods: {
    GetItems: ['', 'a{sa{sv}}', [], ['items']],
    GetValue: ['', 'v', [], ['value']],
    SetValue: ['v', 'i', ['value'], ['result']],
    GetText: ['', 's', [], ['text']]
  },
  signals: { ItemsChanged: ['a{sa{sv}}', ['changes']] }
}

const INVALID = ['ai', []]

function variant (type, value) {
  if (value === null || value === undefined) return INVALID
  if (type === 'i') return Number.isFinite(value) ? ['i', Math.round(value)] : INVALID
  if (type === 'd') return Number.isFinite(value) ? ['d', value] : INVALID
  if (type === 's') return ['s', String(value)]
  if (type === 'ai') return ['ai', value.map(v => Math.round(v))]
  return INVALID
}

// dbus-native hands a received variant over as [[signature], [value]].
function unwrapVariant (v) {
  if (Array.isArray(v) && v.length === 2 && Array.isArray(v[1])) {
    const sig = v[0] && v[0][0] && v[0][0].type
    if (sig === 'a') return v[1][0] // array value (e.g. LightControls)
    return v[1][0]
  }
  return v
}

// items: { '/Path': { type: 'i'|'d'|'s'|'ai', value, text?, onSet?(value) -> boolean } }
function createVeService ({ bus, name, log = () => {} }) {
  const items = new Map()
  let started = false
  let pending = new Map() // batched ItemsChanged
  let flushTimer = null

  const textOf = (path, it) => (typeof it.text === 'function' ? it.text(it.value) : it.text) ?? (it.value == null ? '' : String(it.value))
  const entry = (path, it) => [path, [['Value', variant(it.type, it.value)], ['Text', ['s', textOf(path, it)]]]]

  function exportPath (path, it) {
    const obj = {
      GetValue: () => variant(it.type, it.value),
      GetText: () => textOf(path, it),
      SetValue: v => {
        const value = unwrapVariant(v)
        if (typeof it.onSet !== 'function') return 1
        try { return it.onSet(value) === false ? 1 : 0 } catch (err) { log(`SetValue ${path}: ${err.message}`); return 1 }
      }
    }
    bus.exportInterface(obj, path, BUSITEM)
  }

  function exportRoot () {
    bus.exportInterface({
      GetItems: () => [...items].map(([p, it]) => entry(p, it)),
      GetValue: () => ['a{sv}', [...items].map(([p, it]) => [p.slice(1), variant(it.type, it.value)])],
      GetText: () => '',
      SetValue: () => 1
    }, '/', ROOT)
  }

  function flush () {
    flushTimer = null
    if (!pending.size) return
    const changes = [...pending].map(([p, it]) => entry(p, it))
    pending = new Map()
    try { bus.sendSignal('/', IFACE, 'ItemsChanged', 'a{sa{sv}}', [changes]) } catch (err) { log(`ItemsChanged: ${err.message}`) }
  }

  function add (path, def) {
    const it = { ...def }
    items.set(path, it)
    if (started) { exportPath(path, it); pending.set(path, it); scheduleFlush() }
    return it
  }

  function scheduleFlush () {
    if (!flushTimer) flushTimer = setTimeout(flush, 50)
  }

  // Update a value; emits PropertiesChanged on the path and a batched
  // ItemsChanged on the root. No-op if unchanged.
  function set (path, value) {
    const it = items.get(path)
    if (!it) return
    const same = Array.isArray(value) ? JSON.stringify(value) === JSON.stringify(it.value) : it.value === value
    if (same) return
    it.value = value
    if (!started) return
    try {
      bus.sendSignal(path, IFACE, 'PropertiesChanged', 'a{sv}', [[['Value', variant(it.type, it.value)], ['Text', ['s', textOf(path, it)]]]])
    } catch (err) { log(`PropertiesChanged ${path}: ${err.message}`) }
    pending.set(path, it)
    scheduleFlush()
  }

  function get (path) { const it = items.get(path); return it ? it.value : undefined }

  function start () {
    return new Promise((resolve, reject) => {
      exportRoot()
      for (const [p, it] of items) exportPath(p, it)
      started = true
      bus.requestName(name, 0x4, (err, code) => { // DBUS_NAME_FLAG_DO_NOT_QUEUE
        if (err) return reject(new Error(`requestName ${name}: ${err.message || err}`))
        if (code !== 1 && code !== 4) return reject(new Error(`requestName ${name}: code ${code} (name in use?)`))
        resolve()
      })
    })
  }

  function stop () {
    clearTimeout(flushTimer)
    try { bus.releaseName && bus.releaseName(name, () => {}) } catch (_) {}
  }

  return { add, set, get, start, stop, items }
}

module.exports = { createVeService, variant, unwrapVariant, INVALID }
