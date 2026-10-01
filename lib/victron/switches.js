'use strict'

// CZone circuits in the Venus OS switch pane (Venus OS 3.60+).
//
// Registers com.victronenergy.switch.czone_circuits on the GX's system D-Bus
// with one /SwitchableOutput/<slug>/… channel per ZCF circuit, following
// Victron's switch API (github.com/victronenergy/venus/wiki/dbus#switch):
//   State (0/1), Status (0x00 off / 0x09 on), Name, Dimming (0-100, dimmers),
//   Current (A, from the CZone output tables), Settings/Type, ValidTypes,
//   Group (one card per CZone category), CustomName, ShowUIControl.
//
// Pane -> CZone: writes to State / Dimming are passed to this plugin's own
// Signal K PUT handlers (electrical.czone.<slug>.switch.state / .brightness),
// so the same safety interlock (Enable NMEA 2000 sending) applies.
// CZone -> pane: the plugin's Signal K deltas for those paths update State,
// Status and Dimming, so circuits switched from a display or wall switch
// follow in the pane.
//
// Settings changed in the pane (name, group, type, visibility) are kept in
// victron-switches.json in the plugin's data directory.

const fs = require('fs')
const path = require('path')
const { createVeService } = require('./vedbus')

const SERVICE = 'com.victronenergy.switch.czone_circuits'
const SETTINGS_ID = 'czone_circuits'
const TYPE = { momentary: 0, toggle: 1, dimmable: 2 }
const STATUS_ON = 0x09
const STATUS_OFF = 0x00

const clip32 = s => {
  let out = String(s || '')
  while (Buffer.byteLength(out, 'utf8') > 32) out = out.slice(0, -1)
  return out
}

const stripAmps = s => s.replace(/\s*·\s*[\d.]+\s*A$/, '')

function groupFor (circuit) {
  const sub = (circuit.subCategories || []).find(Boolean)
  return clip32(sub || circuit.masterCategory || 'CZone')
}

function channelId (circuit) {
  // D-Bus object path elements: [A-Za-z0-9_]
  return String(circuit.slug || circuit.name).replace(/[^A-Za-z0-9_]/g, '_') || `c${circuit.zcfCircuitId}`
}

