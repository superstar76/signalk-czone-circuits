'use strict'

// Monitor + trending for signalk-czone-circuits.
//
// Self-contained: the host plugin only needs to call
//   monitor.start(settings, zcfFilePath)   from plugin.start
//   monitor.stop()                         from plugin.stop
//   monitor.registerRoutes(router)         from plugin.registerWithRouter
//
// Values are read in-process from Signal K (no HTTP to localhost), sampled
// every `trendSampleSeconds` (5/10/15/30/60, default 10), buffered, and
// appended to the SD card once a minute (see storage.js for what is written).

const fs = require('fs')
const path = require('path')
const { buildCatalog, resolveCatalog, seriesKey } = require('./catalog')
const { createTrendStore, RANGES } = require('./storage')
const nmea = require('../nmea2000')
const { createCircuitCurrents, CURRENT_PGNS } = require('./currents')
const { SENSOR_PGNS, decodeSensorFrame } = require('./sensors')
const { createWireListener } = require('./wire')
const { createVictronSwitches } = require('../victron/switches')

const PLUGIN_ID = 'signalk-czone-circuits'
const REPUBLISH_MS = 30e3

// CZone per-module status PGNs (0xFF04, 0xFF15, 0xFF16, 0xFF1C): byte 2 after
// "27 99" is the sending module's dipswitch address.
const MODULE_STATUS_PS = new Set([0x04, 0x15, 0x16, 0x1c])

const SAMPLE_SECONDS = [5, 10, 15, 30, 60]
const DEFAULT_SAMPLE_SECONDS = 10

function sampleSecondsFrom (settings = {}) {
  const n = Number(settings.trendSampleSeconds)
  return SAMPLE_SECONDS.includes(n) ? n : DEFAULT_SAMPLE_SECONDS
}

function unwrap (v) {
  if (v && typeof v === 'object' && 'value' in v) return v.value
  return v
}

