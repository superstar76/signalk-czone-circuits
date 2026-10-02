'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findStorageMount, createTrendStore, bucketize, sanitizePath, HEARTBEAT_MS, BUCKET_MS } = require('../lib/monitor/storage')
const { buildCatalog, resolveCatalog } = require('../lib/monitor/catalog')
const { createMonitor } = require('../lib/monitor')

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name))

// --- SD detection: real Cerbo GX mount table (Feb 2026 handover). The eMMC is
//     mmcblk1; the SD card is mmcblk0p1 on /run/media/mmcblk0p1.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-'))
  const cerbo = [
    '/dev/mmcblk1p2 / ext4 rw 0 0',
    '/dev/mmcblk1p5 /data ext4 rw 0 0',
    `/dev/mmcblk0p1 ${tmp} vfat rw 0 0`
  ].join('\n')
  assert.strictEqual(findStorageMount(cerbo), tmp)
  assert.strictEqual(findStorageMount('/dev/mmcblk1p2 / ext4 rw 0 0\n/dev/mmcblk1p5 /data ext4 rw 0 0'), null)
}

// --- Store: batched write, read back, pending samples visible.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const store = createTrendStore({ directory: dir })
  const now = Math.floor(Date.now() / 600e3) * 600e3 + 300e3 // mid-bucket, so the three samples share one
  const series = 'electrical.batteries.2.voltage'
  store.record(series, 12.5, now - 120e3)
  store.record(series, 12.6, now - 60e3)
  store.record(series, 'n/a', now)
  assert.strictEqual(store.flush().written, 2)
  store.record(series, 12.7, now) // not flushed yet
  const r = store.read(series, '1h', now)
  assert.strictEqual(r.tier, 'raw')
  assert.deepStrictEqual(r.data.map(d => d[1]), [12.5, 12.6, 12.7])
  // Full-detail file layout unchanged from the February plugin.
  const file = path.join(dir, sanitizePath(series), `${new Date(now - 60e3).toISOString().slice(0, 10)}.csv`)
  assert(fs.readFileSync(file, 'utf8').startsWith(`${now - 120e3},12.5\n`))
  // Nothing is deleted by age unless asked for.
  const oldDir = path.join(dir, 'tanks.fuel.0.currentLevel')
  fs.mkdirSync(path.join(oldDir, 'summary'), { recursive: true })
  fs.writeFileSync(path.join(oldDir, '2020-01-01.csv'), '1,0.5\n')
  fs.writeFileSync(path.join(oldDir, 'summary', '2020-01.csv'), '0,0.5,0.5,0.5\n')
  assert.strictEqual(store.purge(now), 0)
  assert(fs.existsSync(path.join(oldDir, '2020-01-01.csv')))
  // With a limit: old full detail goes, the summary stays.
  const limited = createTrendStore({ directory: dir, retentionDays: 31 })
  assert.strictEqual(limited.purge(now), 1)
  assert(!fs.existsSync(path.join(oldDir, '2020-01-01.csv')))
  assert(fs.existsSync(path.join(oldDir, 'summary', '2020-01.csv')))
}

// --- Write on change: an unchanged value is stored at the start, just before
//     a change, and every 10 minutes; every sample still feeds the summary.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const store = createTrendStore({ directory: dir })
  const t0 = Date.UTC(2026, 8, 1, 12, 0, 0)
  // One hour at 10 s: constant 12.5, except one sample of 14 at 30 minutes.
  for (let i = 0; i < 360; i++) store.record('v', i === 180 ? 14 : 12.5, t0 + i * 10e3)
  store.close()
  const raw = fs.readFileSync(path.join(dir, 'v', '2026-09-01.csv'), 'utf8').trim().split('\n').map(l => l.split(',').map(Number))
  assert(raw.length <= 12, `write-on-change stored ${raw.length} rows for 360 samples`)
  assert.deepStrictEqual(raw[0], [t0, 12.5])
  // The step keeps its shape: last 12.5 before, the 14, the 12.5 after.
  const at = raw.findIndex(r => r[1] === 14)
  assert.deepStrictEqual([raw[at - 1], raw[at], raw[at + 1]], [[t0 + 179 * 10e3, 12.5], [t0 + 180 * 10e3, 14], [t0 + 181 * 10e3, 12.5]])
  // Unchanged stretches are never more than the heartbeat apart.
  for (let i = 1; i < raw.length; i++) assert(raw[i][0] - raw[i - 1][0] <= HEARTBEAT_MS)
  // Last sample is stored on close.
  assert.deepStrictEqual(raw[raw.length - 1], [t0 + 359 * 10e3, 12.5])
  // Summary: six 10-minute buckets, min/avg/max from all 60 samples each.
  const sum = fs.readFileSync(path.join(dir, 'v', 'summary', '2026-09.csv'), 'utf8').trim().split('\n').map(l => l.split(',').map(Number))
  assert.strictEqual(sum.length, 6)
  assert.deepStrictEqual(sum[0], [t0, 12.5, 12.5, 12.5])
  assert.deepStrictEqual(sum[3], [t0 + 3 * BUCKET_MS, 12.5, 12.525, 14])
  // Long ranges read the summary tier as [t, avg, min, max]; short ranges full detail.
  const now = t0 + 3600e3
  const week = store.read('v', '7d', now)
  assert.strictEqual(week.tier, 'summary')
  assert.deepStrictEqual(week.data[3], [t0 + 3 * BUCKET_MS, 12.525, 12.5, 14])
  assert.strictEqual(store.read('v', '24h', now).tier, 'raw')
  assert(week.gapMs >= BUCKET_MS)
}

