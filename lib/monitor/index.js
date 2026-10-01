'use strict'

// Monitor + trending for signalk-czone-circuits.
//
// Self-contained: the host plugin only needs to call
//   monitor.start(settings, zcfFilePath)   from plugin.start
//   monitor.stop()                         from plugin.stop
//   monitor.registerRoutes(router)         from plugin.registerWithRouter
//
// Values are read in-process from Signal K (no HTTP to localhost), sampled
// every `monitorSampleSeconds` (default 30), buffered, and appended to the SD
// card once a minute.

const fs = require('fs')
const { buildCatalog, resolveCatalog } = require('./catalog')
const { createTrendStore, RANGES } = require('./storage')
const nmea = require('../nmea2000')
const { createCircuitCurrents, CURRENT_PGNS } = require('./currents')
const { SENSOR_PGNS, decodeSensorFrame } = require('./sensors')

const PLUGIN_ID = 'signalk-czone-circuits'
const REPUBLISH_MS = 30e3

// CZone per-module status PGNs (0xFF04, 0xFF15, 0xFF16, 0xFF1C): byte 2 after
// "27 99" is the sending module's dipswitch address.
const MODULE_STATUS_PS = new Set([0x04, 0x15, 0x16, 0x1c])

function unwrap (v) {
  if (v && typeof v === 'object' && 'value' in v) return v.value
  return v
}

