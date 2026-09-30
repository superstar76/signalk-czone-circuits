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

  function getValue (skPath) {
    if (typeof app.getSelfPath !== 'function') return undefined
    try {
      const v = unwrap(app.getSelfPath(skPath))
      return v === null ? undefined : v
    } catch (_) { return undefined }
  }

  function resolved () {
    return resolveCatalog(catalog.items, getValue)
  }

  function trendPaths () {
    const paths = new Set()
    for (const item of resolved()) {
      for (const r of item.readings) if (r.path && typeof r.value === 'number') paths.add(r.path)
    }
    return paths
  }

  function sample () {
    const now = Date.now()
    for (const p of trendPaths()) store.record(p, getValue(p), now)
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

    router.get('/monitor/values', (_req, res) => {
      const values = {}
      for (const item of resolved()) {
        for (const r of item.readings) if (r.path) values[r.path] = r.value
      }
      res.json({ timestamp: new Date().toISOString(), values })
    })

    router.get('/trend/status', (_req, res) => {
      if (!store) return res.json({ available: false, reason: 'not_started' })
      res.json({ ...store.status(), trending: trendPaths().size })
    })

    router.get('/trend', (req, res) => {
      const skPath = String(req.query.path || '')
      const range = RANGES[req.query.range] ? req.query.range : '24h'
      if (!skPath) return res.status(400).json({ error: 'path parameter required' })
      if (!store) return res.json({ available: false, reason: 'not_started', data: [] })
      res.json(store.read(skPath, range))
    })
  }

  return { start, stop, registerRoutes, sample, getCatalog: () => catalog, getStore: () => store }
}

module.exports = { createMonitor }