// --- Custom period: any from/to; full detail up to 48 h, summaries beyond,
//     and summaries for an old period whose full detail has been removed.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const store = createTrendStore({ directory: dir })
  const t0 = Date.UTC(2026, 7, 1)
  for (let t = t0; t < t0 + 10 * 86400e3; t += 300e3) store.record('v', (t - t0) / 86400e3, t) // value = days since t0
  store.close()
  const now = t0 + 30 * 86400e3
  const day3 = store.read('v', { from: t0 + 3 * 86400e3, to: t0 + 4 * 86400e3 }, now)
  assert.strictEqual(day3.tier, 'raw')
  assert.strictEqual(day3.range, 'custom')
  assert.deepStrictEqual([day3.start, day3.end], [t0 + 3 * 86400e3, t0 + 4 * 86400e3])
  assert(day3.data.length > 100 && day3.data.every(r => r[0] >= day3.start && r[0] <= day3.end && r[1] >= 3 && r[1] <= 4))
  const week = store.read('v', { from: t0 + 2 * 86400e3, to: t0 + 9 * 86400e3 }, now)
  assert.strictEqual(week.tier, 'summary')
  assert(week.data.every(r => r[0] >= week.start && r[0] <= week.end && r[2] >= 2 && r[3] <= 9.01))
  assert.strictEqual(store.read('v', { from: t0 + 20 * 86400e3, to: t0 + 21 * 86400e3 }, now).data.length, 0) // nothing recorded then
  assert.strictEqual(store.read('v', { from: t0 + 2, to: t0 + 1 }, now).error, 'bad_range')
  assert.strictEqual(store.read('v', { from: 'x', to: t0 }, now).error, 'bad_range')
  // Full detail for day 3 removed (space guard): the same period still charts from summaries.
  fs.unlinkSync(path.join(dir, 'v', '2026-08-04.csv'))
  const again = store.read('v', { from: t0 + 3 * 86400e3, to: t0 + 4 * 86400e3 }, now)
  assert.strictEqual(again.tier, 'summary')
  assert(again.data.length >= 140)
}

// --- History from the February plugin (30 s rows, no summaries, folder named
//     after the bare path): read in place, summaries built once, originals untouched.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const old = path.join(dir, 'electrical.batteries.0.voltage')
  fs.mkdirSync(old)
  const t0 = Date.UTC(2026, 8, 26)
  for (let day = 0; day < 6; day++) {
    const rows = []
    for (let t = t0 + day * 86400e3; t < t0 + (day + 1) * 86400e3; t += 30e3) rows.push(`${t},${12 + day + (t % 3600e3 === 0 ? 1 : 0)}`)
    fs.writeFileSync(path.join(old, `${new Date(t0 + day * 86400e3).toISOString().slice(0, 10)}.csv`), rows.join('\n') + '\n')
  }
  const before = fs.readdirSync(old).map(f => fs.readFileSync(path.join(old, f), 'utf8'))
  const now = t0 + 6 * 86400e3 + 5 * 60e3
  const series = 'electrical.batteries.0.voltage@czone-04' // the new name for the same meter
  const store = createTrendStore({ directory: dir })
  store.setAliases(new Map([[series, ['electrical.batteries.0.voltage']]]))
  // Full detail is there straight away…
  const day = store.read(series, { from: t0 + 86400e3, to: t0 + 2 * 86400e3 - 1 }, now)
  assert.strictEqual(day.tier, 'raw')
  assert(day.data.length > 100 && day.data.every(r => r[1] >= 13 && r[1] <= 14))
  // …long ranges after the summaries are built.
  const r = store.backfill(series, now)
  assert.deepStrictEqual([r.done, r.buckets, r.days], [true, 6 * 144, 6])
  const week = store.read(series, '7d', now)
  assert.strictEqual(week.tier, 'summary')
  assert(week.points <= 400 && week.points > 300)
  assert.strictEqual(Math.min(...week.data.map(d => d[2])), 12)
  assert.strictEqual(Math.max(...week.data.map(d => d[3])), 18) // the hourly +1 spikes survive
  const sum = fs.readFileSync(path.join(dir, sanitizePath(series), 'summary', '2026-09.csv'), 'utf8').trim().split('\n')
  assert.strictEqual(sum.length, 5 * 144)
  assert.strictEqual(sum[0], `${t0},12,12.05,13`) // 20 samples, one of them 13
  // Once only, and the February files are exactly as they were.
  assert.strictEqual(store.backfill(series, now).done, false)
  assert.deepStrictEqual(fs.readdirSync(old).map(f => fs.readFileSync(path.join(old, f), 'utf8')), before)
  // New samples carry on in the new folder; buckets already summarised are not redone.
  store.record(series, 20, now)
  store.close()
  assert(fs.existsSync(path.join(dir, sanitizePath(series), '2026-10-02.csv')))
  assert.strictEqual(store.read(series, '1h', now + 60e3).data.slice(-1)[0][1], 20)
}

