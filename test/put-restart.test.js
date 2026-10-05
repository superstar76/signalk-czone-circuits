'use strict'

// A plugin restart (any change in the settings panel causes one) must leave
// the Signal K PUT handlers in place. Signal K drops a plugin's handlers when
// it stops; the plugin used to remember the paths as registered and so
// registered none on the next start: "PUT not supported" until Signal K was
// restarted (seen by Matt on his Cerbo, 5 Oct 2026; very likely what we saw on
// the bench as a PUT that was accepted but did not switch).

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')

const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-put-'))
const handlers = new Map()
const emitted = []
const app = {
  config: { configPath },
  isNmea2000OutAvailable: true,
  on: () => {},
  removeListener: () => {},
  emit: (event, line) => { if (event === 'nmea2000out') emitted.push(line) },
  debug: () => {},
  registerPutHandler: (_context, p, handler) => handlers.set(p, handler),
  handleMessage: () => {},
  setPluginStatus: () => {},
  getSelfPath: () => undefined
}
const plugin = pluginFactory(app)
const dir = path.join(configPath, 'plugin-config-data', 'signalk-czone-circuits')
fs.mkdirSync(dir, { recursive: true })
fs.copyFileSync(path.join(__dirname, 'fixtures', 'Compass-Rose-03.10.26.zcf'), path.join(dir, 'installation.zcf'))

plugin.start({ enableSending: true, monitorWire: false })
const first = handlers.size
assert(first > 20, 'handlers registered on the first start')
const lights = 'electrical.czone.Lights.switch.state'
assert.strictEqual(handlers.get(lights)('vessels.self', lights, true, () => {}).statusCode, 200)

// Signal K stops the plugin and removes its handlers, then starts it again.
plugin.stop()
handlers.clear()
plugin.start({ enableSending: true, monitorWire: false })
assert.strictEqual(handlers.size, first, 'every handler is registered again after a restart')
const sent = emitted.length
assert.strictEqual(handlers.get(lights)('vessels.self', lights, false, () => {}).statusCode, 200)
assert(emitted.length > sent, 'and a PUT switches the circuit')
plugin.stop()
console.log('PUT handlers after a plugin restart: tests passed')
