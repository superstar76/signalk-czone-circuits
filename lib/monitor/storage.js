'use strict'

// Trend storage. Plain CSV files, in two tiers (round-robin by age):
//
//   <dir>/<series>/<YYYY-MM-DD>.csv          full detail: "timestamp_ms,value"
//   <dir>/<series>/summary/<YYYY-MM>.csv     10-minute: "bucket_ms,min,avg,max"
//
// Full detail is written on change: a sample is stored when the value differs
// from the last stored one (plus the last unchanged sample before it, so lines
// keep their shape) and at least every 10 minutes. Summaries are built in
// memory from every sample. Charts up to 48 h read full detail; longer ranges
// read summaries.
//
// Nothing is deleted by age unless `retentionDays` (full detail) or
// `summaryYears` is set. Both tiers are kept until the volume runs low; then
// the oldest full-detail days go first and the oldest summary months only when
// no old full detail is left, so recording never stops.
//
// Size guide, 200 series at 10 s: up to 12.6 GB of full detail per year (worst
// case, every sample different) plus 0.34 GB of summaries. Minimum recommended
// card: 16 GB.
//
// Memory: a few numbers per series, plus at most one flush interval of rows.
// With no storage available nothing is kept or written.
//
// Where trends go:
//   - trendDirectory setting, if given (any platform)
//   - Venus OS (GX): removable storage only (SD card or USB stick). The GX's
//     internal flash (/data) is never written; without a card, trending is off.
//   - anywhere else (Pi with SSD, Ubuntu, …): Signal K's plugin data folder.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const TREND_SUBDIR = path.join('signalk-czone', 'trends')
const SUMMARY_DIR = 'summary'
const BACKFILL_MARKER = '.backfilled'
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.csv$/
const SYSTEM_PATHS = new Set(['/', '/data', '/boot', '/run', '/tmp', '/var', '/proc', '/sys', '/dev'])
const DAY = 86400e3
const RANGES = { '1h': 3600e3, '24h': DAY, '7d': 7 * DAY, '31d': 31 * DAY, '90d': 90 * DAY, '1y': 365 * DAY }
const RAW_MAX_SPAN = 2 * DAY // longer ranges read the summary tier
const TARGET_POINTS = 400
const BUCKET_MS = 600e3 // summary resolution
const HEARTBEAT_MS = 600e3 // an unchanged value is still written this often
// Free space to leave: a dedicated card can run nearly full; a disk shared
// with the system (Signal K data folder, custom folder) keeps more.
const MAX_GUARD_STEPS = 60
const LOCATE_TTL_MS = 5 * 60e3
const RESERVE = {
  removable: { bytes: 200 * 1024 * 1024, fraction: 0.05 },
  shared: { bytes: 1024 * 1024 * 1024, fraction: 0.10 }
}

