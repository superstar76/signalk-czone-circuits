'use strict'

// The card setup file for a Victron GX.
//
// Venus OS mounts a FAT card writable by root only, and Signal K runs as the
// "signalk" user, so the plugin cannot write trends to a card it can see. The
// plugin is not root and cannot change that itself. Venus OS does offer a way
// in without a login: at boot it unpacks venus-data.tgz from removable storage
// into /data and runs rc/post-hook.sh from it (Venus OS 2.30 and later; see
// "Hooks to install/run own code at boot" in Victron's root-access notes).
//
// So the owner copies one file onto the card and restarts the GX:
//
//   venus-data.tgz
//     rc/post-hook.sh   adds "/data/sdcard-rw.sh &" to /data/rc.local, once
//     sdcard-rw.sh      -> /data/sdcard-rw.sh: mounts each card open at boot
//
// The archive is built here from the two scripts, so there is no binary in the
// repository. Plain ustar; nothing else is needed for two small files.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SCRIPTS = path.join(__dirname, 'venus')
const FILES = [
  { name: 'rc/', dir: true },
  { name: 'rc/post-hook.sh', source: 'post-hook.sh' },
  { name: 'sdcard-rw.sh', source: 'sdcard-rw.sh' }
]

function header (name, size, dir, mtime) {
  const h = Buffer.alloc(512)
  const octal = (value, length, offset) => h.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii')
  h.write(name, 0, 100, 'utf8')
  octal(0o755, 8, 100) // mode: both scripts must be runnable
  octal(0, 8, 108) // owner root
  octal(0, 8, 116) // group root
  octal(size, 12, 124)
  octal(mtime, 12, 136)
  h.fill(' ', 148, 156) // checksum field counts as spaces while summing
  h.write(dir ? '5' : '0', 156, 1, 'ascii')
  h.write('ustar\0', 257, 6, 'ascii')
  h.write('00', 263, 2, 'ascii')
  h.write('root', 265, 32, 'ascii')
  h.write('root', 297, 32, 'ascii')
  let sum = 0
  for (const byte of h) sum += byte
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return h
}

// Returns the gzipped tar as a Buffer.
function cardSetupArchive (now = Date.now()) {
  const mtime = Math.floor(now / 1000)
  const parts = []
  for (const f of FILES) {
    const data = f.dir ? Buffer.alloc(0) : fs.readFileSync(path.join(SCRIPTS, f.source))
    parts.push(header(f.name, data.length, !!f.dir, mtime), data)
    if (data.length % 512) parts.push(Buffer.alloc(512 - (data.length % 512)))
  }
  parts.push(Buffer.alloc(1024)) // end of archive
  return zlib.gzipSync(Buffer.concat(parts))
}

module.exports = { cardSetupArchive, CARD_SETUP_FILE: 'venus-data.tgz' }