// --- Backfill fills only what is missing: live summaries are kept, the bucket
//     still being measured is left alone, a series with no data is retried later.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const store = createTrendStore({ directory: dir })
  assert.strictEqual(store.backfill('v', Date.UTC(2026, 8, 2)).done, false) // nothing recorded yet
  const t0 = Date.UTC(2026, 8, 1, 12)
  fs.mkdirSync(path.join(dir, 'v', 'summary'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'v', '2026-09-01.csv'), [0, 1, 2, 3].map(i => `${t0 + i * 600e3 + 1000},${i}`).join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'v', 'summary', '2026-09.csv'), `${t0 + 600e3},9,9,9\n`) // bucket 1 summarised live
  const r = store.backfill('v', t0 + 3 * 600e3 + 5000) // bucket 3 is still open
  assert.deepStrictEqual([r.done, r.buckets], [true, 2])
  const rows = fs.readFileSync(path.join(dir, 'v', 'summary', '2026-09.csv'), 'utf8').trim().split('\n')
  assert.deepStrictEqual(rows, [`${t0 + 600e3},9,9,9`, `${t0},0,0,0`, `${t0 + 2 * 600e3},2,2,2`])
}

// --- A year of summaries comes back as a few hundred points with the extremes kept.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const store = createTrendStore({ directory: dir })
  const now = Date.UTC(2026, 8, 1)
  for (let t = now - 60 * 86400e3; t < now; t += 600e3) store.record('v', t === now - 30 * 86400e3 ? 99 : 12, t)
  store.close()
  const r = store.read('v', '1y', now)
  assert.strictEqual(r.tier, 'summary')
  assert(r.points <= 400 && r.points > 20)
  assert.strictEqual(Math.max(...r.data.map(d => d[3])), 99)
}

// --- Space guard: when the volume is low, oldest full-detail days go first,
//     summaries only when no old full detail is left; today's data is kept.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const now = Date.UTC(2026, 8, 10, 12)
  const s = path.join(dir, 'v')
  fs.mkdirSync(path.join(s, 'summary'), { recursive: true })
  for (const day of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']) fs.writeFileSync(path.join(s, `${day}.csv`), '1,1\n')
  for (const month of ['2026-07', '2026-08', '2026-09']) fs.writeFileSync(path.join(s, 'summary', `${month}.csv`), '1,1,1,1\n')
  const total = 16e9
  let free = 0
  const files = () => fs.readdirSync(s).filter(f => f.endsWith('.csv')).concat(fs.readdirSync(path.join(s, 'summary')).map(f => `summary/${f}`)).sort()
  // Each deleted file "frees" 100 MB; the shared-disk reserve is 10% = 1.6 GB.
  const store = createTrendStore({ directory: dir, spaceProvider: () => ({ free: free + (7 - files().length) * 100e6, total }) })
  free = 1.7e9
  assert.strictEqual(store.purge(now), 0) // enough room: nothing touched
  free = 1.45e9 // 150 MB short: two oldest days
  assert.strictEqual(store.purge(now), 2)
  assert.deepStrictEqual(files(), ['2026-09-09.csv', '2026-09-10.csv', 'summary/2026-07.csv', 'summary/2026-08.csv', 'summary/2026-09.csv'])
  free = 1.2e9 // still short after all old full detail: one summary month too
  store.purge(now)
  assert.deepStrictEqual(files(), ['2026-09-10.csv', 'summary/2026-08.csv', 'summary/2026-09.csv'])
  free = 0 // hopeless: current day and month still survive
  store.purge(now)
  assert.deepStrictEqual(files(), ['2026-09-10.csv', 'summary/2026-09.csv'])
}