function sanitizePath (skPath) {
  return String(skPath).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function dateKey (ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

// Cerbo GX: the SD card is /dev/mmcblk0p1 (mmcblk1 is the internal eMMC).
// Prefer it, then any other removable mount under /run/media or /media.
function findStorageMount (mountsText) {
  const lines = String(mountsText || '').split('\n')
  const entries = lines.map(l => l.trim().split(/\s+/)).filter(p => p.length >= 2)
    .map(([device, mountPoint]) => ({ device, mountPoint: mountPoint.replace(/\\040/g, ' ') }))
  const usable = e => !SYSTEM_PATHS.has(e.mountPoint) && isDirectory(e.mountPoint)
  const sd = entries.find(e => /^\/dev\/mmcblk0p?\d*$/.test(e.device) && usable(e))
  if (sd) return sd.mountPoint
  const removable = entries.find(e => /^\/(run\/)?media\//.test(e.mountPoint) && usable(e))
  return removable ? removable.mountPoint : null
}

// Venus OS ships /opt/victronenergy; nothing else does.
function isVenusOs () {
  try { return fs.existsSync('/opt/victronenergy') } catch (_) { return false }
}

function readMounts () {
  try { return fs.readFileSync('/proc/mounts', 'utf8') } catch (_) { return '' }
}

function isDirectory (p) {
  try { return fs.statSync(p).isDirectory() } catch (_) { return false }
}

function isWritable (dir) {
  const probe = path.join(dir, '.signalk-czone-write-test')
  try { fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return true } catch (_) { return false }
}

const monthKey = ms => new Date(ms).toISOString().slice(0, 7)
const round = v => Math.round(v * 1000) / 1000

// Reduce rows to about `target` points by time bucket. Rows are [t, v] or
// [t, avg, min, max]; output rows are [t, avg, min, max].
function bucketize (rows, start, end, target = TARGET_POINTS) {
  const size = Math.max(1, Math.ceil((end - start) / target))
  const buckets = new Map()
  for (const r of rows) {
    const b = Math.floor((r[0] - start) / size)
    const lo = r.length > 2 ? r[2] : r[1]
    const hi = r.length > 3 ? r[3] : r[1]
    const cur = buckets.get(b)
    if (!cur) buckets.set(b, { tSum: r[0], sum: r[1], n: 1, min: lo, max: hi })
    else { cur.tSum += r[0]; cur.sum += r[1]; cur.n++; cur.min = Math.min(cur.min, lo); cur.max = Math.max(cur.max, hi) }
  }
  const out = [...buckets.keys()].sort((a, b) => a - b).map(k => {
    const c = buckets.get(k)
    return [Math.round(c.tSum / c.n), round(c.sum / c.n), round(c.min), round(c.max)]
  })
  return { data: out, resolution: size }
}

function freeSpace (dir) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(dir)
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }
    }
  } catch (_) {}
  // Older Node: ask df (BusyBox and GNU agree on -k columns).
  try {
    const line = execFileSync('df', ['-k', dir], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').pop()
    const p = line.trim().split(/\s+/)
    const total = Number(p[p.length - 5]) * 1024
    const free = Number(p[p.length - 3]) * 1024
    return Number.isFinite(total) && Number.isFinite(free) ? { free, total } : null
  } catch (_) { return null }
}