function createMonitor (app, options = {}) {
  const log = options.log || (msg => { if (typeof app.debug === 'function') app.debug(`[monitor] ${msg}`) })
  let catalog = { items: [], warnings: ['Not started'] }
  let store = null
  let timers = []
  let enabled = false
  let rawListener = null
  let streamUnsubscribe = null
  const moduleSource = new Map() // CZone dipswitch -> NMEA 2000 source address
  const bySource = new Map() // path -> Map($source -> value), from the live delta stream
  const own = new Map() // path -> { value, at }: values this monitor decodes itself
  let currents = createCircuitCurrents([])
  let reassembler = null
  let busIndex = new Map() // sensor key -> [Signal K path used as the reading's identity]
  // Diagnostics: what actually reaches the plugin from the bus.
  const busStats = { frames: 0, since: Date.now(), byPgn: new Map(), bySource: new Map(), sensors: new Map() }

  function publish (skPath, value) {
    const now = Date.now()
    const prev = own.get(skPath)
    const due = !prev || prev.value !== value || now - prev.published >= REPUBLISH_MS
    own.set(skPath, { value, at: now, published: due ? now : prev.published })
    if (!due) return
    if (typeof app.handleMessage !== 'function') return
    try {
      app.handleMessage(PLUGIN_ID, { updates: [{ values: [{ path: skPath, value }] }] })
    } catch (err) { log(`Publish failed for ${skPath}: ${err.message}`) }
  }

  function onCurrentPacket (packet) {
    for (const { circuit, amps } of currents.accept(packet.pgn, packet.payload)) {
      if (amps !== undefined) publish(circuit.path, amps)
    }
  }

  function cacheValue (update) {
    if (!update || typeof update.path !== 'string' || typeof update.$source !== 'string') return
    if (!bySource.has(update.path)) bySource.set(update.path, new Map())
    bySource.get(update.path).set(update.$source, unwrap(update.value))
  }

  function onRawFrame (line) {
    const frame = nmea.parseRawLine(line)
    if (!frame || !Number.isInteger(frame.canId) || !frame.data) return
    if (CURRENT_PGNS.has(frame.pgn)) { if (reassembler) reassembler.accept(frame); return }
    // Full ISO PGN including the data-page bit (lib/nmea2000 only adds it for
    // the CZone 0xFFxx range).
    const pf = (frame.canId >>> 16) & 0xff
    const isoPgn = (((frame.canId >>> 24) & 1) << 16) | (pf << 8) | (pf >= 240 ? (frame.canId >>> 8) & 0xff : 0)
    busStats.frames++
    busStats.byPgn.set(isoPgn, (busStats.byPgn.get(isoPgn) || 0) + 1)
    busStats.bySource.set(frame.source, (busStats.bySource.get(frame.source) || 0) + 1)
    if (SENSOR_PGNS.has(isoPgn)) {
      const now = Date.now()
      for (const { key, value } of decodeSensorFrame(isoPgn, frame.data)) {
        busStats.sensors.set(key, { value, source: frame.source, pgn: isoPgn, matched: busIndex.has(key), at: new Date().toISOString() })
        for (const p of busIndex.get(key) || []) own.set(p, { value, at: now, published: now, bus: true })
      }
      return
    }
    learnFromFrame(frame)
  }

  function learnModuleSource (line) {
    const frame = nmea.parseRawLine(line)
    if (frame && Number.isInteger(frame.canId) && frame.data) learnFromFrame(frame)
  }

  function learnFromFrame (frame) {
    if (frame.data.length < 3) return
    const pf = (frame.canId >>> 16) & 0xff
    const ps = (frame.canId >>> 8) & 0xff
    if (pf !== 0xff || !MODULE_STATUS_PS.has(ps)) return
    if (frame.data[0] !== 0x27 || frame.data[1] !== 0x99) return
    moduleSource.set(frame.data[2], frame.source)
  }

  // Value at a Signal K path; when sourceModule is given, only the value
  // published by that CZone module's NMEA 2000 source address.
  function getValue (skPath, sourceModule, reading = {}) {
    const mine = own.get(skPath)
    if (mine && Date.now() - mine.at < 120e3) return mine.value
    if (typeof app.getSelfPath !== 'function') return undefined
    let node
    try { node = app.getSelfPath(skPath) } catch (_) { node = undefined }
    if (sourceModule === undefined) {
      if (reading.notCzone && moduleSource.size) {
        const czone = [...new Set(moduleSource.values())].map(s => `.${s}`)
        const isCzone = source => typeof source === 'string' && czone.some(sf => source.endsWith(sf))
        const cached = bySource.get(skPath)
        if (cached) {
          for (const [source, value] of cached) if (!isCzone(source) && value !== undefined && value !== null) return value
        }
        if (node && node.values && typeof node.values === 'object') {
          for (const [source, entry] of Object.entries(node.values)) if (!isCzone(source) && entry && entry.value != null) return entry.value
        }
        if (node && isCzone(node.$source)) return undefined
      }
      if (node === undefined || node === null) return undefined
      const v = unwrap(node)
      return v === null ? undefined : v
    }
    const src = moduleSource.get(sourceModule)
    if (src === undefined) return undefined
    const suffix = `.${src}`
    const cached = bySource.get(skPath)
    if (cached) {
      for (const [source, value] of cached) {
        if (source.endsWith(suffix) && value !== undefined && value !== null) return value
      }
    }
    if (!node || typeof node !== 'object') return undefined
    if (node.values && typeof node.values === 'object') {
      for (const [key, entry] of Object.entries(node.values)) {
        if (key.endsWith(suffix) && entry && entry.value !== undefined && entry.value !== null) return entry.value
      }
    }
    if (typeof node.$source === 'string' && node.$source.endsWith(suffix) && node.value !== null) return node.value
    return undefined
  }

  // A value this monitor decoded itself (e.g. circuit current), or null.
  function valueAt (skPath) {
    const mine = own.get(skPath)
    return mine && Date.now() - mine.at < 120e3 ? mine.value : null
  }

  function resolved () {
    return resolveCatalog(catalog.items, getValue)
  }

  function trendSeries () {
    const series = new Map() // series key -> value
    for (const item of resolved()) {
      for (const r of item.readings) if (r.series && typeof r.value === 'number') series.set(r.series, r.value)
    }
    return series
  }

  function sample () {
    const now = Date.now()
    for (const [key, value] of trendSeries()) store.record(key, value, now)
  }

  // Never let a monitoring problem stop the host plugin from starting.
  function start (settings = {}, zcfFile = null) {
    try {
      startMonitor(settings, zcfFile)
    } catch (err) {
      stop()
      catalog = { items: [], warnings: [`Monitor failed to start: ${err.message}`] }
      log(`Monitor failed to start: ${err.message}`)
    }
  }

  function startMonitor (settings, zcfFile) {
    stop()
    enabled = settings.monitorEnabled !== false
    if (!enabled) { catalog = { items: [], warnings: ['Monitoring disabled'] }; return }

    let buf = null
    try { if (zcfFile && fs.existsSync(zcfFile)) buf = fs.readFileSync(zcfFile) } catch (err) { log(`ZCF read failed: ${err.message}`) }
    catalog = buildCatalog(buf)
    log(`Catalogue: ${catalog.items.length} items${catalog.warnings.length ? `; ${catalog.warnings.join('; ')}` : ''}`)

    store = createTrendStore({
      retentionDays: settings.trendRetentionDays,
      directory: settings.trendDirectory || null,
      log
    })

    currents = createCircuitCurrents(catalog.items
      .filter(i => i.group === 'Circuit current' && Array.isArray(i.outputs))
      .map(i => ({ id: i.circuitId, name: i.name, path: i.readings[0].candidates[0], outputs: i.outputs })))
    reassembler = nmea.createFastPacketReassembler(onCurrentPacket)
    busIndex = new Map()
    for (const item of catalog.items) {
      for (const r of item.readings) {
        if (!r.bus || !r.candidates[0]) continue
        if (!busIndex.has(r.bus)) busIndex.set(r.bus, [])
        busIndex.get(r.bus).push(r.candidates[0])
      }
    }
    if (typeof app.on === 'function') {
      rawListener = onRawFrame
      app.on('canboatjs:rawoutput', rawListener)
    }
    try {
      const bus = app.streambundle && typeof app.streambundle.getSelfBus === 'function' ? app.streambundle.getSelfBus() : null
      if (bus && typeof bus.onValue === 'function') streamUnsubscribe = bus.onValue(cacheValue)
    } catch (err) { log(`Delta stream unavailable: ${err.message}`) }

    const sampleMs = Math.max(5, Number(settings.monitorSampleSeconds) || 30) * 1000
    timers.push(setInterval(sample, sampleMs))
    timers.push(setInterval(() => {
      const r = store.flush()
      if (r.written) log(`Trend: wrote ${r.written} samples`)
    }, 60e3))
    timers.push(setTimeout(() => store.purge(), 15e3))
    timers.push(setInterval(() => store.purge(), 86400e3))
  }

  function stop () {
    if (rawListener && typeof app.removeListener === 'function') app.removeListener('canboatjs:rawoutput', rawListener)
    rawListener = null
    if (reassembler && typeof reassembler.clear === 'function') reassembler.clear()
    reassembler = null
    if (typeof streamUnsubscribe === 'function') { try { streamUnsubscribe() } catch (_) {} }
    streamUnsubscribe = null
    for (const t of timers) { clearInterval(t); clearTimeout(t) }
    timers = []
    if (store) { try { store.flush() } catch (_) {} }
  }

  function registerRoutes (router) {
    router.get('/monitor/items', (_req, res) => {
      const items = resolved()
      res.json({
        enabled,
        warnings: catalog.warnings,
        mapped: items.filter(i => i.mapped).length,
        total: items.length,
        items
      })
    })

    router.get('/monitor/modules', (_req, res) => {
      const modules = {}
      for (const [m, src] of moduleSource) modules[`0x${m.toString(16).padStart(2, '0')}`] = src
      res.json({ modules })
    })

    // Diagnostics: what the plugin itself sees for one path.
    router.get('/monitor/debug', (req, res) => {
      const skPath = String(req.query.path || '')
      let node
      try { node = typeof app.getSelfPath === 'function' ? app.getSelfPath(skPath) : 'getSelfPath unavailable' } catch (err) { node = `error: ${err.message}` }
      const cached = bySource.get(skPath)
      res.json({
        path: skPath,
        getSelfPath: node === undefined ? null : node,
        stream: cached ? Object.fromEntries(cached) : null,
        decoded: own.has(skPath) ? own.get(skPath) : null,
        streamConnected: typeof streamUnsubscribe === 'function',
        modules: Object.fromEntries([...moduleSource].map(([m, src]) => [`0x${m.toString(16).padStart(2, '0')}`, src]))
      })
    })

    // Diagnostics: raw bus traffic seen by the plugin (via canboatjs:rawoutput).
    router.get('/monitor/bus', (_req, res) => {
      const top = m => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).slice(0, 40))
      res.json({
        listening: !!rawListener,
        frames: busStats.frames,
        seconds: Math.round((Date.now() - busStats.since) / 1000),
        byPgn: top(busStats.byPgn),
        bySource: top(busStats.bySource),
        sensorsSeen: Object.fromEntries(busStats.sensors),
        sensorsWanted: [...busIndex.keys()]
      })
    })

    router.get('/monitor/values', (_req, res) => {
      const values = {}
      for (const item of resolved()) {
        for (const r of item.readings) if (r.series) values[r.series] = r.value
      }
      res.json({ timestamp: new Date().toISOString(), values })
    })

    router.get('/trend/status', (_req, res) => {
      if (!store) return res.json({ available: false, reason: 'not_started' })
      res.json({ ...store.status(), trending: trendSeries().size })
    })

    router.get('/trend', (req, res) => {
      const skPath = String(req.query.path || '')
      const range = RANGES[req.query.range] ? req.query.range : '24h'
      if (!skPath) return res.status(400).json({ error: 'path parameter required' })
      if (!store) return res.json({ available: false, reason: 'not_started', data: [] })
      res.json(store.read(skPath, range))
    })
  }

  return { start, stop, registerRoutes, sample, valueAt, learnModuleSource, onRawFrame, cacheValue, getCatalog: () => catalog, getStore: () => store }
}

module.exports = { createMonitor }