// --- Storage by platform: off a GX, trends default to Signal K's data folder;
//     on a GX the data folder (internal flash) is never used.
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'skdata-'))
  const noCard = () => '/dev/mmcblk1p2 / ext4 rw 0 0'
  const pi = createTrendStore({ fallbackDir: data, isVenus: false, mountsProvider: noCard })
  pi.record('x', 1)
  assert.strictEqual(pi.flush().written, 1)
  assert.strictEqual(pi.status().location, 'data_dir')
  assert(fs.existsSync(path.join(data, 'trends', 'x')))
  const gx = createTrendStore({ fallbackDir: data, isVenus: true, mountsProvider: noCard })
  assert.strictEqual(gx.status().reason, 'no_sd_card')
}

// --- Bucketing keeps long ranges to a few hundred points.
{
  const data = Array.from({ length: 2880 }, (_, i) => [i * 30e3, i])
  const b = bucketize(data, 0, 2880 * 30e3)
  assert(b.data.length <= 400)
  assert.deepStrictEqual(b.data[0].slice(1), [3.5, 0, 7]) // avg, min, max of the first 8 samples
}

// --- No SD card: trending reported unavailable, nothing written or kept.
{
  const store = createTrendStore({ isVenus: true, fallbackDir: os.tmpdir(), mountsProvider: () => '/dev/mmcblk1p2 / ext4 rw 0 0' })
  for (let i = 0; i < 100; i++) store.record('x', i, 1e12 + i * 10e3)
  assert.strictEqual(store.status().pendingPaths, 1)
  const f = store.flush()
  assert.strictEqual(f.available, false)
  assert.strictEqual(f.reason, 'no_sd_card')
  assert.strictEqual(store.status().pendingPaths, 0)
  assert.strictEqual(store.read('x').available, false)
}

// --- Catalogue: Compass Rose (Configuration Tool ground truth).
{
  const { items, warnings } = buildCatalog(fixture('Compass-Rose-28.06.26.zcf'))
  assert.deepStrictEqual(warnings, [])
  const byName = Object.fromEntries(items.map(i => [i.name, i]))
  assert.strictEqual(byName['House Battery'].readings[0].candidates[0], 'electrical.batteries.0.voltage')
  assert.strictEqual(byName['Fuel Level'].readings[0].candidates[0], 'tanks.fuel.0.currentLevel')
  assert.strictEqual(byName['Atmospheric Pressure'].readings[0].candidates[0], 'environment.outside.pressure')
  assert.strictEqual(byName['Fridge Temperature'].group, 'Temperatures')
  assert.strictEqual(byName['Anchor Up'].group, 'Inputs')
  assert.strictEqual(byName['Anchor Light'].readings[0].candidates[0], 'electrical.czone.Anchor_Light.current')
  // Resolution picks the first candidate that has a value.
  const values = { 'electrical.batteries.0.voltage': 13.1, 'electrical.batteries.0.stateOfCharge': 0.8 }
  const resolved = resolveCatalog(items, p => values[p])
  const hb = resolved.find(i => i.name === 'House Battery')
  assert.strictEqual(hb.mapped, true)
  assert.strictEqual(hb.readings.find(r => r.key === 'soc').path, 'electrical.batteries.0.stateOfCharge')
}

// --- Catalogue: TestBench wired meter uses its ZCF instance, source-filtered
//     to the Meter Interface (module 0x04).
{
  const { items } = buildCatalog(fixture('TestBench.zcf'))
  const hb = items.find(i => i.name === 'House Battery')
  assert.strictEqual(hb.readings[0].candidates[0], 'electrical.batteries.0.voltage')
  assert(hb.readings.every(r => r.sourceModule === 4))
  assert.deepStrictEqual(items.filter(i => i.group === 'Circuit current').map(i => i.name),
    ['Buzzer', 'Light 1', 'Light 2', 'Light 3', 'Light 4', 'Light 5'])
}

// Three days of 30 s rows ending an hour ago, as the February plugin wrote them.
function writeFebruary (folder, value) {
  fs.mkdirSync(folder, { recursive: true })
  const end = Math.floor(Date.now() / 600e3) * 600e3 - 3600e3
  const byDay = new Map()
  for (let t = end - 3 * 86400e3; t < end; t += 30e3) { const k = new Date(t).toISOString().slice(0, 10); byDay.set(k, (byDay.get(k) || '') + `${t},${value}\n`) }
  for (const [k, text] of byDay) fs.writeFileSync(path.join(folder, `${k}.csv`), text)
  return end
}