function createMonitor (app, options = {}) {
  const log = options.log || (msg => { if (typeof app.debug === 'function') app.debug(`[monitor] ${msg}`) })
  let catalog = { items: [], warnings: ['Not started'] }
  let store = null
  let sampleSeconds = DEFAULT_SAMPLE_SECONDS
  let timers = []
  let enabled = false
  let rawListener = null
  let streamUnsubscribe = null
  const moduleSource = new Map() // CZone dipswitch -> NMEA 2000 source address
  const bySource = new Map() // path -> Map($source -> value), from the live delta stream
  const own = new Map() // path -> { value, at }: values this monitor decodes itself
  let currents = createCircuitCurrents([])
  let reassembler = null
  let wire = null
  let victron = null
  let controls = null // { state(slug, on), brightness(slug, 0..1) } from the host plugin
  let victronStatus = { enabled: false, running: false }
  let busIndex = new Map() // sensor key -> [Signal K path used as the reading's identity]
  // Diagnostics: what actually reaches the plugin from the bus.
  const busStats = { frames: 0, since: Date.now(), byPgn: new Map(), bySource: new Map(), sensors: new Map() }
  const currentStats = { frames: 0, bySource: new Map(), packets: 0, decoded: 0, last: null, lastFrame: null, reassemblerResets: 0 }

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
    currentStats.packets++
    const touched = currents.accept(packet.pgn, packet.payload)
    if (touched.length) currentStats.decoded++
    currentStats.last = { at: new Date().toISOString(), pgn: packet.pgn, source: packet.source, payload: packet.payload.toString('hex'), circuits: touched.map(t => `${t.circuit.name}=${t.amps}`) }
    for (const { circuit, amps } of touched) {
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
    if (CURRENT_PGNS.has(frame.pgn)) {
      currentStats.frames++
      currentStats.bySource.set(frame.source, (currentStats.bySource.get(frame.source) || 0) + 1)
      currentStats.lastFrame = { at: new Date().toISOString(), canId: frame.canId.toString(16), data: frame.data.toString('hex') }
      if (reassembler) reassembler.accept(frame)
      return
    }
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
        for (const t of busIndex.get(key) || []) {
          // A meter wired to a CZone module is taken only from that module.
          if (t.sourceModule !== undefined && moduleSource.get(t.sourceModule) !== frame.source) continue
          own.set(t.path, { value, at: now, published: now, bus: true })
        }
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
    // With the wire listener running, a third-party reading comes only from
    // its NMEA 2000 instance on the wire. On a GX, Signal K's own
    // electrical.batteries.<n> / environment paths use VRM instances, which
    // are not the NMEA 2000 instances CZone is configured with.
    if (reading.bus && wire && wire.status().running) return undefined
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

  // A reading that has gone quiet keeps pointing at the series it was last
  // recorded under, so its history can still be charted.
  const lastSeries = new Map()
  function resolved () {
    const items = resolveCatalog(catalog.items, getValue)
    for (const item of items) {
      for (const r of item.readings) {
        const id = `${item.id}|${r.key}`
        if (r.series) lastSeries.set(id, r.series)
        else if (lastSeries.has(id)) r.history = lastSeries.get(id)
      }
    }
    return items
  }

  // Every series the catalogue can record, and the other folders each one's
  // history may be in:
  //   - the reading's other candidate paths (a sensor seen on the bus is
  //     recorded under its instance path; the February plugin recorded it
  //     under the Signal K path);
  //   - the bare path, where this plugin adds the source module ("…@czone-04");
  //   - anything listed in <trend folder>/aliases.json:
  //       { "<series>": ["<old folder name>", …] }
  //     for history recorded under unrelated names (Venus/VRM instance paths).
  // Old folders are read in place and never changed.
  const ALIAS_FILE = 'aliases.json'
  let aliasInfo = { auto: 0, file: 0 }
  function knownSeries () {
    const keys = new Set()
    const groups = []
    const primary = new Set() // one series per reading gets the summaries built: where it records now, else its first path
    for (const item of catalog.items) {
      for (const r of item.readings) {
        const own = r.candidates.map(c => seriesKey(c, r.sourceModule))
        own.forEach(k => keys.add(k))
        if (!own.length) continue
        groups.push([...new Set([...own, ...r.candidates])])
        primary.add(lastSeries.get(`${item.id}|${r.key}`) || own[0])
      }
    }
    for (const key of lastSeries.values()) keys.add(key)
    const aliases = new Map()
    const count = new Map() // a folder name claimed by two readings belongs to neither as an alias
    for (const g of groups) for (const n of g) count.set(n, (count.get(n) || 0) + 1)
    for (const g of groups) {
      for (const key of g) {
        if (!keys.has(key)) continue
        const others = g.filter(n => n !== key && count.get(n) === 1)
        if (others.length) aliases.set(key, others)
      }
    }
    aliasInfo = { auto: aliases.size, file: 0 }
    try {
      const where = store ? store.status() : null
      const file = where && where.available ? path.join(where.dir, ALIAS_FILE) : null
      if (file && fs.existsSync(file)) {
        const extra = JSON.parse(fs.readFileSync(file, 'utf8'))
        for (const [key, names] of Object.entries(extra)) {
          const list = [].concat(names).filter(n => typeof n === 'string' && n)
          if (!list.length) continue
          // Applies to the reading whichever of its paths it is recorded under.
          const group = groups.find(g => g.includes(key)) || [key]
          if (!keys.has(key)) { keys.add(key); primary.add(key) }
          for (const k of group) if (keys.has(k)) aliases.set(k, [...new Set([...(aliases.get(k) || []), ...list])])
          aliasInfo.file++
        }
      }
    } catch (err) { aliasInfo.error = err.message; log(`Trend ${ALIAS_FILE} not used: ${err.message}`) }
    return { keys: [...primary], aliases }
  }

  // Summaries for history that has none (see storage.backfill). One series at a
  // time so a long history never holds up the server.
  let backfillStatus = { state: 'idle', series: 0, buckets: 0 }
  function backfillTrends (sync = false) {
    const { keys, aliases } = knownSeries()
    store.setAliases(aliases) // the card (and aliases.json) may have appeared since start
    backfillStatus = { state: 'running', series: 0, buckets: 0 }
    const target = store
    const step = i => {
      if (store !== target) return
      if (i >= keys.length) {
        backfillStatus.state = 'done'
        if (backfillStatus.series) log(`Trend history: built ${backfillStatus.buckets} summaries for ${backfillStatus.series} values`)
        return
      }
      try {
        const r = store.backfill(keys[i])
        if (r.done && r.buckets) { backfillStatus.series++; backfillStatus.buckets += r.buckets }
      } catch (err) { log(`Trend backfill failed for ${keys[i]}: ${err.message}`) }
      if (sync) step(i + 1)
      else timers.push(setTimeout(() => step(i + 1), 50))
    }
    step(0)
    return backfillStatus
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
    // Victron switch pane (independent of monitoring; off unless ticked).
    if (victron) victron.stop()
    victron = createVictronSwitches(app, { log, getCurrent: p => valueAt(p), controls: () => controls, version: options.version || require('../../package.json').version })
    victronStatus = { enabled: settings.victronSwitches === true, running: false }
    if (settings.victronSwitches === true) {
      victron.start(settings, zcfFile, options.victron || {}).then(s => { victronStatus = s }).catch(err => { victronStatus = { enabled: true, running: false, error: err.message } })
    }
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
      retentionDays: settings.trendRetentionDays, // 0 / unset: keep until space runs low
      directory: settings.trendDirectory || null,
      fallbackDir: typeof app.getDataDirPath === 'function' ? app.getDataDirPath() : null,
      isVenus: options.isVenus,
      log
    })
    store.setAliases(knownSeries().aliases)

    currents = createCircuitCurrents(catalog.items
      .filter(i => i.group === 'Circuit current' && Array.isArray(i.outputs))
      .map(i => ({ id: i.circuitId, name: i.name, path: i.readings[0].candidates[0], outputs: i.outputs })))
    reassembler = nmea.createFastPacketReassembler(onCurrentPacket)
    busIndex = new Map()
    for (const item of catalog.items) {
      for (const r of item.readings) {
        if (!r.bus || !r.candidates[0]) continue
        if (!busIndex.has(r.bus)) busIndex.set(r.bus, [])
        busIndex.get(r.bus).push({ path: r.candidates[0], sourceModule: r.sourceModule })
      }
    }
    if (typeof app.on === 'function') {
      rawListener = onRawFrame
      app.on('canboatjs:rawoutput', rawListener)
    }
    // Sensor PGNs straight off the CAN interface (catches the GX's own
    // transmissions, which Signal K does not pass to plugins).
    // Only for senders configured in CZone as third-party (module 0): ones
    // wired to a CZone input are broadcast by the CZone module and arrive
    // through Signal K like any other device.
    const thirdPartySenders = catalog.items.some(i => (i.source === 'zcf-sender' || (i.source === 'zcf-meter' && i.virtual)) && i.readings.some(r => r.bus))
    if (thirdPartySenders && settings.monitorWire !== false) {
      wire = createWireListener({ device: settings.monitorCanDevice || 'vecan0', onLine: onRawFrame, log })
      wire.start()
    }
    try {
      const bus = app.streambundle && typeof app.streambundle.getSelfBus === 'function' ? app.streambundle.getSelfBus() : null
      if (bus && typeof bus.onValue === 'function') streamUnsubscribe = bus.onValue(cacheValue)
    } catch (err) { log(`Delta stream unavailable: ${err.message}`) }

    sampleSeconds = sampleSecondsFrom(settings)
    const sampleMs = sampleSeconds * 1000
    timers.push(setInterval(sample, sampleMs))
    timers.push(setInterval(() => {
      const r = store.flush()
      if (r.written) log(`Trend: wrote ${r.written} samples`)
    }, 60e3))
    const purge = () => { try { store.purge() } catch (err) { log(`Trend purge failed: ${err.message}`) } }
    timers.push(setTimeout(() => backfillTrends(), 20e3))
    timers.push(setTimeout(purge, 15e3))
    timers.push(setInterval(purge, 3600e3))
  }

  function stopAll () {
    if (victron) { victron.stop(); victron = null }
    stop()
  }

  function stop () {
    if (rawListener && typeof app.removeListener === 'function') app.removeListener('canboatjs:rawoutput', rawListener)
    rawListener = null
    if (wire) { wire.stop(); wire = null }
    if (reassembler && typeof reassembler.clear === 'function') reassembler.clear()
    reassembler = null
    if (typeof streamUnsubscribe === 'function') { try { streamUnsubscribe() } catch (_) {} }
    streamUnsubscribe = null
    for (const t of timers) { clearInterval(t); clearTimeout(t) }
    timers = []
    if (store) { try { store.close() } catch (_) {} }
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
        wire: wire ? wire.status() : null,
        frames: busStats.frames,
        seconds: Math.round((Date.now() - busStats.since) / 1000),
        byPgn: top(busStats.byPgn),
        bySource: top(busStats.bySource),
        sensorsSeen: Object.fromEntries(busStats.sensors),
        sensorsWanted: [...busIndex.keys()],
        currentTables: {
          frames: currentStats.frames,
          bySource: Object.fromEntries(currentStats.bySource),
          packets: currentStats.packets,
          decoded: currentStats.decoded,
          lastFrame: currentStats.lastFrame,
          lastPacket: currentStats.last,
          reassembler: !!reassembler
        }
      })
    })

    router.get('/victron/status', (_req, res) => res.json(victron ? { ...victronStatus, ...victron.status() } : victronStatus))

    router.get('/monitor/values', (_req, res) => {
      const values = {}
      for (const item of resolved()) {
        for (const r of item.readings) if (r.series) values[r.series] = r.value
      }
      res.json({ timestamp: new Date().toISOString(), values })
    })

    router.get('/trend/status', (_req, res) => {
      if (!store) return res.json({ available: false, reason: 'not_started' })
      res.json({ ...store.status(), sampleSeconds, trending: trendSeries().size, backfill: backfillStatus, aliases: aliasInfo })
    })

    router.get('/trend', (req, res) => {
      const skPath = String(req.query.path || '')
      // ?range=24h (ending now) or ?from=<ms>&to=<ms> for a custom period.
      const custom = req.query.from !== undefined && req.query.to !== undefined
      const range = custom ? { from: Number(req.query.from), to: Number(req.query.to) } : (RANGES[req.query.range] ? req.query.range : '24h')
      if (!skPath) return res.status(400).json({ error: 'path parameter required' })
      if (!store) return res.json({ available: false, reason: 'not_started', data: [] })
      res.json(store.read(skPath, range))
    })
  }

  return { start, stop: stopAll, setControls: c => { controls = c }, registerRoutes, sample, valueAt, backfillTrends: () => backfillTrends(true), learnModuleSource, onRawFrame, cacheValue, getCatalog: () => catalog, getStore: () => store }
}

module.exports = { createMonitor }
