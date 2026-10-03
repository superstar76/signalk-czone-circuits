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
const { cardSetupArchive, CARD_SETUP_FILE } = require('./venus-card')
const { createTrendStore, RANGES } = require('./storage')
const nmea = require('../nmea2000')
const { createCircuitCurrents, createTableReassembler, CURRENT_PGNS } = require('./currents')
const { SENSOR_PGNS, FAST_SENSOR_PGNS, sensorRank, decodeSensorFrame, decodeSensorPacket, decodeDcSender, dcInstanceOf } = require('./sensors')
const { createFastPacketReassembler } = require('./fastpacket')
const { createWireListener } = require('./wire')
const { DC_TYPES } = require('../zcf-monitor')
const { createVictronSwitches } = require('../victron/switches')

const PLUGIN_ID = 'signalk-czone-circuits'
const REPUBLISH_MS = 30e3

// CZone per-module status PGNs (0xFF04, 0xFF15, 0xFF16, 0xFF1C): byte 2 after
// "27 99" is the sending module's dipswitch address.
const MODULE_STATUS_PS = new Set([0x04, 0x15, 0x16, 0x1c])

// How long a value decoded off the bus counts as live. Temperature senders
// can be slow (some update every few minutes), so they get five minutes.
const FRESH_MS = 120e3
const TEMPERATURE_FRESH_MS = 300e3
const TEMPERATURE_PGNS = new Set([130312, 130316])
const isFresh = (entry, now = Date.now()) => now - entry.at < (TEMPERATURE_PGNS.has(entry.pgn) ? TEMPERATURE_FRESH_MS : FRESH_MS)

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
  let sensorReassembler = null
  let wire = null
  let victron = null
  let controls = null // { state(slug, on), brightness(slug, 0..1) } from the host plugin
  let victronStatus = { enabled: false, running: false }
  let busIndex = new Map() // sensor key -> [Signal K path used as the reading's identity]
  // Diagnostics: what actually reaches the plugin from the bus.
  const busStats = { frames: 0, since: Date.now(), byPgn: new Map(), bySource: new Map(), sensors: new Map(), contested: new Map() }
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
      const dc = decodeDcSender(isoPgn, frame.data)
      if (dc) noteDcSender(dc, frame.source)
      storeSensors(decodeSensorFrame(isoPgn, frame.data), frame.source, isoPgn)
      return
    }
    if (FAST_SENSOR_PGNS.has(isoPgn)) {
      if (sensorReassembler) sensorReassembler.accept({ pgn: isoPgn, source: frame.source, canId: frame.canId, data: frame.data })
      return
    }
    learnFromFrame(frame)
  }

  // Which sender a third-party reading is taken from. Two devices can send the
  // same instance (seen on Compass Rose: battery instance 0 from two
  // addresses), and one reading can arrive in two message styles (AC). Letting
  // them overwrite each other makes the value, and its trend, jump between
  // devices. So a reading stays with its sender until that sender has been
  // quiet for OWNER_QUIET_MS; a higher-ranked message style takes over at once.
  const OWNER_QUIET_MS = 30e3
  const owners = new Map() // sensor key -> { source, pgn, rank, at }
  function mayUse (key, source, pgn, now) {
    const rank = sensorRank(pgn)
    const o = owners.get(key)
    const same = o && o.source === source && o.pgn === pgn
    if (!o || same || rank > o.rank || now - o.at > OWNER_QUIET_MS) {
      owners.set(key, { source, pgn, rank, at: now })
      return true
    }
    if (!busStats.contested.has(key)) busStats.contested.set(key, new Set())
    busStats.contested.get(key).add(`${o.source}/${o.pgn}`).add(`${source}/${pgn}`)
    return false
  }

  // DC meters (battery, solar, alternator, converter): which device a
  // third-party meter is read from when several send its instance.
  //
  // Compass Rose, 3 Oct 2026: instance 0 comes from five devices (BMS, shunt,
  // inverter/charger, MPPT battery side, DC-DC converter) and instance 1 from
  // three (shunt aux input 12.6 V, converter 12.6 V 0 A, MPPT array 81 V 6.5 A).
  // CZone's "Solar" meter is instance 1 with DC type "solar"; only the MPPT
  // says "solar cell" for instance 1 in PGN 127506. So, best first:
  //   1. a device whose declared DC type matches the meter's type in the ZCF
  //      (one that declares another type comes last);
  //   2. for a battery, a device that reports state of charge (the battery
  //      monitor / BMS);
  //   3. for a battery, a device that is not also a charge source (it calls
  //      another of its instances solar, alternator or converter: the MPPT
  //      sends its 38 A output as "battery" instance 0, the shunt and BMS the
  //      real 31 A);
  //   4. the lower NMEA 2000 address, so the choice is the same after every
  //      restart and a trend never changes device by accident.
  // Each reading goes to the best device that is sending that reading; a
  // device counts while it has sent it within OWNER_QUIET_MS. Once a device of
  // the right type has been heard, only devices of that type are used. A device states
  // its type every 1.5 s, so for a second or two after a start the meter can
  // be on another device before the right one takes over.
  const dcWanted = new Map() // instance -> DC type the ZCF gives the third-party meter (undefined if not known)
  const dcSenders = new Map() // instance -> Map(source -> { dcType, soc, keys: Map(sensor key -> last sent) })

  function dcSender (instance, source) {
    if (!dcSenders.has(instance)) dcSenders.set(instance, new Map())
    const senders = dcSenders.get(instance)
    if (!senders.has(source)) senders.set(source, { dcType: undefined, soc: false, keys: new Map() })
    return senders.get(source)
  }

  function noteDcSender (info, source) {
    const s = dcSender(info.instance, source)
    if (info.dcType !== undefined) s.dcType = info.dcType
    if (info.soc) s.soc = true
  }

  function isChargeSource (source) {
    for (const senders of dcSenders.values()) {
      const s = senders.get(source)
      if (s && s.dcType !== undefined && s.dcType !== 0) return true
    }
    return false
  }

  function dcScore (instance, s, source) {
    const want = dcWanted.get(instance)
    const battery = want === undefined || want === 0
    let score = 0
    if (want !== undefined && s.dcType !== undefined) score += s.dcType === want ? 4 : -4
    if (battery && s.soc) score += 2
    if (battery && isChargeSource(source)) score -= 1
    return score
  }

  // The device a DC reading is taken from right now, or undefined.
  function dcChosen (key, instance, now) {
    let best
    const senders = dcSenders.get(instance) || new Map()
    // Once a device of the right type has been heard on this instance, no other
    // kind stands in for it when it goes quiet (a "Solar" meter must not show
    // the DC-DC converter because the MPPT stopped sending). Until then the
    // instance alone decides, as on a CZone display.
    const want = dcWanted.get(instance)
    let typed = false
    if (want !== undefined) for (const s of senders.values()) if (s.dcType === want) typed = true
    for (const [src, s] of senders) {
      if (typed && s.dcType !== want) continue
      const at = s.keys.get(key)
      if (at === undefined || now - at > OWNER_QUIET_MS) continue
      const score = dcScore(instance, s, src)
      if (!best || score > best.score || (score === best.score && src < best.source)) best = { source: src, score }
    }
    return best
  }

  function mayUseDc (key, instance, source, now) {
    dcSender(instance, source).keys.set(key, now)
    const chosen = dcChosen(key, instance, now)
    if (!chosen) return false
    if (chosen.source === source) return true
    if (!busStats.contested.has(key)) busStats.contested.set(key, new Set())
    busStats.contested.get(key).add(String(chosen.source)).add(String(source))
    return false
  }

  function thirdPartyMayUse (key, source, pgn, now) {
    const instance = dcInstanceOf(key)
    return instance === undefined ? mayUse(key, source, pgn, now) : mayUseDc(key, instance, source, now)
  }

  function isCzoneSource (source) {
    for (const src of moduleSource.values()) if (src === source) return true
    return false
  }

  function storeSensors (values, source, pgn) {
    const now = Date.now()
    for (const { key, value } of values) {
      const targets = busIndex.get(key) || []
      busStats.sensors.set(`${key}@${source}`, { key, value, source, pgn, matched: targets.length > 0, at: new Date().toISOString() })
      let thirdParty // decided once per key, only if a third-party reading wants it
      for (const t of targets) {
        if (t.sourceModule !== undefined) {
          // A meter wired to a CZone module is taken only from that module.
          if (moduleSource.get(t.sourceModule) !== source) continue
        } else {
          // A third-party meter or sender is never a CZone module's own
          // broadcast (bench: a wired meter can use the same instance).
          if (thirdParty === undefined) thirdParty = !isCzoneSource(source) && thirdPartyMayUse(key, source, pgn, now)
          if (!thirdParty) continue
        }
        own.set(t.path, { value, at: now, published: now, bus: true, source, pgn })
      }
    }
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
    if (mine && isFresh(mine)) return mine.value
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
    return mine && isFresh(mine) ? mine.value : null
  }

  // The temperature that goes with a circuit (see catalog.temperatureLinks):
  // { kelvin, path, trend, input } or null when the circuit has none.
  // kelvin is null while the sender is quiet.
  function temperatureFor (slugOrName) {
    const link = (catalog.links || []).find(l => l.slug === slugOrName || l.circuit === slugOrName)
    if (!link) return null
    const item = catalog.items.find(i => i.id === link.itemId)
    if (!item) return null
    const r = resolveCatalog([item], getValue)[0].readings[0]
    return { kelvin: typeof r.value === 'number' ? r.value : null, path: link.path, trend: item.readings[0].candidates[0], input: link.input }
  }

  // Published beside the circuit's state and current, so the webapp and
  // anything else on Signal K can follow it: electrical.czone.<slug>.temperature (K).
  function publishTemperatures () {
    for (const link of catalog.links || []) {
      const t = temperatureFor(link.slug)
      if (!t) continue
      if (t.kelvin === null) {
        const before = own.get(link.path)
        if (before && before.value !== null) publish(link.path, null) // gone quiet: say so once
      } else publish(link.path, Math.round(t.kelvin * 100) / 100)
    }
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
    victron = createVictronSwitches(app, { log, getCurrent: p => valueAt(p), getTemperature: slug => { const t = temperatureFor(slug); return t ? t.kelvin : null }, controls: () => controls, version: options.version || require('../../package.json').version })
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
    reassembler = createTableReassembler(onCurrentPacket)
    sensorReassembler = createFastPacketReassembler(FAST_SENSOR_PGNS, p => storeSensors(decodeSensorPacket(p.pgn, p.payload), p.source, p.pgn))
    owners.clear()
    for (const m of [dcWanted, dcSenders]) m.clear()
    busIndex = new Map()
    for (const item of catalog.items) {
      for (const r of item.readings) {
        if (!r.bus || !r.candidates[0]) continue
        const dcInstance = r.sourceModule === undefined ? dcInstanceOf(r.bus) : undefined
        if (dcInstance !== undefined && !dcWanted.has(dcInstance)) dcWanted.set(dcInstance, r.dcType)
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
    if ((catalog.links || []).length) {
      log(`Circuit temperatures: ${catalog.links.map(l => `${l.circuit} <- ${l.input}`).join(', ')}`)
      timers.push(setInterval(publishTemperatures, 5000))
    }
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
    if (sensorReassembler) sensorReassembler.clear()
    sensorReassembler = null
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
        circuitTemperatures: (catalog.links || []).map(l => ({ ...l, kelvin: (temperatureFor(l.slug) || {}).kelvin })),
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
        // One entry per reading and sender ("batteryVoltage:0:0@46").
        sensorsSeen: Object.fromEntries(busStats.sensors),
        // Which sender each third-party reading is taken from, and readings
        // that more than one sender (address/PGN) offers.
        sensorOwners: Object.fromEntries([...owners].map(([k, o]) => [k, `${o.source}/${o.pgn}`])),
        // DC meters: the type the ZCF asks for, what each device sending that
        // instance says it is, and which device was chosen.
        dcMeters: Object.fromEntries([...dcSenders].map(([instance, senders]) => {
          const now = Date.now()
          const voltage = dcChosen(`batteryVoltage:${instance}:0`, instance, now)
          return [instance, {
            wanted: dcWanted.has(instance) ? (DC_TYPES[dcWanted.get(instance)] || 'any') : 'not a third-party meter',
            chosen: voltage ? voltage.source : null,
            senders: Object.fromEntries([...senders].map(([src, s]) => [src, { type: s.dcType === undefined ? 'not stated' : (DC_TYPES[s.dcType] || s.dcType), stateOfCharge: s.soc, score: dcScore(instance, s, src) }]))
          }]
        })),
        contested: Object.fromEntries([...busStats.contested].map(([k, v]) => [k, [...v]])),
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

    // The card setup file for a GX (see venus-card.js): copied onto the card,
    // it makes Venus OS open the card for Signal K at every boot. No login to
    // the GX is needed.
    router.get('/trend/card-setup', (_req, res) => {
      const body = cardSetupArchive()
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${CARD_SETUP_FILE}"`)
      res.setHeader('Content-Length', body.length)
      res.end(body)
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

  return { start, stop: stopAll, setControls: c => { controls = c }, registerRoutes, sample, valueAt, temperatureFor, publishTemperatures, backfillTrends: () => backfillTrends(true), learnModuleSource, onRawFrame, cacheValue, getCatalog: () => catalog, getStore: () => store }
}

module.exports = { createMonitor }
