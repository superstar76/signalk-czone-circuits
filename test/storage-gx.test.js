'use strict'

// Trend storage on a Victron GX: two fixes from Matt's #24, ported.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createTrendStore } = require('../lib/monitor/storage')
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

// A GX custom folder cannot get round "card or stick only", including through symlinks.
{
  const internal = tmp('internal-')
  const card = tmp('card-')
  const mountText = `/dev/mmcblk0p1 ${card} vfat rw 0 0`
  const forbidden = path.join(internal, 'must-not-create')
  const bad = createTrendStore({ isVenus: true, directory: forbidden, mountsProvider: () => mountText })
  assert.strictEqual(bad.status().reason, 'not_removable')
  assert.strictEqual(fs.existsSync(forbidden), false)
  fs.symlinkSync(internal, path.join(card, 'escape'))
  const escaped = createTrendStore({ isVenus: true, directory: path.join(card, 'escape', 'trends'), mountsProvider: () => mountText })
  assert.strictEqual(escaped.status().reason, 'not_removable')
  fs.symlinkSync(internal, path.join(card, 'signalk-czone'))
  const automatic = createTrendStore({ isVenus: true, mountsProvider: () => mountText })
  assert.strictEqual(automatic.status().reason, 'not_removable')
  const good = createTrendStore({ isVenus: true, directory: path.join(card, 'custom'), mountsProvider: () => mountText })
  assert.strictEqual(good.status().location, 'removable')
  good.record('x', 2)
  assert.strictEqual(good.flush().written, 1)
}

// A card that is removed is noticed at once, even while the location is cached.
for (const custom of [false, true]) {
  const card = tmp('unmounted-')
  let mounts = `/dev/mmcblk0p1 ${card} vfat rw 0 0`
  const store = createTrendStore({ isVenus: true, directory: custom ? path.join(card, 'custom') : undefined, mountsProvider: () => mounts })
  assert.strictEqual(store.status().available, true)
  store.record('x', 2)
  mounts = ''
  assert.strictEqual(store.flush().written, 0)
  assert.strictEqual(store.status().available, false)
  assert.strictEqual(fs.existsSync(path.join(card, custom ? 'custom' : 'signalk-czone/trends', 'x')), false)
  mounts = `/dev/mmcblk0p1 ${card} vfat rw 0 0`
  store.record('x', 3)
  assert.strictEqual(store.flush().written, 1)
}

// Invalid dates and custom periods over 366 days are refused before any file is read.
{
  const store = createTrendStore({ directory: tmp('range-') })
  for (const range of [{ from: 0, to: 1e20 }, { from: -1e20, to: 0 }, { from: 0, to: 367 * 86400e3 }]) {
    assert.strictEqual(store.read('x', range).error, 'bad_range')
  }
}

console.log('GX trend storage tests passed')