function createVictronSwitches (app, { log = () => {}, getCurrent = () => null, controls = () => null, version = '0' } = {}) {
  let bus = null
  let svc = null
  let unsub = null
  let currentTimer = null
  let status = { enabled: false, running: false, error: null, channels: 0, deviceInstance: null }
  let channels = new Map() // slug -> { id, circuit }
  let store = { outputs: {} }
  let storeFile = null
  let showCurrent = true // amps in the switch label while on (gui-v2 does not display /Current yet)
  const recent = [] // last switch-pane requests, for /victron/status
  const note = entry => { entry.at = new Date().toISOString(); recent.unshift(entry); recent.length = Math.min(recent.length, 10) }

  function loadStore () {
    try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')) } catch (_) { store = { outputs: {} } }
    if (!store.outputs) store.outputs = {}
  }
  function saveStore () {
    try { fs.writeFileSync(storeFile, JSON.stringify(store, null, 2)) } catch (err) { log(`victron-switches.json: ${err.message}`) }
  }
  function remember (id, key, value) {
    store.outputs[id] = { ...(store.outputs[id] || {}), [key]: value }
    saveStore()
  }

  // Switch a circuit with the same functions the webapp's ON/OFF and slider
  // use (direct, synchronous, errors reported). Signal K PUT is the fallback
  // when the host plugin didn't hand its controls over.
  function command (kind, slug, value) {
    const c = controls()
    if (c && typeof c[kind] === 'function') {
      const rec = { circuit: slug, [kind]: value, via: 'plugin' }
      note(rec)
      try { c[kind](slug, value); rec.result = 'sent'; return true } catch (err) { rec.result = `refused: ${err.message}`; log(`${slug} ${kind}: ${err.message}`); return false }
    }
    return put(`electrical.czone.${slug}.switch.${kind === 'state' ? 'state' : 'brightness'}`, value)
  }

  function put (skPath, value) {
    const rec = { path: skPath, value, result: 'sent', via: 'signalk-put' }
    note(rec)
    if (typeof app.putSelfPath !== 'function') { rec.result = 'app.putSelfPath unavailable'; log(rec.result); return false }
    try {
      const r = app.putSelfPath(skPath, value, reply => {
        rec.reply = reply && { state: reply.state, statusCode: reply.statusCode, message: reply.message }
        if (reply && reply.statusCode >= 300) log(`PUT ${skPath}=${value}: ${reply.statusCode} ${reply.message || ''}`)
      })
      if (r && typeof r.then === 'function') {
        r.then(reply => { if (reply && !rec.reply) rec.reply = { state: reply.state, statusCode: reply.statusCode, message: reply.message } })
          .catch(err => { rec.result = `error: ${err.message || err}` })
      } else if (r && typeof r === 'object' && !rec.reply) {
        rec.reply = { state: r.state, statusCode: r.statusCode, message: r.message }
      }
      return true
    } catch (err) { rec.result = `error: ${err.message}`; log(`PUT ${skPath}: ${err.message}`); return false }
  }

  function invokeSettings (msg) {
    return new Promise((resolve, reject) => bus.invoke({ destination: 'com.victronenergy.settings', ...msg }, (err, res) => err ? reject(new Error(Array.isArray(err) ? err.join(' ') : String(err.message || err))) : resolve(res)))
  }

  // Reserve a VRM device instance the Venus way (localsettings ClassAndVrmInstance).
  async function deviceInstance () {
    const p = `/Settings/Devices/${SETTINGS_ID}/ClassAndVrmInstance`
    try {
      await invokeSettings({ path: '/Settings', interface: 'com.victronenergy.Settings', member: 'AddSetting', signature: 'ssvsvv', body: [`Devices/${SETTINGS_ID}`, 'ClassAndVrmInstance', ['s', 'switch:100'], 's', ['i', 0], ['i', 0]] })
      const v = await invokeSettings({ path: p, interface: 'com.victronenergy.BusItem', member: 'GetValue' })
      const text = Array.isArray(v) ? v[1] && v[1][0] : v
      const m = /:(\d+)$/.exec(String(text))
      return m ? Number(m[1]) : 100
    } catch (err) {
      log(`Device instance from localsettings failed (${err.message}); using 100`)
      return 100
    }
  }

  function addChannel (circuit) {
    const id = channelId(circuit)
    const base = `/SwitchableOutput/${id}`
    const dimmer = !!(circuit.capabilities && circuit.capabilities.dimmer)
    const saved = store.outputs[id] || {}
    const validTypes = dimmer ? (1 << TYPE.dimmable) | (1 << TYPE.toggle) : (1 << TYPE.toggle) | (1 << TYPE.momentary)
    const type = Number.isInteger(saved.type) && (validTypes & (1 << saved.type)) ? saved.type : (dimmer ? TYPE.dimmable : TYPE.toggle)

    svc.add(`${base}/Name`, { type: 's', value: clip32(circuit.name) })
    svc.add(`${base}/State`, {
      type: 'i',
      value: 0,
      text: v => (v ? 'On' : 'Off'),
      onSet: v => {
        note({ dbus: `${base}/State`, raw: JSON.stringify(v) })
        const on = Number(v) ? 1 : 0
        if (!command('state', circuit.slug, on === 1)) return false
        svc.set(`${base}/State`, on) // optimistic; CZone feedback confirms
        return true
      }
    })
    svc.add(`${base}/Status`, { type: 'i', value: STATUS_OFF, text: v => (v & 0x01 ? 'On' : 'Off') })
    if (dimmer) {
      svc.add(`${base}/Dimming`, {
        type: 'd',
        value: null,
        text: v => (v == null ? '' : `${Math.round(v)}%`),
        onSet: v => {
          const pct = Math.max(0, Math.min(100, Number(v)))
          if (!Number.isFinite(pct) || !command('brightness', circuit.slug, pct / 100)) return false
          svc.set(`${base}/Dimming`, pct)
          return true
        }
      })
    }
    svc.add(`${base}/Current`, { type: 'd', value: null, text: v => (v == null ? '' : `${v.toFixed(1)}A`) })
    svc.add(`${base}/Settings/Type`, {
      type: 'i',
      value: type,
      onSet: v => {
        const t = Number(v)
        if (!(validTypes & (1 << t))) return false
        svc.set(`${base}/Settings/Type`, t); remember(id, 'type', t); return true
      }
    })
    svc.add(`${base}/Settings/ValidTypes`, { type: 'i', value: validTypes })
    svc.add(`${base}/Settings/Group`, {
      type: 's',
      value: saved.Group !== undefined ? saved.Group : groupFor(circuit),
      onSet: v => { const s = clip32(v); svc.set(`${base}/Settings/Group`, s); remember(id, 'Group', s); return true }
    })
    // The label is the user's name (default: circuit name) plus the circuit
    // current while it is on. A rename from the GUI keeps the name only.
    svc.add(`${base}/Settings/CustomName`, {
      type: 's',
      value: clip32(saved.CustomName || circuit.name),
      onSet: v => {
        const name = stripAmps(String(v || '')).trim() || circuit.name
        const ch = channels.get(circuit.slug)
        if (ch) ch.label = name
        remember(id, 'CustomName', clip32(name))
        if (ch) refreshLabel(ch); else svc.set(`${base}/Settings/CustomName`, clip32(name))
        return true
      }
    })
    svc.add(`${base}/Settings/ShowUIControl`, {
      type: 'i',
      value: Number.isInteger(saved.ShowUIControl) ? saved.ShowUIControl : 1,
      onSet: v => { const n = Number(v) | 0; svc.set(`${base}/Settings/ShowUIControl`, n); remember(id, 'ShowUIControl', n); return true }
    })
    channels.set(circuit.slug, { id, base, circuit, dimmer, label: saved.CustomName || circuit.name })
  }

  // Signal K -> pane
  function onDelta (update) {
    if (!update || typeof update.path !== 'string' || !update.path.startsWith('electrical.czone.')) return
    const m = /^electrical\.czone\.([^.]+)\.switch\.(state|brightness)$/.exec(update.path)
    if (!m) return
    const ch = channels.get(m[1])
    if (!ch) return
    const v = update.value && typeof update.value === 'object' && 'value' in update.value ? update.value.value : update.value
    if (m[2] === 'state') {
      const on = v === true || v === 1 || v === 'on' || v === 'ON'
      svc.set(`${ch.base}/State`, on ? 1 : 0)
      svc.set(`${ch.base}/Status`, on ? STATUS_ON : STATUS_OFF)
      refreshLabel(ch)
    } else if (ch.dimmer && typeof v === 'number') {
      svc.set(`${ch.base}/Dimming`, Math.round(v * 1000) / 10)
    }
  }

  function seedFromSignalK () {
    if (typeof app.getSelfPath !== 'function') return
    for (const [slug, ch] of channels) {
      for (const kind of ['state', 'brightness']) {
        let node
        try { node = app.getSelfPath(`electrical.czone.${slug}.switch.${kind}`) } catch (_) {}
        if (node !== undefined && node !== null) onDelta({ path: `electrical.czone.${slug}.switch.${kind}`, value: node })
      }
      void ch
    }
  }

  function updateCurrents () {
    for (const [slug, ch] of channels) {
      const a = getCurrent(`electrical.czone.${slug}.current`)
      svc.set(`${ch.base}/Current`, typeof a === 'number' ? a : null)
      refreshLabel(ch)
    }
  }

  function refreshLabel (ch) {
    const a = svc.get(`${ch.base}/Current`)
    const on = svc.get(`${ch.base}/State`) === 1
    const suffix = showCurrent && on && typeof a === 'number' && a > 0 ? ` · ${a.toFixed(1)} A` : ''
    let name = ch.label
    while (Buffer.byteLength(name + suffix, 'utf8') > 32 && name.length) name = name.slice(0, -1)
    svc.set(`${ch.base}/Settings/CustomName`, name.trimEnd() + suffix)
  }

  async function start (settings = {}, zcfFile = null, options = {}) {
    stop()
    status = { enabled: settings.victronSwitches === true, running: false, error: null, channels: 0, deviceInstance: null }
    showCurrent = settings.victronSwitchCurrent !== false
    if (!status.enabled) return status
    try {
      const dataDir = typeof app.getDataDirPath === 'function' ? app.getDataDirPath() : path.dirname(zcfFile || '.')
      storeFile = path.join(dataDir, 'victron-switches.json')
      loadStore()

      const zcf = require('../zcf')
      const mapping = zcf.load(zcfFile)
      const circuits = (mapping && mapping.circuits) || []
      if (!circuits.length) throw new Error('No circuits in the loaded ZCF')

      bus = options.bus || require('dbus-native').systemBus()
      svc = createVeService({ bus, name: SERVICE, log })
      const instance = await deviceInstance()
      status.deviceInstance = instance
      const vessel = mapping.vesselName || 'CZone'
      const root = {
        '/Mgmt/ProcessName': ['s', 'signalk-czone-circuits'],
        '/Mgmt/ProcessVersion': ['s', version],
        '/Mgmt/Connection': ['s', 'Signal K plugin'],
        '/DeviceInstance': ['i', instance],
        '/ProductId': ['i', 0xFFFF],
        '/ProductName': ['s', 'CZone Circuits'],
        '/CustomName': ['s', clip32(`CZone ${vessel}`)],
        '/FirmwareVersion': ['s', version],
        '/HardwareVersion': ['s', 'Signal K'],
        '/Serial': ['s', `czone-${SETTINGS_ID}`],
        '/Connected': ['i', 1],
        '/State': ['i', 0x100]
      }
      for (const [p, [type, value]] of Object.entries(root)) svc.add(p, { type, value })
      for (const c of circuits) addChannel(c)
      seedFromSignalK()
      updateCurrents()
      await svc.start()

      const sb = app.streambundle && typeof app.streambundle.getSelfBus === 'function' ? app.streambundle.getSelfBus() : null
      if (sb && typeof sb.onValue === 'function') unsub = sb.onValue(onDelta)
      currentTimer = setInterval(updateCurrents, 2000)
      status = { ...status, running: true, channels: channels.size }
      log(`Victron switch pane: ${channels.size} circuits on ${SERVICE} (device instance ${instance})`)
    } catch (err) {
      status = { ...status, running: false, error: err.message }
      log(`Victron switch pane failed: ${err.message}`)
      stop(true)
    }
    return status
  }

  function stop (keepStatus) {
    if (typeof unsub === 'function') { try { unsub() } catch (_) {} }
    unsub = null
    clearInterval(currentTimer)
    currentTimer = null
    if (svc) svc.stop()
    svc = null
    if (bus && typeof bus.connection === 'object' && bus.connection && typeof bus.connection.end === 'function') {
      try { bus.connection.end() } catch (_) {}
    }
    bus = null
    channels = new Map()
    if (!keepStatus) status = { ...status, running: false }
  }

  return { start, stop, status: () => ({ ...status, recent }), _onDelta: onDelta, _service: () => svc }
}

module.exports = { createVictronSwitches, SERVICE, groupFor, channelId }
