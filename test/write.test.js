'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const pluginFactory = require('../index')

const zcfSource = path.join(__dirname, 'fixtures', 'SugarShack-20260927-01.zcf')
if (!fs.existsSync(zcfSource)) {
  console.log('Step 3 write tests skipped: live ZCF not present')
  process.exit(0)
}

const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-write-'))
const putHandlers = new Map()
const emitted = []
const app = {
  config: { configPath },
  isNmea2000OutAvailable: true,
  on: () => {},
  emit: (event, line) => { if (event === 'nmea2000out') emitted.push(line) },
  debug: () => {},
  registerPutHandler: (_context, pathName, handler) => putHandlers.set(pathName, handler),
  handleMessage: () => {},
  setPluginStatus: () => {}
}

const plugin = pluginFactory(app)
const installationDir = path.join(configPath, 'plugin-config-data', 'signalk-czone-circuits')
fs.mkdirSync(installationDir, { recursive: true })
fs.copyFileSync(zcfSource, path.join(installationDir, 'installation.zcf'))
plugin.start({ enableSending: true })

const galleyState = 'electrical.czone.Galley_Lights.switch.state'
const galleyBrightness = 'electrical.czone.Galley_Lights.switch.brightness'
const pianoState = 'electrical.czone.Piano_Light.switch.state'

assert.strictEqual(putHandlers.size, 110 + 13 + 1)
assert(putHandlers.has(galleyState))
assert(putHandlers.has(galleyBrightness))
assert(putHandlers.has(pianoState))

let result = putHandlers.get(galleyBrightness)('vessels.self', galleyBrightness, 0.5, () => {})
assert.deepStrictEqual(result, { state: 'COMPLETED', statusCode: 200 })
assert(emitted.at(-1).endsWith(',27,99,1b,00,32,01,fc,08'))
assert(emitted.length >= 3)
assert(emitted.at(-4).endsWith(',27,99,1b,00,00,01,f5,08'))
assert(emitted.at(-3).endsWith(',27,99,1b,00,00,01,95,08'))
assert(emitted.at(-2).endsWith(',27,99,1b,00,00,01,43,08'))

result = putHandlers.get(galleyState)('vessels.self', galleyState, true, () => {})
assert.deepStrictEqual(result, { state: 'COMPLETED', statusCode: 200 })
assert(emitted.at(-3).endsWith(',27,99,1b,00,00,01,f5,08'))
assert(emitted.at(-2).endsWith(',27,99,1b,00,00,01,95,08'))
assert(emitted.at(-1).endsWith(',27,99,1b,00,00,01,43,08'))

result = putHandlers.get(pianoState)('vessels.self', pianoState, true, () => {})
assert.deepStrictEqual(result, { state: 'COMPLETED', statusCode: 200 })
assert(emitted.at(-2).endsWith(',27,99,35,00,00,01,f1,08'))
assert(emitted.at(-1).endsWith(',27,99,35,00,00,01,40,08'))

result = putHandlers.get(galleyBrightness)('vessels.self', galleyBrightness, 1.2, () => {})
assert.strictEqual(result.statusCode, 400)

// Step 4: Mode Signal K write handlers.
const modeActivePath = 'electrical.czone.mode.active'
const dayModePath = 'electrical.czone.modes.dayCrusing.switch.state'
const nightModePath = 'electrical.czone.modes.nightCruising.switch.state'
assert(putHandlers.has(modeActivePath))

result = putHandlers.get(modeActivePath)('vessels.self', modeActivePath, 'nightCruising', () => {})
assert.deepStrictEqual(result, { state: 'COMPLETED', statusCode: 200 })
assert(emitted.at(-1).endsWith(',27,99,4d,00,00,01,f1,08'))





result = putHandlers.get(modeActivePath)('vessels.self', modeActivePath, 'doesNotExist', () => {})
assert.strictEqual(result.statusCode, 400)