// --- A meter wired to a CZone module is recorded as "<path>@czone-<module>";
//     February history under the bare path is still found for it.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench.zcf'), zcfFile)
  const monitor = createMonitor({ getSelfPath: () => undefined, debug: () => {} })
  monitor.start({ trendDirectory: path.join(dir, 'trends') }, zcfFile)
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  const call = (p, query = {}) => { let out; routes[p]({ query }, { json: v => { out = v } }); return out }
  writeFebruary(path.join(dir, 'trends', 'electrical.batteries.0.voltage'), 12.4)
  const house = call('/monitor/items').items.find(i => i.name === 'House Battery').readings.find(r => r.key === 'voltage')
  assert.strictEqual(house.series, null) // not live
  assert.strictEqual(house.history, 'electrical.batteries.0.voltage@czone-04')
  assert.strictEqual(monitor.backfillTrends().buckets, 3 * 144)
  const week = call('/trend', { path: house.history, range: '7d' })
  assert.strictEqual(week.tier, 'summary')
  assert(week.points > 150 && week.data.every(d => d[1] === 12.4))
  assert(fs.existsSync(path.join(dir, 'trends', 'electrical.batteries.0.voltage_czone-04', 'summary')))
  monitor.stop()
}

// --- End to end: fake Signal K, monitor samples and serves routes.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'Compass-Rose-28.06.26.zcf'), zcfFile)
  const sk = { 'electrical.batteries.0.voltage': { value: 13.2 }, 'tanks.fuel.0.currentLevel': { value: 0.42 } }
  const app = { getSelfPath: p => sk[p], debug: () => {} }
  const monitor = createMonitor(app)
  monitor.start({ trendDirectory: path.join(dir, 'trends') }, zcfFile)
  monitor.sample()
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  const call = (p, query = {}) => { let out; routes[p]({ query }, { json: v => { out = v }, status: () => ({ json: v => { out = v } }) }); return out }
  const items = call('/monitor/items')
  assert.strictEqual(items.total, 47)
  assert.strictEqual(items.mapped, 2)
  assert.deepStrictEqual(call('/monitor/values').values, { 'electrical.batteries.0.voltage': 13.2, 'tanks.fuel.0.currentLevel': 0.42 })
  const trend = call('/trend', { path: 'tanks.fuel.0.currentLevel', range: '1h' })
  assert.deepStrictEqual(trend.data.map(d => d[1]), [0.42])
  assert.strictEqual(call('/trend/status').available, true)
  assert.strictEqual(call('/trend/status').sampleSeconds, 10) // default
  { // Compass Rose: February history sits in a folder of the same name (virtual meter, bare path)
    const end = writeFebruary(path.join(dir, 'trends', 'electrical.batteries.0.voltage'), 12.4)
    const house = call('/monitor/items').items.find(i => i.name === 'House Battery').readings.find(r => r.key === 'voltage')
    assert.strictEqual(house.history, 'electrical.batteries.0.voltage')
    assert.strictEqual(call('/trend', { path: house.history, from: String(end - 86400e3), to: String(end) }).tier, 'raw') // readable at once
    const b = monitor.backfillTrends()
    assert.deepStrictEqual([b.state, b.series, b.buckets], ['done', 1, 3 * 144])
    const week = call('/trend', { path: house.history, range: '7d' })
    assert.strictEqual(week.tier, 'summary')
    assert(week.data.filter(d => d[1] === 12.4).length > 150)
    assert.strictEqual(call('/trend/status').backfill.state, 'done')
  }
  { // history under an unrelated name (Venus/VRM instance path): mapped in aliases.json
    writeFebruary(path.join(dir, 'trends', 'electrical.batteries.239.current'), -6.5)
    const cur = 'electrical.batteries.0.current'
    assert.strictEqual(call('/trend', { path: cur, range: '7d' }).data.length, 0)
    fs.writeFileSync(path.join(dir, 'trends', 'aliases.json'), JSON.stringify({ [cur]: ['electrical.batteries.239.current'] }))
    assert.strictEqual(monitor.backfillTrends().buckets, 3 * 144)
    const week = call('/trend', { path: cur, range: '7d' })
    assert.strictEqual(week.tier, 'summary')
    assert(week.points > 150 && week.data.every(d => d[1] === -6.5))
    assert.strictEqual(call('/trend/status').aliases.file, 1)
    // …and it holds for the reading's other paths too (State of charge has two).
    writeFebruary(path.join(dir, 'trends', 'electrical.batteries.239.capacity.stateOfCharge'), 0.85)
    fs.writeFileSync(path.join(dir, 'trends', 'aliases.json'), JSON.stringify({ [cur]: ['electrical.batteries.239.current'], 'electrical.batteries.0.capacity.stateOfCharge': ['electrical.batteries.239.capacity.stateOfCharge'] }))
    monitor.backfillTrends() // the mapping file is read at start and again here
    assert(call('/trend', { path: 'electrical.batteries.0.stateOfCharge', from: String(Date.now() - 2 * 86400e3), to: String(Date.now()) }).data.length > 100)
    // The Signal K path the February plugin used for a sensor is found without a mapping.
    writeFebruary(path.join(dir, 'trends', 'environment.inside.engineRoom.temperature'), 301.15)
    monitor.backfillTrends()
    const er = call('/trend', { path: 'environment.inside.engineRoom.2.temperature', range: '7d' })
    assert(er.points > 150 && er.data.every(d => d[1] === 301.15))
    // A broken mapping file is reported, not fatal.
    fs.writeFileSync(path.join(dir, 'trends', 'aliases.json'), '{ not json')
    monitor.backfillTrends()
    assert(call('/trend/status').aliases.error)
    assert(call('/trend', { path: 'environment.inside.engineRoom.2.temperature', range: '7d' }).points > 150)
  }
  { // every reading says where its history is, live or not
    const all = call('/monitor/items').items.flatMap(i => i.readings).filter(r => r.candidates.length)
    assert(all.length > 0 && all.every(r => typeof r.history === 'string'))
    assert(all.filter(r => r.series).every(r => r.history === r.series))
  }
  { // custom period on the route
    const to = Date.now()
    const r = call('/trend', { path: 'electrical.batteries.0.voltage', from: String(to - 3600e3), to: String(to) })
    assert.strictEqual(r.range, 'custom')
    assert.deepStrictEqual([r.start, r.end], [to - 3600e3, to])
    assert.strictEqual(call('/trend', { path: 'x', from: '5', to: '1' }).error, 'bad_range')
  }
  monitor.stop()
  monitor.start({ trendDirectory: path.join(dir, 'trends'), trendSampleSeconds: 30 }, zcfFile)
  assert.strictEqual(call('/trend/status').sampleSeconds, 30)
  monitor.start({ trendDirectory: path.join(dir, 'trends'), trendSampleSeconds: 7 }, zcfFile) // not offered: default
  assert.strictEqual(call('/trend/status').sampleSeconds, 10)
  monitor.stop()
  assert(fs.readdirSync(path.join(dir, 'trends')).includes('tanks.fuel.0.currentLevel'))
}