function createTrendStore (options = {}) {
  // 0 = no age limit: keep until space runs low.
  const retentionDays = Number(options.retentionDays) > 0 ? Number(options.retentionDays) : 0
  const summaryYears = Number(options.summaryYears) > 0 ? Number(options.summaryYears) : 0
  const mountsProvider = options.mountsProvider || readMounts
  const overrideDir = options.directory || null
  const isVenus = options.isVenus !== undefined ? options.isVenus : isVenusOs()
  const fallbackDir = options.fallbackDir || null
  const spaceProvider = options.spaceProvider || freeSpace
  const log = options.log || (() => {})
  const pending = new Map() // series -> [[t, v], ...]          full detail to write
  const pendingSummary = new Map() // series -> [[t, min, avg, max], ...]
  const state = new Map() // series -> { written: [t, v], seen: [t, v], agg: { bucket, min, max, sum, n } }

  // Finding storage means a write test; don't repeat it on every call.
  let located = null
  let locatedAt = 0
  function locate () {
    if (located && Date.now() - locatedAt < LOCATE_TTL_MS && isDirectory(located.dir)) return located
    const where = find()
    located = where.available ? where : null
    locatedAt = Date.now()
    return where
  }

  function find () {
    if (overrideDir) {
      try { fs.mkdirSync(overrideDir, { recursive: true }) } catch (_) {}
      return isWritable(overrideDir)
        ? { available: true, dir: overrideDir, mount: overrideDir, location: 'custom' }
        : { available: false, reason: 'write_failed', detail: `Cannot write to ${overrideDir}` }
    }
    if (!isVenus && fallbackDir) {
      const dir = path.join(fallbackDir, 'trends')
      try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
      return isWritable(dir)
        ? { available: true, dir, mount: fallbackDir, location: 'data_dir' }
        : { available: false, reason: 'write_failed', detail: `Cannot write to ${dir}` }
    }
    const mount = findStorageMount(mountsProvider())
    if (!mount) return { available: false, reason: 'no_sd_card', detail: 'No SD card or USB stick detected. Insert one in the GX to enable trending.' }
    const dir = path.join(mount, TREND_SUBDIR)
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
    if (!isWritable(dir)) {
      return {
        available: false,
        reason: 'write_failed',
        mount,
        detail: `Card found at ${mount} but Signal K cannot write to it: Venus OS mounts cards for its own use only. Download the card setup file from the Monitoring tab, copy it onto the card and restart the GX.`
      }
    }
    return { available: true, dir, mount, location: 'removable' }
  }

  const push = (map, key, row) => { if (!map.has(key)) map.set(key, []); map.get(key).push(row) }

  function closeBucket (series, agg) {
    if (agg && agg.n) push(pendingSummary, series, [agg.bucket, round(agg.min), round(agg.sum / agg.n), round(agg.max)])
  }

  // `edge`: a change stored at the moment it happened, between two samples.
  // It counts for the minimum and maximum of its ten minutes, but not for the
  // average, which stays the average of the regular samples.
  function record (series, value, t = Date.now(), edge = false) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    let st = state.get(series)
    if (!st) { st = { written: null, seen: null, agg: null }; state.set(series, st) }

    // Summary tier: every sample counts.
    const bucket = Math.floor(t / BUCKET_MS) * BUCKET_MS
    if (!st.agg || st.agg.bucket !== bucket) {
      closeBucket(series, st.agg)
      st.agg = { bucket, min: value, max: value, sum: 0, n: 0 }
    }
    st.agg.min = Math.min(st.agg.min, value)
    st.agg.max = Math.max(st.agg.max, value)
    if (!edge) { st.agg.sum += value; st.agg.n++ }

    // Full-detail tier: write on change, with a heartbeat.
    if (!st.written) {
      push(pending, series, [t, value]); st.written = [t, value]
    } else if (value !== st.written[1]) {
      if (st.seen && st.seen[0] > st.written[0]) push(pending, series, st.seen)
      push(pending, series, [t, value]); st.written = [t, value]
    } else if (t - st.written[0] >= HEARTBEAT_MS) {
      push(pending, series, [t, value]); st.written = [t, value]
    }
    st.seen = [t, value]
  }

  function appendRows (file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, rows.map(r => r.join(',')).join('\n') + '\n')
  }

  function flush () {
    if (pending.size === 0 && pendingSummary.size === 0) return { written: 0 }
    const where = locate()
    // No storage: keep nothing. Recording starts afresh when a card appears.
    if (!where.available) { pending.clear(); pendingSummary.clear(); state.clear(); return { written: 0, ...where } }
    let written = 0
    for (const [map, fileOf] of [
      [pending, (dir, t) => path.join(dir, `${dateKey(t)}.csv`)],
      [pendingSummary, (dir, t) => path.join(dir, SUMMARY_DIR, `${monthKey(t)}.csv`)]
    ]) {
      for (const [series, rows] of map) {
        const dir = path.join(where.dir, sanitizePath(series))
        const byFile = new Map()
        for (const r of rows) push(byFile, fileOf(dir, r[0]), r)
        try {
          for (const [file, group] of byFile) { appendRows(file, group); written += group.length }
        } catch (err) {
          located = null // card pulled or gone read-only: look again next time
          log(`Trend write failed for ${series}: ${err.message}`)
        }
      }
      map.clear()
    }
    return { written, dir: where.dir }
  }

  // On shutdown: store the last seen value and the open summary buckets.
  function close () {
    for (const [series, st] of state) {
      if (st.seen && st.written && st.seen[0] > st.written[0]) push(pending, series, st.seen)
      closeBucket(series, st.agg)
    }
    state.clear()
    return flush()
  }

  function seriesDirs (root) {
    return safeReaddir(root).map(sub => path.join(root, sub)).filter(isDirectory)
  }

  function purge (now = Date.now()) {
    const where = locate()
    if (!where.available) return 0
    const rawCutoff = retentionDays ? dateKey(now - retentionDays * DAY) : ''
    const summaryCutoff = summaryYears ? monthKey(now - summaryYears * 365 * DAY) : ''
    let removed = 0
    const unlink = f => { try { fs.unlinkSync(f); removed++; return true } catch (_) { return false } }
    // Age limits are optional; without them the usual purge is one free-space check.
    for (const dir of (rawCutoff || summaryCutoff) ? seriesDirs(where.dir) : []) {
      for (const file of safeReaddir(dir)) {
        if (rawCutoff && file.endsWith('.csv') && file.slice(0, 10) < rawCutoff) unlink(path.join(dir, file))
      }
      const sdir = path.join(dir, SUMMARY_DIR)
      for (const file of safeReaddir(sdir)) {
        if (summaryCutoff && file.endsWith('.csv') && file.slice(0, 7) < summaryCutoff) unlink(path.join(sdir, file))
      }
      if (safeReaddir(sdir).length === 0) { try { fs.rmdirSync(sdir) } catch (_) {} }
      if (safeReaddir(dir).length === 0) { try { fs.rmdirSync(dir) } catch (_) {} }
    }

    // Space guard: oldest full-detail day first, then oldest summary month.
    const reserve = RESERVE[where.location === 'removable' ? 'removable' : 'shared']
    const low = () => {
      const s = spaceProvider(where.dir)
      return s && s.free < Math.max(reserve.bytes, s.total * reserve.fraction)
    }
    if (!low()) return removed
    // One scan, then delete oldest first until there is room again. Capped per
    // run so a full card never blocks the server for long; the next run goes on.
    const today = dateKey(now)
    const thisMonth = monthKey(now)
    const dirs = seriesDirs(where.dir)
    const days = new Set()
    const months = new Set()
    for (const dir of dirs) {
      for (const f of safeReaddir(dir)) if (f.endsWith('.csv') && f.slice(0, 10) < today) days.add(f.slice(0, 10))
      for (const f of safeReaddir(path.join(dir, SUMMARY_DIR))) if (f.endsWith('.csv') && f.slice(0, 7) < thisMonth) months.add(f.slice(0, 7))
    }
    let steps = 0
    for (const day of [...days].sort()) {
      if (steps++ >= MAX_GUARD_STEPS || !low()) return removed
      for (const dir of dirs) unlink(path.join(dir, `${day}.csv`))
      log(`Trend storage low: removed full-detail data for ${day}`)
    }
    for (const month of [...months].sort()) {
      if (steps++ >= MAX_GUARD_STEPS || !low()) return removed
      for (const dir of dirs) unlink(path.join(dir, SUMMARY_DIR, `${month}.csv`))
      log(`Trend storage low: removed summaries for ${month}`)
    }
    return removed
  }

  function parse (file, start, end, cols) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch (_) { return [] }
    const out = []
    for (const line of text.split('\n')) {
      if (!line) continue
      const p = line.split(',').map(Number)
      if (p.length < cols || !p.slice(0, cols).every(Number.isFinite)) continue
      if (p[0] >= start && p[0] <= end) out.push(p)
    }
    return out
  }

  // Earlier folder names for a series (data recorded by the February plugin
  // under the bare Signal K path). Read in place; never moved or changed.
  const aliases = new Map()
  function setAliases (map) {
    aliases.clear()
    for (const [series, names] of map || []) aliases.set(series, [...names])
  }
  function rawDirs (root, series) {
    const names = [series, ...(aliases.get(series) || [])].map(sanitizePath)
    return names.filter((n, i) => names.indexOf(n) === i).map(n => path.join(root, n))
  }

  function readRaw (dir, series, start, now) {
    const rows = []
    for (const d of rawDirs(path.dirname(dir), series)) {
      for (let day = new Date(dateKey(start)).getTime(); day <= now; day += DAY) rows.push(...parse(path.join(d, `${dateKey(day)}.csv`), start, now, 2))
    }
    for (const r of pending.get(series) || []) if (r[0] >= start && r[0] <= now) rows.push(r)
    const st = state.get(series)
    if (st && st.seen && st.seen[0] >= start && st.seen[0] <= now) rows.push(st.seen) // current value, even if unchanged
    rows.sort((a, b) => a[0] - b[0])
    return rows.filter((r, i) => i === 0 || r[0] !== rows[i - 1][0])
  }

  function readSummary (dir, series, start, now) {
    const rows = []
    const first = new Date(start)
    for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); ; m++) {
      const d = Date.UTC(y, m, 1)
      if (d > now) break
      for (const dd of rawDirs(path.dirname(dir), series)) {
        for (const p of parse(path.join(dd, SUMMARY_DIR, `${monthKey(d)}.csv`), start, now, 4)) rows.push([p[0], p[2], p[1], p[3]]) // -> [t, avg, min, max]
      }
    }
    for (const p of pendingSummary.get(series) || []) if (p[0] >= start && p[0] <= now) rows.push([p[0], p[2], p[1], p[3]])
    const st = state.get(series)
    if (st && st.agg && st.agg.n && st.agg.bucket >= start && st.agg.bucket <= now) rows.push([st.agg.bucket, round(st.agg.sum / st.agg.n), round(st.agg.min), round(st.agg.max)])
    rows.sort((a, b) => a[0] - b[0])
    // A restart splits a bucket in two rows; merge them.
    const out = []
    for (const r of rows) {
      const last = out[out.length - 1]
      if (last && last[0] === r[0]) { last[1] = round((last[1] + r[1]) / 2); last[2] = Math.min(last[2], r[2]); last[3] = Math.max(last[3], r[3]) } else out.push(r)
    }
    return out
  }

  // `range` is a preset ('1h', '24h', …) ending now, or { from, to } in ms for
  // a custom period.
  function read (series, range = '24h', now = Date.now()) {
    const where = locate()
    if (!where.available) return { available: false, reason: where.reason, detail: where.detail, data: [] }
    const custom = range && typeof range === 'object'
    const end = custom ? Number(range.to) : now
    const start = custom ? Number(range.from) : now - (RANGES[range] || RANGES['24h'])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { available: true, path: series, error: 'bad_range', detail: 'The start must be before the end.', data: [] }
    }
    const label = custom ? 'custom' : (RANGES[range] ? range : '24h')
    const span = end - start
    const dir = path.join(where.dir, sanitizePath(series))
    let tier = span <= RAW_MAX_SPAN ? 'raw' : 'summary'
    let rows = tier === 'raw' ? readRaw(dir, series, start, end) : readSummary(dir, series, start, end)
    // Data recorded before summaries existed: fall back to full detail.
    if (tier === 'summary' && rows.length < 2 && span <= 31 * DAY) { tier = 'raw'; rows = readRaw(dir, series, start, end) }
    // An old period whose full detail has been removed (all or part of it):
    // the summaries are still there and cover more.
    else if (tier === 'raw' && custom) {
      const summary = readSummary(dir, series, start, end)
      const short = summary.length && (rows.length === 0 || rows[0][0] - summary[0][0] > 3600e3 || summary[summary.length - 1][0] - rows[rows.length - 1][0] > 3600e3)
      if (short) { tier = 'summary'; rows = summary }
    }
    const base = tier === 'raw' ? HEARTBEAT_MS : BUCKET_MS
    const out = { available: true, path: series, range: label, start, end, tier }
    if (rows.length <= TARGET_POINTS) return { ...out, points: rows.length, resolution: null, gapMs: Math.round(base * 1.6), data: rows }
    const b = bucketize(rows, start, end)
    return { ...out, points: b.data.length, resolution: b.resolution, gapMs: Math.round(Math.max(base * 1.6, b.resolution * 3)), data: b.data }
  }

  // Build ten-minute summaries for full-detail data that has none: history
  // recorded before summaries existed (February plugin), or buckets lost in a
  // crash. Only adds missing buckets; full-detail files are not touched.
  // Done once per series (marker file), so later starts cost one file check.
  function backfill (series, now = Date.now()) {
    const where = locate()
    if (!where.available) return { done: false, buckets: 0 }
    const sdir = path.join(where.dir, sanitizePath(series), SUMMARY_DIR)
    const marker = path.join(sdir, BACKFILL_MARKER)
    const dirs = rawDirs(where.dir, series)
    // Done before for these folders? (A folder added later is picked up.)
    const stamp = dirs.map(d => path.basename(d)).join('|')
    try { if (fs.readFileSync(marker, 'utf8').split('\n')[0] === stamp) return { done: false, buckets: 0 } } catch (_) {}
    const days = new Set()
    for (const d of dirs) for (const f of safeReaddir(d)) if (DAY_FILE.test(f)) days.add(f.slice(0, 10))
    if (!days.size) return { done: false, buckets: 0 } // nothing recorded yet: look again next start
    flush()
    const have = new Set()
    for (const d of dirs) {
      const sd = path.join(d, SUMMARY_DIR)
      for (const f of safeReaddir(sd)) if (f.endsWith('.csv')) for (const p of parse(path.join(sd, f), -Infinity, Infinity, 4)) have.add(p[0])
    }
    const open = Math.floor(now / BUCKET_MS) * BUCKET_MS // still being measured live
    const byMonth = new Map()
    let buckets = 0
    for (const day of [...days].sort()) {
      const rows = []
      for (const d of dirs) rows.push(...parse(path.join(d, `${day}.csv`), -Infinity, Infinity, 2))
      rows.sort((a, b) => a[0] - b[0])
      const aggs = new Map()
      let last = null
      for (const [t, v] of rows) {
        if (t === last) continue
        last = t
        const b = Math.floor(t / BUCKET_MS) * BUCKET_MS
        if (b >= open || have.has(b)) continue
        const a = aggs.get(b)
        if (!a) aggs.set(b, { min: v, max: v, sum: v, n: 1 })
        else { a.min = Math.min(a.min, v); a.max = Math.max(a.max, v); a.sum += v; a.n++ }
      }
      for (const b of [...aggs.keys()].sort((x, y) => x - y)) {
        const a = aggs.get(b)
        push(byMonth, monthKey(b), [b, round(a.min), round(a.sum / a.n), round(a.max)])
        buckets++
      }
    }
    try {
      for (const [month, rows] of byMonth) appendRows(path.join(sdir, `${month}.csv`), rows)
      fs.mkdirSync(sdir, { recursive: true })
      fs.writeFileSync(marker, `${stamp}\n${new Date(now).toISOString()} ${buckets}\n`)
    } catch (err) {
      log(`Trend backfill failed for ${series}: ${err.message}`)
      return { done: false, buckets: 0, error: err.message }
    }
    return { done: true, buckets, days: days.size }
  }

  function status () {
    const where = locate()
    const space = where.available ? spaceProvider(where.dir) : null
    return { ...where, retentionDays, summaryYears, pendingPaths: pending.size, freeBytes: space ? space.free : null, totalBytes: space ? space.total : null }
  }

  return { record, flush, close, purge, read, status, setAliases, backfill }
}

function safeReaddir (dir) {
  try { return fs.readdirSync(dir) } catch (_) { return [] }
}

module.exports = { createTrendStore, findStorageMount, sanitizePath, bucketize, RANGES, HEARTBEAT_MS, BUCKET_MS }