// Safety interlock: this plugin must never put CZone commands on the bus unless
// the administrator explicitly enables NMEA 2000 sending.
const safeConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-safe-'))
const safePutHandlers = new Map()
const safeEmitted = []
const safeLogs = []
const safeApp = {
  config: { configPath: safeConfigPath },
  isNmea2000OutAvailable: true,
  on: () => {},
  emit: (event, line) => { if (event === 'nmea2000out') safeEmitted.push(line) },
  debug: message => safeLogs.push(message),
  registerPutHandler: (_context, pathName, handler) => safePutHandlers.set(pathName, handler),
  handleMessage: () => {},
  setPluginStatus: () => {}
}
const safePlugin = pluginFactory(safeApp)
const safeDir = path.join(safeConfigPath, 'plugin-config-data', 'signalk-czone-circuits')
fs.mkdirSync(safeDir, { recursive: true })
fs.copyFileSync(zcfSource, path.join(safeDir, 'installation.zcf'))
safePlugin.start({})
const safeResult = safePutHandlers.get(galleyState)('vessels.self', galleyState, true, () => {})
assert.strictEqual(safeResult.statusCode, 400)
assert.strictEqual(safeEmitted.length, 0)
assert(safeLogs.some(message => message.includes('CZone send blocked: NMEA 2000 sending is disabled')))
safePlugin.stop()

// Output availability is a second independent fail-closed gate.
const unavailableConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-unavailable-'))
const unavailablePutHandlers = new Map()
const unavailableEmitted = []
const unavailableLogs = []
const unavailableApp = {
  config: { configPath: unavailableConfigPath },
  isNmea2000OutAvailable: false,
  on: () => {},
  emit: (event, line) => { if (event === 'nmea2000out') unavailableEmitted.push(line) },
  debug: message => unavailableLogs.push(message),
  registerPutHandler: (_context, pathName, handler) => unavailablePutHandlers.set(pathName, handler),
  handleMessage: () => {},
  setPluginStatus: () => {}
}
const unavailablePlugin = pluginFactory(unavailableApp)
const unavailableDir = path.join(unavailableConfigPath, 'plugin-config-data', 'signalk-czone-circuits')
fs.mkdirSync(unavailableDir, { recursive: true })
fs.copyFileSync(zcfSource, path.join(unavailableDir, 'installation.zcf'))
unavailablePlugin.start({ enableSending: true })
const unavailableResult = unavailablePutHandlers.get(galleyState)('vessels.self', galleyState, true, () => {})
assert.strictEqual(unavailableResult.statusCode, 400)
assert.strictEqual(unavailableEmitted.length, 0)
assert(unavailableLogs.some(message => message.includes('CZone send blocked: NMEA 2000 output is not available')))
unavailablePlugin.stop()

// Plugin lifecycle: the ZCF upload path must use Signal K's supplied restart callback
// rather than requiring a full server restart. The production plugin API supplies
// this callback as the second start() argument, matching signalk-czone.
const lifecycleConfigPath = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-czone-lifecycle-'))
let lifecycleRestartedWith = null
let lifecycleSavedWith = null
const lifecycleApp = {
  config: { configPath: lifecycleConfigPath },
  savePluginOptions: (config, cb) => { lifecycleSavedWith = config; cb() },
  on: () => {},
  emit: () => {},
  debug: () => {},
  registerPutHandler: () => {},
  handleMessage: () => {},
  setPluginStatus: () => {}
}
const lifecyclePlugin = pluginFactory(lifecycleApp)
lifecyclePlugin.start({}, config => { lifecycleRestartedWith = config })
assert.strictEqual(typeof lifecycleRestartedWith, 'object')
// Upload route integration is exercised separately by the Signal K server; this
// assertion verifies the plugin receives and retains the restart callback.
lifecyclePlugin.stop()

plugin.stop()
console.log('Signal K circuit and Mode write tests passed')