// --- Source filtering: two devices publish electrical.batteries.0 (bench,
//     1 Oct 2026). The wired meter must read the Meter Interface only.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench.zcf'), zcfFile)
  const sk = {
    'electrical.batteries.0.voltage': {
      value: 11.93, $source: 'n2k-on-ve.can-socket.224',
      values: { 'n2k-on-ve.can-socket.224': { value: 11.93 }, 'n2k-on-ve.can-socket.9': { value: 11.84 } }
    }
  }
  const monitor = createMonitor({ getSelfPath: p => sk[p], debug: () => {} })
  monitor.start({ trendDirectory: path.join(dir, 'trends') }, zcfFile)
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  const call = p => { let out; routes[p]({ query: {} }, { json: v => { out = v } }); return out }
  // Source not learned yet: not mapped rather than taking the Cerbo's value.
  assert.strictEqual(call('/monitor/items').items.find(i => i.name === 'House Battery').mapped, false)
  // Meter Interface status frame from source 9: "27 99 04 0E …".
  monitor.learnModuleSource('10:00:00.000 R 1CFF0409 27 99 04 0E 00 00 00 00')
  assert.deepStrictEqual(call('/monitor/modules').modules, { '0x04': 9 })
  const hb = call('/monitor/items').items.find(i => i.name === 'House Battery')
  assert.strictEqual(hb.readings[0].value, 11.84)
  assert.strictEqual(hb.readings[0].series, 'electrical.batteries.0.voltage@czone-04')
  monitor.stop()
}

