'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findStorageMount, createTrendStore, downsample, sanitizePath } = require('../lib/monitor/storage')
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

// --- Store: batched write, read back, pending samples visible, retention.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'))
  const store = createTrendStore({ directory: dir, retentionDays: 31 })
  const now = Date.now()
  store.record('electrical.batteries.2.voltage', 12.5, now - 120e3)
  store.record('electrical.batteries.2.voltage', 12.6, now - 60e3)
  store.record('electrical.batteries.2.voltage', 'n/a', now)
  assert.strictEqual(store.flush().written, 2)
  store.record('electrical.batteries.2.voltage', 12.7, now) // not flushed yet
  const r = store.read('electrical.batteries.2.voltage', '1h', now)
  assert.deepStrictEqual(r.data.map(d => d[1]), [12.5, 12.6, 12.7])
  // File layout unchanged from the February plugin.
  const file = path.join(dir, sanitizePath('electrical.batteries.2.voltage'), `${new Date(now - 60e3).toISOString().slice(0, 10)}.csv`)
  assert(fs.readFileSync(file, 'utf8').startsWith(`${now - 120e3},12.5\n`))
  // Retention removes old day files.
  const oldDir = path.join(dir, 'tanks.fuel.0.currentLevel')
  fs.mkdirSync(oldDir, { recursive: true })
  fs.writeFileSync(path.join(oldDir, '2020-01-01.csv'), '1,0.5\n')
  assert.strictEqual(store.purge(now), 1)
  assert(!fs.existsSync(oldDir))
}

// --- Downsampling keeps long ranges to a few hundred points.
{
  const data = Array.from({ length: 2880 }, (_, i) => [i * 30e3, i])
  assert(downsample(data, '24h').length <= 300)
  assert.strictEqual(downsample(data, '1h').length, 2880)
}

// --- No SD card: trending reported unavailable, nothing written anywhere.
{
  const store = createTrendStore({ mountsProvider: () => '/dev/mmcblk1p2 / ext4 rw 0 0' })
  store.record('x', 1)
  const f = store.flush()
  assert.strictEqual(f.available, false)
  assert.strictEqual(f.reason, 'no_sd_card')
  assert.strictEqual(store.read('x').available, false)
}

// --- Catalogue: Compass Rose (Configuration Tool ground truth).
{
  const { items, warnings } = buildCatalog(fixture('Compass-Rose-28.06.26.zcf'))
  assert.deepStrictEqual(warnings, [])
  const byName = Object.fromEntries(items.map(i => [i.name, i]))
  assert.strictEqual(byName['House Battery'].readings[0].candidates[0], 'electrical.batteries.1.voltage')
  assert.strictEqual(byName['Fuel Level'].readings[0].candidates[0], 'tanks.fuel.0.currentLevel')
  assert.strictEqual(byName['Atmospheric Pressure'].readings[0].candidates[0], 'environment.outside.pressure')
  assert.strictEqual(byName['Fridge Temperature'].group, 'Temperatures')
  assert.strictEqual(byName['Anchor Up'].group, 'Inputs')
  assert.strictEqual(byName['Anchor Light'].readings[0].candidates[0], 'electrical.czone.Anchor_Light.current')
  // Resolution picks the first candidate that has a value.
  const values = { 'electrical.batteries.1.voltage': 13.1, 'electrical.batteries.1.stateOfCharge': 0.8 }
  const resolved = resolveCatalog(items, p => values[p])
  const hb = resolved.find(i => i.name === 'House Battery')
  assert.strictEqual(hb.mapped, true)
  assert.strictEqual(hb.readings.find(r => r.key === 'soc').path, 'electrical.batteries.1.stateOfCharge')
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

// --- End to end: fake Signal K, monitor samples and serves routes.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'Compass-Rose-28.06.26.zcf'), zcfFile)
  const sk = { 'electrical.batteries.1.voltage': { value: 13.2 }, 'tanks.fuel.0.currentLevel': { value: 0.42 } }
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
  assert.deepStrictEqual(call('/monitor/values').values, { 'electrical.batteries.1.voltage': 13.2, 'tanks.fuel.0.currentLevel': 0.42 })
  const trend = call('/trend', { path: 'tanks.fuel.0.currentLevel', range: '1h' })
  assert.deepStrictEqual(trend.data.map(d => d[1]), [0.42])
  assert.strictEqual(call('/trend/status').available, true)
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
//     source 1. Virtual "Victron Shunt" (instance 1) must ignore the Meter
//     Interface's "5V System - MI", which is also instance 1.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sens-'))
  const zcfFile = path.join(dir, 'installation.zcf')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'TestBench-2026-10-01.zcf'), zcfFile)
  const sk = {
    'electrical.batteries.1.voltage': {
      value: 5.02, $source: 'n2k-on-ve.can-socket.9',
      values: { 'n2k-on-ve.can-socket.9': { value: 5.02 }, 'n2k-on-ve.can-socket.224': { value: 13.31 } }
    }
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
  monitor.stop()
}

console.log('Monitor tests passed')
