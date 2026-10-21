'use strict'

// Uploading a ZCF (or switching to a saved network configuration) changes the
// configuration source and nothing else. It used to save only the source and
// the sending switch, so confirm-before-off circuits, the switch pane, trends
// and third-party links were all lost (Compass Rose, 18 October 2026).

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const pluginFactory = require('../index')

const zcfFile = path.join(__dirname, 'fixtures', 'TestBench.zcf')
const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'czone-settings-kept-'))
const saved = []
const app = {
  config: { configPath },
  isNmea2000OutAvailable: true,
  on () {}, removeListener () {}, emit () {}, debug () {}, error () {},
  setPluginStatus () {}, setPluginError () {}, registerPutHandler () {}, handleMessage () {},
  getSelfPath: () => undefined,
  getDataDirPath: () => configPath,
  savePluginOptions: (s, cb) => { saved.push(s); cb() }
}
const settings = {
  enableSending: true,
  confirmOff: [{ circuit: 'Light 1' }],
  victronSwitches: true,
  trendsEnabled: true,
  bridges: [{ circuit: 'Light 2', target: 'shelly', host: '192.168.1.140', channel: 0 }],
  configurationSource: 'installedZcf'
}
const plugin = pluginFactory(app)
plugin.start(settings, () => {})
const routes = { get: new Map(), post: new Map() }
plugin.registerWithRouter({ get: (p, fn) => routes.get.set(p, fn), post: (p, fn) => routes.post.set(p, fn), put () {}, delete () {} })

function multipart (name, data) {
  const boundary = '----czonetest'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
  const req = Readable.from([body])
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
  return req
}
const call = (route, req) => new Promise(resolve => {
  const res = { code: 200, status (c) { this.code = c; return this }, json (b) { resolve({ code: this.code, body: b }) } }
  routes.post.get(route)(req, res)
})

;(async () => {
  const r = await call('/zcf/upload', multipart('Test Bench.zcf', fs.readFileSync(zcfFile)))
  assert.strictEqual(r.code, 200, JSON.stringify(r.body))
  const after = saved[saved.length - 1]
  assert.deepStrictEqual(after.confirmOff, settings.confirmOff)
  assert.strictEqual(after.victronSwitches, true)
  assert.strictEqual(after.trendsEnabled, true)
  assert.deepStrictEqual(after.bridges, settings.bridges)
  assert.strictEqual(after.enableSending, true)
  assert.strictEqual(after.configurationSource, 'installedZcf')
  assert.strictEqual(after.networkConfigFile, '')

  // A saved network configuration: same rule.
  const dir = path.join(configPath, 'plugin-config-data', 'signalk-czone-circuits', 'network-configs')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(zcfFile, path.join(dir, 'boat.czone.net'))
  const n = saved.length
  const u = await new Promise(resolve => {
    const res = { code: 200, status (c) { this.code = c; return this }, json (b) { resolve({ code: this.code, body: b }) } }
    routes.post.get('/configuration/network/use')({ body: { file: 'boat.czone.net' } }, res)
  })
  if (u.code === 200) {
    const s2 = saved[n]
    assert.strictEqual(s2.configurationSource, 'networkCache')
    assert.strictEqual(s2.networkConfigFile, 'boat.czone.net')
    assert.deepStrictEqual(s2.confirmOff, settings.confirmOff)
    assert.strictEqual(s2.victronSwitches, true)
  } else {
    throw new Error('network/use refused: ' + JSON.stringify(u.body))
  }
  plugin.stop()
  console.log('settings kept on ZCF upload tests passed')
})().catch(err => { console.error(err); process.exit(1) })