// --- getSelfPath without per-source values (plugin API): the live delta
//     stream supplies them.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench.zcf'), zcfFile)
  let emit = null
  const app = {
    getSelfPath: p => (p === 'electrical.batteries.0.voltage' ? { value: 11.93, $source: 'n2k-on-ve.can-socket.224' } : undefined),
    streambundle: { getSelfBus: () => ({ onValue: fn => { emit = fn; return () => { emit = null } } }) },
    debug: () => {}
  }
  const monitor = createMonitor(app)
  monitor.start({ trendDirectory: path.join(dir, 'trends') }, zcfFile)
  monitor.learnModuleSource('10:00:00.000 R 1CFF0409 27 99 04 0E 00 00 00 00')
  emit({ path: 'electrical.batteries.0.voltage', value: 11.93, $source: 'n2k-on-ve.can-socket.224' })
  emit({ path: 'electrical.batteries.0.voltage', value: 11.84, $source: 'n2k-on-ve.can-socket.9' })
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  let out
  routes['/monitor/items']({ query: {} }, { json: v => { out = v } })
  assert.strictEqual(out.items.find(i => i.name === 'House Battery').readings[0].value, 11.84)
  routes['/monitor/debug']({ query: { path: 'electrical.batteries.0.voltage' } }, { json: v => { out = v } })
  assert.deepStrictEqual(out.stream, { 'n2k-on-ve.can-socket.224': 11.93, 'n2k-on-ve.can-socket.9': 11.84 })
  monitor.stop()
  assert.strictEqual(emit, null)
}

// --- Circuit current from PGN 130822 (SugarShack, 27 Sep 2026 log): module
//     0x14 page 1 slot 7 = COI channel 15 = Starlink, 0x1F = 3.1 A.
{
  const { decodeCurrentPacket } = require('../lib/monitor/currents')
  const hex = '2799140100000400000400e80700e80700e80700000400000400e807'
  const d = decodeCurrentPacket(130822, Buffer.from(hex.slice(0, 50) + '1fe807', 'hex'))
  assert.strictEqual(d.module, 0x14)
  assert.strictEqual(d.slots[7].channel, 15)
  assert.strictEqual(d.slots[7].amps, 3.1)
  // Bench Output Interface: current byte 1 on an OFF output (level 0x0400) reads 0 A.
  const bench = decodeCurrentPacket(130817, Buffer.from('27990001' + '010004' + '01e807' + '0100e8'.repeat(6), 'hex'))
  assert.strictEqual(bench.slots[0].amps, 0)
  assert.strictEqual(bench.slots[1].amps, 0.1)
  // 130817 carries page before module (bench Output Interface 0x01).
  assert.strictEqual(decodeCurrentPacket(130817, Buffer.from('27990001' + '0100e8'.repeat(8), 'hex')).module, 0x01)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cur-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'SugarShack-20260927-01.zcf'), zcfFile)
  const published = []
  const app = { handleMessage: (id, delta) => published.push(...delta.updates[0].values), debug: () => {} }
  const monitor = createMonitor(app)
  monitor.start({ trendDirectory: path.join(dir, 'trends') }, zcfFile)
  // Fast packet as canboatjs raw lines: 1DFF0614 = PGN 130822 from source 0x14.
  const payload = Buffer.from(hex.slice(0, 50) + '1fe807', 'hex')
  const frames = [Buffer.concat([Buffer.from([0x40, 28]), payload.subarray(0, 6)])]
  for (let o = 6, n = 1; o < 28; o += 7, n++) {
    const chunk = Buffer.alloc(7, 0xff); payload.subarray(o, o + 7).copy(chunk)
    frames.push(Buffer.concat([Buffer.from([0x40 | n]), chunk]))
  }
  for (const f of frames) monitor.onRawFrame(`10:00:00.000 R 1DFF0614 ${[...f].map(b => b.toString(16).padStart(2, '0')).join(' ')}`)
  const starlink = published.find(v => v.path === 'electrical.czone.Starlink.current')
  assert(starlink, 'Starlink current published')
  assert.strictEqual(starlink.value, 3.1)
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  let out
  routes['/monitor/items']({ query: {} }, { json: v => { out = v } })
  assert.strictEqual(out.items.find(i => i.name === 'Starlink').readings[0].value, 3.1)
  monitor.stop()
}

