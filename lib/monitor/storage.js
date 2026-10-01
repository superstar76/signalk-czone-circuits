'use strict'

// Trend storage on a removable SD card, ported from the February 2026
// "CZone Control" plugin. The on-card format is unchanged so existing trend
// files carry over:
//
//   <mount>/signalk-czone/trends/<path_with_unsafe_chars_replaced>/<YYYY-MM-DD>.csv
//   one "timestamp_ms,value" line per sample
//
// Where trends go:
//   - trendDirectory setting, if given (any platform)
//   - Venus OS (GX): removable storage only (SD card or USB stick). The GX's
//     internal flash (/data) is never written; without a card, trending is off.
//   - anywhere else (Pi with SSD, Ubuntu, …): Signal K's plugin data folder.

const fs = require('fs')
const path = require('path')

const TREND_SUBDIR = path.join('signalk-czone', 'trends')
const SYSTEM_PATHS = new Set(['/', '/data', '/boot', '/run', '/tmp', '/var', '/proc', '/sys', '/dev'])
const RANGES = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '31d': 31 * 86400e3 }
const DOWNSAMPLE_TARGET = { '1h': 0, '24h': 300, '7d': 350, '31d': 400 }

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

function downsample (data, range) {
  const target = DOWNSAMPLE_TARGET[range] || 0
  if (!target || data.length <= target) return data
  const size = Math.ceil(data.length / target)
  const out = []
  for (let i = 0; i < data.length; i += size) {
    const bucket = data.slice(i, i + size)
    const t = Math.round(bucket.reduce((s, d) => s + d[0], 0) / bucket.length)
    const v = bucket.reduce((s, d) => s + d[1], 0) / bucket.length
    out.push([t, Math.round(v * 1000) / 1000])
  }
  return out
}

function createTrendStore (options = {}) {
  const retentionDays = Number(options.retentionDays) > 0 ? Number(options.retentionDays) : 31
  const mountsProvider = options.mountsProvider || readMounts
  const overrideDir = options.directory || null
  const isVenus = options.isVenus !== undefined ? options.isVenus : isVenusOs()
  const fallbackDir = options.fallbackDir || null
  const log = options.log || (() => {})
  const pending = new Map() // path -> [[t, v], ...]

  function locate () {
    if (overrideDir) {
      try { fs.mkdirSync(overrideDir, { recursive: true }) } catch (_) {}
      return isWritable(overrideDir)
        ? { available: true, dir: overrideDir, mount: overrideDir }
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
        detail: `SD card found at ${mount} but Signal K cannot write to it. Remount it rw,umask=0000 at boot (see /data/rc.local).`
      }
    }
    return { available: true, dir, mount }
  }

  function record (skPath, value, t = Date.now()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    if (!pending.has(skPath)) pending.set(skPath, [])
    pending.get(skPath).push([t, value])
  }

  function flush () {
    if (pending.size === 0) return { written: 0 }
    const where = locate()
    if (!where.available) { pending.clear(); return { written: 0, ...where } }
    let written = 0
    for (const [skPath, rows] of pending) {
      const byDay = new Map()
      for (const [t, v] of rows) {
        const key = dateKey(t)
        if (!byDay.has(key)) byDay.set(key, [])
        byDay.get(key).push(`${t},${v}`)
      }
      const dir = path.join(where.dir, sanitizePath(skPath))
      try {
        fs.mkdirSync(dir, { recursive: true })
        for (const [day, lines] of byDay) {
          fs.appendFileSync(path.join(dir, `${day}.csv`), lines.join('\n') + '\n')
          written += lines.length
        }
      } catch (err) {
        log(`Trend write failed for ${skPath}: ${err.message}`)
      }
    }
    pending.clear()
    return { written, dir: where.dir }
  }

  function purge (now = Date.now()) {
    const where = locate()
    if (!where.available) return 0
    const cutoff = dateKey(now - retentionDays * 86400e3)
    let removed = 0
    for (const sub of safeReaddir(where.dir)) {
      const dir = path.join(where.dir, sub)
      if (!isDirectory(dir)) continue
      for (const file of safeReaddir(dir)) {
        if (file.endsWith('.csv') && file.slice(0, 10) < cutoff) {
          try { fs.unlinkSync(path.join(dir, file)); removed++ } catch (_) {}
        }
      }
      if (safeReaddir(dir).length === 0) { try { fs.rmdirSync(dir) } catch (_) {} }
    }
    return removed
  }

  function read (skPath, range = '24h', now = Date.now()) {
    const where = locate()
    if (!where.available) return { available: false, reason: where.reason, detail: where.detail, data: [] }
    const span = RANGES[range] || RANGES['24h']
    const start = now - span
    const dir = path.join(where.dir, sanitizePath(skPath))
    const data = []
    for (let d = new Date(dateKey(start)).getTime(); d <= now; d += 86400e3) {
      const file = path.join(dir, `${dateKey(d)}.csv`)
      let text
      try { text = fs.readFileSync(file, 'utf8') } catch (_) { continue }
      for (const line of text.split('\n')) {
        const comma = line.indexOf(',')
        if (comma < 0) continue
        const t = Number(line.slice(0, comma))
        const v = Number(line.slice(comma + 1))
        if (t >= start && t <= now && Number.isFinite(v)) data.push([t, v])
      }
    }
    // Include samples not yet flushed so the chart is current.
    for (const [t, v] of pending.get(skPath) || []) if (t >= start) data.push([t, v])
    data.sort((a, b) => a[0] - b[0])
    const points = downsample(data, range)
    return { available: true, path: skPath, range, points: points.length, data: points }
  }

  function status () {
    const where = locate()
    return { ...where, retentionDays, pendingPaths: pending.size }
  }

  return { record, flush, purge, read, status }
}

function safeReaddir (dir) {
  try { return fs.readdirSync(dir) } catch (_) { return [] }
}

module.exports = { createTrendStore, findStorageMount, sanitizePath, downsample, RANGES }
