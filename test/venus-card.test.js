'use strict'

// The card setup file for a Victron GX: venus-data.tgz, which Venus OS unpacks
// into /data at boot and whose rc/post-hook.sh it then runs. See
// lib/monitor/venus-card.js.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { cardSetupArchive, CARD_SETUP_FILE } = require('../lib/monitor/venus-card')

assert.strictEqual(CARD_SETUP_FILE, 'venus-data.tgz') // the name Venus OS looks for

// --- The archive: read back as a tar, entry by entry.
const tar = zlib.gunzipSync(cardSetupArchive(Date.UTC(2026, 9, 4)))
const entries = []
for (let p = 0; p + 512 <= tar.length;) {
  const h = tar.subarray(p, p + 512)
  if (h.every(b => b === 0)) break
  const text = (from, length) => h.toString('utf8', from, from + length).replace(/\0.*$/, '')
  const size = parseInt(text(124, 12), 8)
  // Header checksum, with its own field read as spaces.
  let sum = 0
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i]
  assert.strictEqual(parseInt(text(148, 8), 8), sum, 'tar header checksum')
  assert.strictEqual(text(257, 5), 'ustar')
  entries.push({ name: text(0, 100), mode: parseInt(text(100, 8), 8), uid: parseInt(text(108, 8), 8), type: text(156, 1), size, data: tar.subarray(p + 512, p + 512 + size) })
  p += 512 + Math.ceil(size / 512) * 512
}
assert.deepStrictEqual(entries.map(e => [e.name, e.type]), [['rc/', '5'], ['rc/post-hook.sh', '0'], ['sdcard-rw.sh', '0']])
assert(entries.every(e => e.mode === 0o755 && e.uid === 0), 'runnable, owned by root')
assert.strictEqual(tar.length % 512, 0)
const scripts = path.join(__dirname, '..', 'lib', 'monitor', 'venus')
assert(entries[1].data.equals(fs.readFileSync(path.join(scripts, 'post-hook.sh'))))
assert(entries[2].data.equals(fs.readFileSync(path.join(scripts, 'sdcard-rw.sh'))))
// The copy kept with the documents (not in the npm package) is the same script.
const docCopy = path.join(__dirname, '..', 'docs', 'venus-sdcard-rw.sh')
if (fs.existsSync(docCopy)) assert(entries[2].data.equals(fs.readFileSync(docCopy)))
// The hook asks for the script by the path the archive puts it at.
assert(entries[1].data.toString().includes('/data/sdcard-rw.sh'))

// --- The scripts themselves, where a shell is to hand.
let shell = true
try { execFileSync('sh', ['-c', 'exit 0']) } catch (_) { shell = false }
if (shell) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-card-'))
  const script = path.join(scripts, 'sdcard-rw.sh')
  for (const f of ['sdcard-rw.sh', 'post-hook.sh']) execFileSync('sh', ['-n', path.join(scripts, f)])
  const dry = mounts => {
    const file = path.join(dir, 'mounts')
    fs.writeFileSync(file, mounts.join('\n') + '\n')
    return execFileSync('sh', [script], { env: { ...process.env, MOUNTS: file, DRY: '1', WAIT: '0' } }).toString().trim().split('\n').filter(Boolean)
  }
  // As Venus OS mounts a card (the bench Cerbo, 3 Oct 2026), an open stick and a closed one under /media.
  assert.deepStrictEqual(dry([
    '/dev/root / ext4 rw 0 0',
    '/dev/mmcblk0p1 /run/media/mmcblk0p1 vfat rw,relatime,fmask=0022,dmask=0022,codepage=437,iocharset=iso8859-1,shortname=mixed,errors=remount-ro 0 0',
    '/dev/sda1 /run/media/sda1 vfat rw,relatime,fmask=0000,dmask=0000 0 0',
    '/dev/sdb1 /media/sdb1 vfat rw,fmask=0022,dmask=0022 0 0',
    '/dev/mmcblk1p5 /data ext4 rw 0 0'
  ]), [
    'svc -d /service/vrmlogger',
    'umount /run/media/mmcblk0p1',
    'mount -t vfat -o rw,relatime,umask=0000 /dev/mmcblk0p1 /run/media/mmcblk0p1',
    'umount /media/sdb1',
    'mount -t vfat -o rw,relatime,umask=0000 /dev/sdb1 /media/sdb1',
    'svc -u /service/vrmlogger'
  ])
  // Already open, or no card: nothing is touched, the logger included.
  assert.deepStrictEqual(dry(['/dev/sda1 /run/media/sda1 vfat rw,relatime,fmask=0000,dmask=0000 0 0']), [])
  assert.deepStrictEqual(dry(['/dev/root / ext4 rw 0 0']), [])

  // The boot hook, pointed at a stand-in for /data: one line in rc.local however often it runs.
  const data = path.join(dir, 'data')
  fs.mkdirSync(data)
  fs.copyFileSync(script, path.join(data, 'sdcard-rw.sh'))
  const hook = path.join(dir, 'post-hook.sh')
  fs.writeFileSync(hook, fs.readFileSync(path.join(scripts, 'post-hook.sh'), 'utf8').split('/data/').join(data + '/'))
  execFileSync('sh', [hook]); execFileSync('sh', [hook])
  const rc = fs.readFileSync(path.join(data, 'rc.local'), 'utf8')
  assert.strictEqual(rc, `#!/bin/sh\n${data}/sdcard-rw.sh &\n`)
  assert(fs.statSync(path.join(data, 'rc.local')).mode & 0o100, 'rc.local is runnable')
  // An rc.local that is already there keeps its lines.
  fs.writeFileSync(path.join(data, 'rc.local'), '#!/bin/sh\n[ -e /service/tailscale ] || ln -s /data/tailscale/service /service/tailscale\n')
  execFileSync('sh', [hook]); execFileSync('sh', [hook])
  assert.strictEqual(fs.readFileSync(path.join(data, 'rc.local'), 'utf8'), `#!/bin/sh\n[ -e /service/tailscale ] || ln -s /data/tailscale/service /service/tailscale\n${data}/sdcard-rw.sh &\n`)
  fs.rmSync(dir, { recursive: true, force: true })
} else {
  console.log('No shell here: script checks skipped')
}

// --- The download route.
{
  const { createMonitor } = require('../lib/monitor')
  const m = createMonitor({ getSelfPath: () => undefined, debug () {}, handleMessage () {} })
  const routes = {}
  m.registerRoutes({ get: (p, fn) => { routes[p] = fn } })
  const headers = {}
  let sent
  routes['/trend/card-setup']({}, { setHeader: (k, v) => { headers[k] = v }, end: b => { sent = b } })
  assert.strictEqual(headers['Content-Disposition'], 'attachment; filename="venus-data.tgz"')
  assert.strictEqual(headers['Content-Length'], sent.length)
  assert.strictEqual(zlib.gunzipSync(sent).length, tar.length)
}

console.log('GX card setup file tests passed')