// --- Sensors straight off the bus (bench ZCF 1 Oct 2026): Ruuvi Tag =
//     temperature instance 102 source 2, Victron Temp Sensor = instance 101
//     source 1. A virtual meter must ignore values a CZone module publishes on
//     the same Signal K path (here: Victron Shunt, instance 2, with a Meter
//     Interface value on electrical.batteries.2).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sens-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench-2026-10-01.zcf'), zcfFile)
  const sk = {
    'electrical.batteries.2.voltage': {
      value: 5.02, $source: 'n2k-on-ve.can-socket.9',
      values: { 'n2k-on-ve.can-socket.9': { value: 5.02 }, 'n2k-on-ve.can-socket.224': { value: 13.31 } }
    },
    'electrical.batteries.1.voltage': { value: 5.02, $source: 'n2k-on-ve.can-socket.9' }
  }
  const monitor = createMonitor({ getSelfPath: p => sk[p], debug: () => {} })
  monitor.start({ trendDirectory: path.join(dir, 'trends') }, zcfFile)
  monitor.learnModuleSource('10:00:00.000 R 1CFF0409 27 99 04 0E 00 00 00 00')
  // 130312 (0x1FD08) from 0xE0: SID 0, instance 102, source 2, 295.15 K
  monitor.onRawFrame('10:00:01.000 R 15FD08E0 00 66 02 4B 73 FF FF FF')
  // 130316 (0x1FD0C): instance 101, source 1, 288.150 K
  monitor.onRawFrame('10:00:01.000 R 15FD0CE0 00 65 01 96 65 04 FF FF')
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  let out
  routes['/monitor/items']({ query: {} }, { json: v => { out = v } })
  const by = Object.fromEntries(out.items.map(i => [i.name, i]))
  assert.strictEqual(by['Ruuvi Tag'].readings[0].value, 295.15)
  assert.strictEqual(by['Victron Temp Sensor'].readings[0].value, 288.15)
  assert.strictEqual(by['Victron Shunt'].readings[0].value, 13.31)
  assert.strictEqual(by['5V System - MI'].readings[0].value, 5.02)
  // AC from the Meter Interface (source 9): PGN 127747 / 127744, bench frames.
  monitor.onRawFrame('10:00:02.000 R 19F30309 08 00 3F 09 FF FF F4 01')
  monitor.onRawFrame('10:00:02.000 R 19F30309 07 01 12 09 FF FF F4 01')
  monitor.onRawFrame('10:00:02.000 R 19F30009 08 00 00 00 09 00 00 00')
  // Same instance from another device is ignored for a wired meter.
  monitor.onRawFrame('10:00:02.000 R 19F303E0 08 00 10 27 FF FF F4 01')
  routes['/monitor/items']({ query: {} }, { json: v => { out = v } })
  const ac = name => Object.fromEntries(out.items.find(i => i.name === name).readings.map(r => [r.key, r.value]))
  assert.deepStrictEqual(ac('Power In'), { voltage: 236.7, current: 0, power: 9, frequency: 50 })
  assert.deepStrictEqual([ac('Power Out').voltage, ac('Power Out').frequency], [232.2, 50])
  monitor.stop()
}

// --- Wire listener: candump output (format as on the bench) reaches the
//     sensor decoder. A stand-in candump script replays two bench lines.
{
  const { parseCandumpLine } = require('../lib/monitor/wire')
  assert.strictEqual(parseCandumpLine('  vecan0  09FD0C65   [8]  FF 66 02 C4 96 04 FF FF'), '0 R 09FD0C65 FF 66 02 C4 96 04 FF FF')
  assert.strictEqual(parseCandumpLine('garbage'), null)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'candump'), [
    '#!/bin/sh',
    'echo "  vecan0  09FD0C65   [8]  FF 66 02 C4 96 04 FF FF"',
    'echo "  vecan0  09FD0865   [8]  FF 65 01 AB 74 FF FF FF"',
    // 127508 instance 2: 13.27 V, -2.5 A; 127506 first frame instance 2, SoC 87 %
    'echo "  vecan0  0DF21465   [8]  02 2F 05 E7 FF FF FF 00"',
    'echo "  vecan0  0DF21265   [8]  20 0B 00 02 00 57 64 FF"',
    'exec sleep 2', ''].join('\n'), { mode: 0o755 })
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench-2026-10-01.zcf'), zcfFile)
  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath}`
  const monitor = createMonitor({ getSelfPath: () => undefined, debug: () => {} })
  monitor.start({ trendDirectory: path.join(dir, 'trends') }, zcfFile)
  process.env.PATH = oldPath
  const routes = {}
  monitor.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  setTimeout(() => {
    let out
    routes['/monitor/items']({ query: {} }, { json: v => { out = v } })
    const by = Object.fromEntries(out.items.map(i => [i.name, i]))
    assert.strictEqual(by['Ruuvi Tag'].readings[0].value, 300.74)
    assert.strictEqual(by['Victron Temp Sensor'].readings[0].value, 298.67)
    const shunt = Object.fromEntries(by['Victron Shunt'].readings.map(r => [r.key, r.value]))
    assert.deepStrictEqual([shunt.voltage, shunt.current, shunt.soc], [13.27, -2.5, 0.87])
    monitor.stop()
    console.log('Monitor wire tests passed')
  }, 500)
}

console.log('Monitor tests passed')
