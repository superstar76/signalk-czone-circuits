'use strict'

// A Shelly (Gen2 and later: Plus, Pro, PM Mini, 1PM, ...) reached directly on
// the network, through its local RPC API. No GX needed. Tested on a Shelly PM1
// on the test bench, 13 Oct 2026:
//
//   GET http://<host>/rpc/Switch.GetStatus?id=<channel>
//     -> {"id":0,"output":true,"apower":0.0,"voltage":239.1,"current":0.000, ...}
//   GET http://<host>/rpc/Switch.Set?id=<channel>&on=true|false
//
// A Shelly with a password set refuses with 401; that is reported, not
// worked around (digest login is not supported yet).

const http = require('http')

const TIMEOUT_MS = 3000

// host: '192.168.1.204', or 'host:port' (a Shelly always uses 80; the port is
// for testing and for a Shelly behind a port forward).
function get (hostAndPort, pathAndQuery, { timeoutMs = TIMEOUT_MS, port = 80 } = {}) {
  const m = /^(.+?)(?::(\d+))?$/.exec(String(hostAndPort))
  const host = m[1]
  if (m[2]) port = Number(m[2])
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: pathAndQuery, timeout: timeoutMs }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { if (body.length < 65536) body += c })
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('the Shelly has a password set'))
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        try { resolve(JSON.parse(body)) } catch (_) { reject(new Error('not a Shelly Gen2 reply')) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('no answer')))
    req.on('error', reject)
  })
}

function createShellyDriver ({ port = 80, timeoutMs = TIMEOUT_MS } = {}) {
  const opts = { port, timeoutMs }
  return {
    describe: entry => `Shelly ${entry.host}${entry.channel ? ` channel ${entry.channel}` : ''}`,
    async status (entry) {
      return get(entry.host, `/rpc/Switch.GetStatus?id=${entry.channel || 0}`, opts)
    },
    async read (entry) {
      const s = await get(entry.host, `/rpc/Switch.GetStatus?id=${entry.channel || 0}`, opts)
      if (typeof s.output !== 'boolean') throw new Error('no switch on that channel')
      return s.output
    },
    async write (entry, on) {
      await get(entry.host, `/rpc/Switch.Set?id=${entry.channel || 0}&on=${on ? 'true' : 'false'}`, opts)
    }
  }
}

module.exports = { createShellyDriver }
