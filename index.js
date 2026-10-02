'use strict'

const path = require('path')
const fs = require('fs')
const zcf = require('./lib/zcf')
const czone = require('./lib/czone')
const nmea = require('./lib/nmea2000')
const signalk = require('./lib/signalk')
const { createMonitor } = require('./lib/monitor')
const { prepareMapping } = require('./lib/fork-mapping')

const MAX_UPLOAD_BYTES = 1024 * 1024
const CZONE_CONFIG_BLOCK_HEADER = 23
const CZONE_CONFIG_BLOCK_SIZE = 200
const CZONE_CONFIG_READ_TIMEOUT_MS = 45000
const PLUGIN_ID = 'signalk-czone-circuits'
const NMEA_READY_RETRY_MS = 500
const NMEA_READY_RETRY_LIMIT = 40

function readRequestBody (req, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = err => {
      if (settled) return
      settled = true
      reject(err)
      try { req.destroy() } catch (_) {}
    }
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) return fail(new Error(`Upload exceeds ${maxBytes} bytes`))
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', fail)
  })
}

function parseMultipartSingleFile (body, contentType) {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')
  if (!match) throw new Error('Expected multipart/form-data upload')
  const boundary = match[1] || match[2]
  const delimiter = Buffer.from(`--${boundary}`)
  let pos = 0

  while (true) {
    const start = body.indexOf(delimiter, pos)
    if (start < 0) break
    let cursor = start + delimiter.length
    if (body[cursor] === 45 && body[cursor + 1] === 45) break
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) throw new Error('Malformed multipart upload')
    const headers = body.subarray(cursor, headerEnd).toString('utf8')
    const next = body.indexOf(delimiter, headerEnd + 4)
    if (next < 0) throw new Error('Malformed multipart upload: missing boundary')

    let end = next
    if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2
    const data = body.subarray(headerEnd + 4, end)
    const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headers)
    const filename = disposition && /filename="([^"]*)"/i.exec(disposition[1])
    if (filename) return { filename: filename[1], data }
    pos = next + delimiter.length
  }

  throw new Error('No file field found in upload')
}

function safeFilename (value) {
  const base = path.basename(String(value || 'CZone.zcf'))
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim()
  return cleaned.toLowerCase().endsWith('.zcf') ? cleaned : `${cleaned}.zcf`
}

function safeNetworkFilename (value) {
  const base = path.basename(String(value || 'CZone Network'))
  const cleaned = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim() || 'CZone Network'
  return cleaned.replace(/\.czone\.net$/i, '')
}

function networkTimestamp (date = new Date()) {
  const iso = date.toISOString()
  return iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
}

module.exports = function (app) {
  let settings = {}
  const monitor = createMonitor(app)
  let mapping = null
  let restartPlugin = null
  let nmeaReady = false
  let nmeaReadyRetryTimer = null
  let nmeaReadyRetryCount = 0
  let nmeaReadyAt = null
  let lastNmeaOutput = null
  let runtimeState = new Map()
  // Server-side publication cache. CZone status/telemetry packets repeat the
  // same values frequently; only publish a Signal K delta when the value for a
  // circuit path actually changes. Signal K then fans that single change out
  // to every connected web client.
  let publishedCircuitValues = new Map()
  let reassembler = null
  let rawListener = null
  let activeMode = null
  let startupModeInferenceTimer = null
  let startupModeInferenceDone = false
  let configTransfer = null
  let configTransferTimer = null
  let configFastPacket = null
  let lastNetworkConfig = null

  const configDir = app.config && app.config.configPath
    ? path.join(app.config.configPath, 'plugin-config-data', PLUGIN_ID)
    : path.join(process.cwd(), '.signalk-czone-circuits')
  const networkConfigDir = () => path.join(configDir, 'network-configs')
  const zcfPath = () => {
    if (settings.configurationSource === 'networkCache' && settings.networkConfigFile) {
      const candidate = path.basename(String(settings.networkConfigFile))
      const target = path.join(networkConfigDir(), candidate)
      if (fs.existsSync(target)) return target
      log(`Configured network configuration ${candidate} is missing; falling back to installation.zcf`)
    }
    return path.join(configDir, 'installation.zcf')
  }

  function log (message) {
    if (typeof app.debug === 'function') app.debug(`[${PLUGIN_ID}] ${message}`)
  }


  function selectCommandDeviceId (zcfMapping) {
    const used = new Set((zcfMapping && zcfMapping.moduleAddresses) || [])
    for (let id = 1; id <= 0xFE; id++) {
      if (!used.has(id)) return id
    }
    throw new Error('No unused CZone device/dipswitch ID is available in the loaded ZCF')
  }

  function commandDeviceId () {
    if (!mapping) throw new Error('No ZCF has been uploaded')
    if (!Number.isInteger(mapping.commandDeviceId)) {
      mapping.commandDeviceId = selectCommandDeviceId(mapping)
      log(`Using CZone command device ID 0x${mapping.commandDeviceId.toString(16).padStart(2, '0')} (unused in loaded ZCF)`)
    }
    return mapping.commandDeviceId
  }

  function loadConfiguredZcf () {
    if (!fs.existsSync(zcfPath())) {
      mapping = null
      return null
    }
    mapping = zcf.load(zcfPath())
    // [fork] virtual-switch circuits hidden, every sub-category named
    // (including the five user-defined ones), and state inferred from
    // module/channel when the ZCF has no status table.
    {
      const r = prepareMapping(mapping, settings)
      const userNames = r.userCategories.filter(Boolean)
      if (userNames.length) log(`User-defined circuit categories: ${userNames.join(', ')}`)
      if (r.virtualHidden) log(`${r.virtualHidden} virtual-switch circuits hidden`)
      if (r.inferredState) log(`No status table in the ZCF: circuit state inferred from module/channel for ${r.inferredState} circuits`)
    }
    mapping.commandDeviceId = selectCommandDeviceId(mapping)
    publishedCircuitValues.clear()
    runtimeState = new Map(mapping.circuits.map(c => [c.name, {
      state: null,
      percent: null,
      lastCommand: null,
      lastCommandAt: null,
      lastRequested: null,
      lastRequestedPercent: null,
      canonicalSource: null,
      statusObserved: false,
      zcfCircuitId: c.zcfCircuitId,
      protocolCircuitId: c.protocolCircuitId,
      capabilities: c.capabilities,
    }]))
    log(`Loaded ${mapping.circuits.length} circuits from ${mapping.fileName}${mapping.vesselName ? ` (vessel ${mapping.vesselName})` : ''}; command device ID 0x${mapping.commandDeviceId.toString(16).padStart(2, '0')}`)
    for (const mode of mapping.modes) {
      const status = mode.truncated
        ? `TRUNCATED: parsed ${mode.parsedActionCount}/${mode.actionCount} actions`
        : `${mode.actionCount} actions`
      log(`Mode ${mode.name} (${mode.id}): ${status}`)
      log(`  ${mode.actions.map(a => `${a.target.hex}=${a.valuePercent}%`).join(' ')}`)
    }
    return mapping
  }

  function circuitByName (name) {
    if (!mapping) throw new Error('No ZCF has been uploaded')
    const circuit = mapping.circuits.find(c => c.name === name || c.slug === name)
    if (!circuit) throw new Error(`Unknown CZone circuit: ${name}`)
    return circuit
  }

  function requireProtocolId (circuit) {
    if (!Number.isInteger(circuit.protocolCircuitId)) {
      throw new Error(`No verified 27 99 circuit ID is mapped for "${circuit.name}" yet`)
    }
    if (!circuit.capabilities.switch) {
      throw new Error(`Circuit "${circuit.name}" is not yet marked controllable`)
    }
    return circuit.protocolCircuitId
  }

  const registeredPutPaths = new Set()

  function modeByName (name) {
    if (!mapping) throw new Error('No ZCF has been uploaded')
    const mode = mapping.modes.find(m => m.name === name || m.slug === name)
    if (!mode) throw new Error(`Unknown CZone mode: ${name}`)
    if (!Number.isInteger(mode.runtimeId)) throw new Error(`Mode "${mode.name}" has no runtime/control ID`)
    return mode
  }

  function requireSendingEnabled () {
    if (settings.enableSending !== true) {
      log('CZone send blocked: NMEA 2000 sending is disabled (Enable NMEA 2000 sending is OFF)')
      throw new Error('NMEA 2000 sending is disabled; enable \"Enable NMEA 2000 sending\" in plugin configuration first')
    }
    // Signal K documents the nmea2000OutAvailable event as the readiness
    // signal for outbound NMEA 2000 traffic. Do not re-check the app property
    // here: plugin lifecycle state can outlive the value exposed on the app
    // object. Once the event has fired, the provider is considered ready.
    if (!nmeaReady) {
      log(`CZone send blocked: NMEA 2000 output is not available (ready=${nmeaReady}, app.isNmea2000OutAvailable=${app.isNmea2000OutAvailable === true})`)
      throw new Error('NMEA 2000 output provider is not ready')
    }
  }

  function modeTargetKey (target) {
    if (!target || !Number.isInteger(target.byte0) || !Number.isInteger(target.byte1)) return null
    return `${target.byte0.toString(16).padStart(2, '0')}${target.byte1.toString(16).padStart(2, '0')}`
  }

  function circuitModeTargetKey (circuit) {
    if (!circuit || !Number.isInteger(circuit.statusBit) || !Number.isInteger(circuit.statusModule)) return null
    return `${circuit.statusBit.toString(16).padStart(2, '0')}${circuit.statusModule.toString(16).padStart(2, '0')}`
  }

  // Startup-only reconciliation. CZone does not appear to periodically
  // broadcast the currently selected mode, so after a Signal K restart we
  // use the circuit states that have arrived from the bus to make a best-fit
  // guess. This is deliberately fuzzy: operators can override individual
  // circuits while a mode remains active. Once this startup pass has made a
  // decision (or an authoritative F1 mode activation is observed), it never
  // re-runs for the lifetime of the plugin.
  function inferStartupMode (reason = 'startup') {
    if (startupModeInferenceDone || activeMode || !mapping || !mapping.modes.length) return false

    const candidates = []
    for (const mode of mapping.modes) {
      const mappedActions = mode.actions
        .map(action => ({ action, circuit: mapping.circuits.find(c => circuitModeTargetKey(c) === modeTargetKey(action.target)) }))
        .filter(x => x.circuit)

      const observed = mappedActions.filter(({ circuit }) => {
        const state = runtimeState.get(circuit.name)
        return state && state.statusObserved && (state.state === 'ON' || state.state === 'OFF')
      })

      if (!observed.length) continue

      let matched = 0
      let weightedMatched = 0
      let weightedObserved = 0
      let positiveObserved = 0
      let positiveMatched = 0
      for (const { action, circuit } of observed) {
        const state = runtimeState.get(circuit.name)
        const expectedOn = Number(action.valuePercent) > 0
        const weight = expectedOn ? 3 : 1
        const isMatch = (state.state === 'ON') === expectedOn
        weightedObserved += weight
        if (expectedOn) positiveObserved++
        if (isMatch) {
          matched++
          weightedMatched += weight
          if (expectedOn) positiveMatched++
        }
      }

      // An all-OFF mode is inherently ambiguous from circuit state alone: a
      // different mode with lots of OFF actions can look nearly identical.
      // Require at least one positive/ON action to provide distinguishing
      // evidence during startup reconciliation. This intentionally means we
      // may leave Sleep unknown rather than falsely claiming it is active.
      if (positiveObserved === 0) continue

      const score = weightedMatched / weightedObserved
      candidates.push({ mode, observed: observed.length, mapped: mappedActions.length, matched, score, positiveObserved, positiveMatched })
    }

    if (!candidates.length) return false
    candidates.sort((a, b) => b.score - a.score || b.positiveMatched - a.positiveMatched || b.matched - a.matched || b.observed - a.observed)
    const best = candidates[0]
    const second = candidates[1] || null

    // Require enough actual circuit evidence and a clear lead over the next
    // candidate. ON actions carry more weight because they distinguish modes
    // much better than a long list of expected-OFF circuits. This tolerates a
    // few manual overrides without allowing an all-OFF mode to win by volume.
    const minimumObserved = Math.min(8, Math.max(4, best.mapped - 3))
    const margin = second ? best.score - second.score : 1
    const confident = best.observed >= minimumObserved &&
      best.positiveMatched >= 1 &&
      best.score >= 0.60 &&
      margin >= 0.15

    log(`CZone startup mode reconciliation (${reason}): ${candidates.map(c => `${c.mode.name} ${c.matched}/${c.observed}=${Math.round(c.score * 100)}% positive=${c.positiveMatched}/${c.positiveObserved}`).join(', ')}`)

    if (!confident) return false

    startupModeInferenceDone = true
    activeMode = best.mode
    publishDelta(signalk.modeActivePath(), best.mode.slug)
    log(`Inferred startup CZone Mode ${best.mode.name} (${best.matched}/${best.observed} observed mapped actions, ${Math.round(best.score * 100)}%, positive ${best.positiveMatched}/${best.positiveObserved}, margin ${Math.round(margin * 100)}%)`)
    return true
  }

  function sendMode (mode) {
    requireSendingEnabled()
    const line = nmea.emitCzone(app, {
      src: 0,
      data: czone.modeActivate(mode.runtimeId, commandDeviceId(), 0x08)
    })
    // CZone's mode activation frame is the authoritative mode-change
    // transaction we can observe on the bus. Publish immediately on a local
    // command so the web UI does not remain pending when the NMEA2000 gateway
    // does not echo our outbound frame back through canboatjs:rawoutput.
    // Circuit-state traffic is deliberately not used to invalidate this mode:
    // operators can override individual circuits while remaining in a mode.
    startupModeInferenceDone = true
    if (startupModeInferenceTimer) clearTimeout(startupModeInferenceTimer)
    startupModeInferenceTimer = null
    activeMode = mode
    publishDelta(signalk.modeActivePath(), mode.slug)
    log(`Activated/published Mode ${mode.name} (runtime 0x${mode.runtimeId.toString(16).padStart(2, '0')})`)
    return line
  }

  function registerModePutHandlers () {
    if (typeof app.registerPutHandler !== 'function') {
      log('Signal K registerPutHandler() is unavailable; mode writes are disabled')
      return
    }
    if (!mapping) return

    const activePath = signalk.modeActivePath()
    if (!registeredPutPaths.has(activePath)) {
      app.registerPutHandler('vessels.self', activePath, (_context, _path, value) => {
        if (typeof value !== 'string') {
          return { state: 'COMPLETED', statusCode: 400, message: 'electrical.czone.mode.active requires a mode name or slug' }
        }
        try {
          const mode = modeByName(value)
          sendMode(mode)
          return { state: 'COMPLETED', statusCode: 200 }
        } catch (err) {
          return { state: 'COMPLETED', statusCode: 400, message: err.message }
        }
      }, PLUGIN_ID)
      registeredPutPaths.add(activePath)
    }

    log(`Registered Signal K PUT handlers for ${mapping.modes.length} CZone modes plus mode.active`)
  }

  function emitCommandSequence (circuit, commands, description) {
    requireSendingEnabled()
    const lines = []
    for (const data of commands) {
      lines.push(nmea.emitCzone(app, { src: 0, data }))
    }
    lastNmeaOutput = {
      timestamp: new Date().toISOString(),
      pgn: nmea.CZONE_PGN,
      description,
      circuit: circuit.name,
      frames: commands.map(data => czone.hex(data))
    }
    log(`NMEA 2000 OUT: PGN ${nmea.CZONE_PGN} CZone ${circuit.name} ${description} FRAMES ${commands.map(data => czone.hex(data)).join(' | ')}`)
    const state = runtimeState.get(circuit.name) || {}
    state.lastCommand = description
    state.lastCommandAt = Date.now()
    runtimeState.set(circuit.name, state)
    return lines
  }

  function sendCircuitState (circuit, enabled) {
    const id = requireProtocolId(circuit)
    const deviceId = commandDeviceId()
    const trailer = 0x08
    if (circuit.capabilities.dimmer) {
      return emitCommandSequence(
        circuit,
        enabled ? czone.dimmerOn(id, deviceId, trailer) : czone.dimmerOff(id, deviceId, trailer),
        enabled ? 'ON' : 'OFF'
      )
    }

    // Byte 5 identifies the CZone sending device/dipswitch. Do not use a
    // circuit-specific hard-coded device ID. The final 0x08 trailer makes the
    // command persistent instead of depending on the referenced device's
    // live heartbeat.
    return emitCommandSequence(
      circuit,
      [
        enabled ? czone.on(id, deviceId, trailer) : czone.off(id, deviceId, trailer),
        czone.switchComplete(id, deviceId, trailer)
      ],
      enabled ? 'ON' : 'OFF'
    )
  }

  function sendCircuitBrightness (circuit, normalized) {
    if (!circuit.capabilities.dimmer) {
      throw new Error(`Circuit "${circuit.name}" is not dimmable`)
    }
    const percent = Math.round(normalized * 100)
    const state = runtimeState.get(circuit.name)
    const commands = []
    // A level command alone changes the dimmer value but does not turn a CZone
    // dimmable circuit on. If the authoritative 65284 state says OFF (or has
    // not been observed yet), reproduce the CZone ON sequence first.
    if (!state || state.state !== 'ON') {
      commands.push(...czone.dimmerOn(requireProtocolId(circuit), commandDeviceId(), 0x08))
    }
    commands.push(czone.level(requireProtocolId(circuit), percent, commandDeviceId(), 0x08))
    return emitCommandSequence(circuit, commands, `LEVEL ${percent}%${commands.length > 1 ? ' + ON' : ''}`)
  }

  function registerCircuitPutHandlers () {
    if (typeof app.registerPutHandler !== 'function') {
      log('Signal K registerPutHandler() is unavailable; circuit writes are disabled')
      return
    }
    if (!mapping) return

    for (const circuit of mapping.circuits) {
      const statePath = signalk.statePath(circuit)
      if (!registeredPutPaths.has(statePath)) {
        app.registerPutHandler('vessels.self', statePath, (_context, _path, value) => {
          if (typeof value !== 'boolean') {
            return { state: 'COMPLETED', statusCode: 400, message: 'switch.state requires a boolean' }
          }
          try {
            sendCircuitState(circuitByName(circuit.slug), value)
            const state = runtimeState.get(circuit.name)
            if (state) state.lastRequested = value ? 'ON' : 'OFF'
            return { state: 'COMPLETED', statusCode: 200 }
          } catch (err) {
            return { state: 'COMPLETED', statusCode: 400, message: err.message }
          }
        }, PLUGIN_ID)
        registeredPutPaths.add(statePath)
      }

      if (circuit.capabilities.dimmer) {
        const brightnessPath = signalk.brightnessPath(circuit)
        if (!registeredPutPaths.has(brightnessPath)) {
          app.registerPutHandler('vessels.self', brightnessPath, (_context, _path, value) => {
            const normalized = Number(value)
            if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
              return { state: 'COMPLETED', statusCode: 400, message: 'switch.brightness requires a number between 0 and 1' }
            }
            try {
              sendCircuitBrightness(circuitByName(circuit.slug), normalized)
              const state = runtimeState.get(circuit.name)
              if (state) state.lastRequestedPercent = Math.round(normalized * 100)
              return { state: 'COMPLETED', statusCode: 200 }
            } catch (err) {
              return { state: 'COMPLETED', statusCode: 400, message: err.message }
            }
          }, PLUGIN_ID)
          registeredPutPaths.add(brightnessPath)
        }
      }
    }
    log(`Registered Signal K PUT handlers for ${mapping.circuits.length} circuits`)
  }


  function decodeDcLevel (raw) {
    if (raw === 0x0400) return { state: 'OFF', percent: 0 }
    if (raw >= 0x0401 && raw < 0x07E8) return { state: 'DIMMED', percent: (raw - 0x0400) / 10 }
    if (raw >= 0x07E8 && raw <= 0x0800) return { state: 'ON', percent: 100 }
    return { state: 'UNKNOWN', percent: null }
  }

  function decodeDcStatePacket (packet) {
    if (!packet || packet.pgn !== 130822 || packet.payload.length !== 28) return
    if (packet.payload[0] !== 0x27 || packet.payload[1] !== 0x99) return
    const module = packet.payload[2]
    const page = packet.payload[3]
    log(`CZone LEVEL IN: PGN 130822 src=${packet.source} module=0x${module.toString(16).padStart(2, '0')} page=${page} payload=${packet.payload.toString('hex').toUpperCase()}`)
    for (let slot = 0; slot < 8; slot++) {
      const i = 4 + slot * 3
      // 130822 carries the runtime module/page output table. The ZCF primary
      // module/channel identifies the physical circuit, but does not identify
      // where its live level is carried in this telemetry block. The ZCF-derived
      // statusModule/statusBit is the common runtime mapping for both 65284 state
      // and 130822 level.
    const circuit = mapping && mapping.circuits.find(c => {
        if (Number(c.statusModule) !== module || !Number.isInteger(c.statusBit)) return false
        return Math.floor(c.statusBit / 8) === page && (c.statusBit % 8) === slot
      })
      if (!circuit) continue
      const level = decodeDcLevel(packet.payload[i + 1] | (packet.payload[i + 2] << 8))
      if (level.percent == null) continue
      // 130822 is electrical telemetry. It is authoritative for brightness,
      // but must not be used to synthesize switch.state: small loads may draw
      // too little current and connected devices can have their own local
      // power switches. CZone command/status state comes from PGN 65284.
      const state = runtimeState.get(circuit.name)
      if (state) {
        state.percent = level.percent
        state.lastObservedPercent = level.percent
      }
      // Preserve the actual NMEA-2000 transmitter for the 130822 telemetry.
      // Do not substitute the 65284 status source: those are independent PGNs
      // and may legitimately have different CAN source addresses.
      const observedSource = signalk.nmea2000Source(packet.source, packet.pgn)
      publishCircuitDelta(
        circuit,
        signalk.brightnessPath(circuit),
        Math.max(0, Math.min(100, level.percent)) / 100,
        observedSource
      )
    }

    inferStartupMode('130822 level')
  }

  // CZone PGN 65284 is the authoritative per-module circuit ON/OFF
  // bitmap. The runtime module/bit mapping is decoded from the ZCF status
  // table; it is intentionally not inferred from the primary ZCF
  // module/channel identity.
  function decodeCzoneCircuitStatus (frame) {
    if (!frame || frame.pgn !== 65284 || !frame.data || frame.data.length !== 8) return
    const data = frame.data
    if (data[0] !== 0x27 || data[1] !== 0x99) return

    const module = data[2]
    // The fourth byte is a CZone status subtype/page and is not universal.
    // DC runtime modules in the captured network use 0x1F, while the mapped
    // AC module 0xF8 uses 0x0A and another mapped DC runtime module (0x28)
    // uses 0x08. The bitmap at bytes 4..7 is the common state representation.
    // Use the ZCF's status-module table as the authority instead of rejecting
    // valid modules because their subtype byte differs.
    if (!mapping || !mapping.circuits.some(c => Number(c.statusModule) === module)) return

    const statusSubtype = data[3]
    const bitmap = data.readUInt32LE(4)

    log(`CZone STATE IN: PGN 65284 src=${frame.source} module=0x${module.toString(16).padStart(2, '0')} subtype=0x${statusSubtype.toString(16).padStart(2, '0')} bitmap=0x${bitmap.toString(16).padStart(8, '0')} data=${data.toString('hex').toUpperCase()}`)

    for (const circuit of mapping.circuits) {
      if (Number(circuit.statusModule) !== module) continue

      // Most ZCF families map a circuit to one status bit. TestBench uses a
      // load-table mask instead; prefer the full mask when present so a
      // logical circuit can deliberately select one load from a multi-load
      // output group (for example Light 5 uses mask 0x10 even though the
      // physical output bitmap reports 0x30 with its companion Buzzer load).
      let enabled
      if (Number.isInteger(circuit.statusMask) && circuit.statusMask > 0) {
        enabled = (bitmap & (circuit.statusMask >>> 0)) !== 0
      } else if (Number.isInteger(circuit.statusBit) && circuit.statusBit >= 0 && circuit.statusBit <= 31) {
        enabled = ((bitmap >>> circuit.statusBit) & 1) !== 0
      } else {
        continue
      }
      const state = runtimeState.get(circuit.name)
      if (state) {
        state.statusObserved = true
        state.state = enabled ? 'ON' : 'OFF'
        state.lastObserved = {
          state: enabled ? 'ON' : 'OFF',
          source: { src: frame.source, pgn: frame.pgn }
        }
      }

      const stateSource = signalk.nmea2000Source(frame.source, frame.pgn)
      const observedState = enabled ? 'ON' : 'OFF'
      log(`CZone STATE: ${circuit.name} -> ${observedState} (runtime ${Number(circuit.statusModule).toString(16).padStart(2, '0')}:${Number(circuit.statusMask).toString(16).padStart(8, '0')}, src=${frame.source})`)
      const published = publishCircuitDelta(circuit, signalk.statePath(circuit), enabled, stateSource)
      if (published) {
        log(`CZone STATE PUBLISHED: ${signalk.statePath(circuit)}=${observedState} source=${JSON.stringify(stateSource)}`)
      } else {
        log(`CZone STATE SUPPRESSED: ${signalk.statePath(circuit)}=${observedState} unchanged`)
      }
      if (state && state.lastCommandAt && (state.lastCommand === 'ON' || state.lastCommand === 'OFF') && state.lastCommand === observedState) {
        const elapsed = Math.max(0, Date.now() - state.lastCommandAt)
        log(`CZone STATE CONFIRMED: ${circuit.name} ${observedState} after ${elapsed}ms`)
        state.lastCommand = null
        state.lastCommandAt = null
      }

    }

    inferStartupMode('65284 state')
  }

  function observeModeCommand (frame) {
    if (!nmea.isCzoneCommandFrame(frame) || !mapping) return
    const data = frame.data
    const runtimeId = data[2]
    const operation = data[6]
    const mode = mapping.modes.find(m => m.runtimeId === runtimeId)
    if (!mode) return

    // F1 is the empirically observed CZone mode activation operation. This is
    // authoritative mode traffic; do not infer/clear the mode from individual
    // circuit states because users may override circuits while a mode remains
    // active. The following 0x40 frame is the same CZone transaction-complete
    // operation used by the circuit commands. Log it when observed so captures
    // can distinguish activation from completion without treating 0x40 as a
    // separate mode identity.
    if (operation === 0xF1) {
      startupModeInferenceDone = true
      if (activeMode && activeMode.slug === mode.slug) {
        log(`Observed CZone Mode activation ${mode.name} unchanged (runtime 0x${runtimeId.toString(16).padStart(2, '0')})`)
        return
      }
      activeMode = mode
      publishDelta(signalk.modeActivePath(), mode.slug)
      log(`Observed active CZone Mode ${mode.name} (runtime 0x${runtimeId.toString(16).padStart(2, '0')}, activation F1)`)
      return
    }

    if (operation === 0x40) {
      log(`Observed CZone Mode transaction complete ${mode.name} (runtime 0x${runtimeId.toString(16).padStart(2, '0')}, completion 40)`)
    }
  }

  function handleRawFrame (line) {
    const frame = nmea.parseRawLine(line)
    if (!frame) return
    observeModeCommand(frame)
    if (frame.pgn === nmea.CZONE_DATABLOCK_PGN) {
      handleConfigFastPacket(frame)
      return
    }
    if (frame.pgn === 65284) {
      decodeCzoneCircuitStatus(frame)
      return
    }
    if (frame.pgn === 130822) {
      if (!reassembler) return
      reassembler.accept(frame)
    }
  }

  function publishDelta (pathName, value) {
    const delta = signalk.delta(pathName, value)
    if (typeof app.handleMessage === 'function') {
      app.handleMessage(PLUGIN_ID, delta)
    } else if (typeof app.emit === 'function') {
      app.emit('delta', delta)
    }
  }

  function publishCircuitDelta (circuit, pathName, value, sourceOverride = null) {
    const previous = publishedCircuitValues.get(pathName)
    if (previous !== undefined && Object.is(previous, value)) {
      // Repeated CZone telemetry is expected. Do not send redundant Signal K
      // deltas: one server-side change is automatically fanned out to every
      // connected browser, regardless of session/client.
      return false
    }

    publishedCircuitValues.set(pathName, value)
    const delta = signalk.circuitDelta(pathName, value, circuit, sourceOverride)
    if (typeof app.handleMessage === 'function') {
      app.handleMessage(PLUGIN_ID, delta)
    } else if (typeof app.emit === 'function') {
      app.emit('delta', delta)
    }
    return true
  }

  function emitCommand (circuit, data, description) {
    requireSendingEnabled()
    const line = nmea.emitCzone(app, {
      src: 0,
      data
    })
    lastNmeaOutput = {
      timestamp: new Date().toISOString(),
      pgn: nmea.CZONE_PGN,
      description,
      circuit: circuit.name
    }
    log(`NMEA 2000 OUT: PGN ${nmea.CZONE_PGN} CZone ${circuit.name} ${description} DATA ${czone.hex(data)}`)
    const state = runtimeState.get(circuit.name) || {}
    state.lastCommand = description
    state.lastCommandAt = Date.now()
    runtimeState.set(circuit.name, state)
    return line
  }

  function persistPluginOptions (newSettings) {
    if (typeof app.savePluginOptions !== 'function') return Promise.resolve()
    return new Promise((resolve, reject) => {
      app.savePluginOptions(newSettings, error => error ? reject(error) : resolve())
    })
  }

  function signalKVesselName () {
    try {
      if (typeof app.getSelfPath === 'function') {
        const name = app.getSelfPath('name')
        if (typeof name === 'string' && name.trim()) return name.trim()
      }
    } catch (_) {}
    return null
  }

  function clearConfigTransfer () {
    if (configTransferTimer) clearTimeout(configTransferTimer)
    configTransferTimer = null
    configTransfer = null
  }

  function failConfigTransfer (message) {
    if (!configTransfer) return
    const state = configTransfer
    clearConfigTransfer()
    state.status = 'error'
    state.error = message
    state.finishedAt = new Date().toISOString()
    lastNetworkConfig = state
    log(`CZone network configuration read failed: ${message}`)
  }

  function finishConfigTransfer (buffer, target, source) {
    const state = configTransfer
    if (!state) return
    const temp = path.join(configDir, `.network-${Date.now()}.zcf.tmp`)
    try {
      fs.mkdirSync(networkConfigDir(), { recursive: true })
      fs.writeFileSync(temp, buffer)
      const next = zcf.load(temp)
      const vesselName = next.vesselName || signalKVesselName() || 'CZone Network'
      const filename = `${safeNetworkFilename(vesselName)}-${networkTimestamp()}.czone.net`
      const targetPath = path.join(networkConfigDir(), filename)
      if (fs.existsSync(targetPath)) throw new Error(`Network configuration file already exists: ${filename}`)
      fs.renameSync(temp, targetPath)
      const metadata = {
        format: 'signalk-czone-network-config',
        version: 1,
        capturedAt: new Date().toISOString(),
        source: 'CZone network',
        pgn: nmea.CZONE_DATABLOCK_PGN,
        bytes: buffer.length,
        vesselName,
        czoneModule: target,
        nmeaSource: source,
        circuits: next.circuits.length,
        modes: next.modes.length
      }
      fs.writeFileSync(`${targetPath}.json`, `${JSON.stringify(metadata, null, 2)}\n`)
      clearConfigTransfer()
      state.status = 'complete'
      state.file = filename
      state.path = targetPath
      state.bytes = buffer.length
      state.vesselName = vesselName
      state.circuits = next.circuits.length
      state.modes = next.modes.length
      state.finishedAt = new Date().toISOString()
      state.message = `Saved ${filename}`
      lastNetworkConfig = state
      log(`CZone network configuration read complete: ${filename} (${buffer.length} bytes, ${next.circuits.length} circuits, ${next.modes.length} modes)`)
    } catch (err) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (_) {}
      failConfigTransfer(err.message)
    }
  }

  function handleConfigDataBlock (packet) {
    if (!configTransfer || !packet || !Buffer.isBuffer(packet.payload)) return
    const payload = packet.payload
    if (payload.length < CZONE_CONFIG_BLOCK_HEADER || payload[0] !== 0x27 || payload[1] !== 0x99) return
    const blockIndex = payload.readUInt16LE(2)
    const target = payload[4]
    const chunk = payload.subarray(CZONE_CONFIG_BLOCK_HEADER)
    if (chunk.length > CZONE_CONFIG_BLOCK_SIZE) return failConfigTransfer(`DataBlock ${blockIndex} contains ${chunk.length} bytes; maximum is ${CZONE_CONFIG_BLOCK_SIZE}`)
    if (configTransfer.target == null) configTransfer.target = target
    if (configTransfer.target !== target) return
    configTransfer.source = packet.source
    configTransfer.lastPacketAt = new Date().toISOString()
    if (chunk.length === 0) {
      const maxDataBlock = Math.max(-1, ...Array.from(configTransfer.blocks.keys()))
      for (let i = 0; i <= maxDataBlock; i++) {
        if (!configTransfer.blocks.has(i)) return failConfigTransfer(`Missing configuration DataBlock ${i} before terminator ${blockIndex}`)
      }
      const parts = []
      for (let i = 0; i <= maxDataBlock; i++) parts.push(configTransfer.blocks.get(i))
      const buffer = Buffer.concat(parts)
      nmea.emitPgn(app, { src: 0, pgn: nmea.CZONE_DATABLOCK_ACK_PGN, data: czone.configDataBlockAck(target, blockIndex, 1) })
      log(`CZone CONFIG IN: terminator block=${blockIndex} target=0x${target.toString(16).padStart(2, '0')} bytes=${buffer.length}; sent final ACK`)
      return finishConfigTransfer(buffer, target, packet.source)
    }
    if (!configTransfer.blocks.has(blockIndex)) configTransfer.blocks.set(blockIndex, Buffer.from(chunk))
    nmea.emitPgn(app, { src: 0, pgn: nmea.CZONE_DATABLOCK_ACK_PGN, data: czone.configDataBlockAck(target, blockIndex, 0) })
    configTransfer.receivedBytes = Array.from(configTransfer.blocks.values()).reduce((sum, part) => sum + part.length, 0)
    configTransfer.blockCount = configTransfer.blocks.size
    log(`CZone CONFIG IN: PGN ${nmea.CZONE_DATABLOCK_PGN} src=${packet.source} block=${blockIndex} target=0x${target.toString(16).padStart(2, '0')} chunk=${chunk.length} bytes=${configTransfer.receivedBytes}; ACK sent`)
  }

  function handleConfigFastPacket (frame) {
    if (!frame || frame.pgn !== nmea.CZONE_DATABLOCK_PGN || !frame.data || frame.data.length < 2) return
    const control = frame.data[0]
    const sequence = control >>> 5
    const frameNo = control & 0x1f
    const key = `${frame.source}:${sequence}`
    if (frameNo === 0) {
      const size = frame.data[1]
      if (size < CZONE_CONFIG_BLOCK_HEADER || size > 223) return
      configFastPacket = { key, source: frame.source, sequence, size, nextFrame: 1, payload: Buffer.from(frame.data.subarray(2)), timestamp: frame.timestamp, updatedAt: Date.now() }
    } else {
      if (!configFastPacket || configFastPacket.key !== key || frameNo !== configFastPacket.nextFrame) {
        configFastPacket = null
        return
      }
      configFastPacket.payload = Buffer.concat([configFastPacket.payload, frame.data.subarray(1)])
      configFastPacket.nextFrame = (configFastPacket.nextFrame + 1) & 0x1f
      configFastPacket.updatedAt = Date.now()
    }
    if (!configFastPacket || configFastPacket.payload.length < configFastPacket.size) return
    const packet = { pgn: frame.pgn, source: configFastPacket.source, timestamp: configFastPacket.timestamp, payload: configFastPacket.payload.subarray(0, configFastPacket.size) }
    configFastPacket = null
    handleConfigDataBlock(packet)
  }

  function readConfigurationFromNetwork () {
    if (configTransfer && configTransfer.status === 'reading') throw new Error('A CZone network configuration read is already in progress')
    if (!nmeaReady) throw new Error('NMEA 2000 output is not ready')
    fs.mkdirSync(configDir, { recursive: true })
    clearConfigTransfer()
    configFastPacket = null
    const startedAt = new Date().toISOString()
    configTransfer = { status: 'reading', startedAt, blocks: new Map(), receivedBytes: 0, blockCount: 0, target: null, source: null }
    lastNetworkConfig = configTransfer
    configTransferTimer = setTimeout(() => failConfigTransfer(`Timed out after ${CZONE_CONFIG_READ_TIMEOUT_MS / 1000}s waiting for the CZone configuration transfer`), CZONE_CONFIG_READ_TIMEOUT_MS)
    const line = nmea.emitPgn(app, { src: 0, pgn: nmea.CZONE_CONFIG_CLAIM_PGN, data: czone.configReadRequest() })
    configTransfer.requestLine = line
    log(`NMEA 2000 OUT: PGN ${nmea.CZONE_CONFIG_CLAIM_PGN} CZone READ CONFIGURATION DATA ${czone.hex(czone.configReadRequest())}`)
    return configTransfer
  }

  function installedZcfInfo () {
    const file = path.join(configDir, 'installation.zcf')
    if (!fs.existsSync(file)) return { exists: false, fileName: null, bytes: 0, vesselName: null, circuits: 0, modes: 0 }
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')) } catch (_) {}
    let parsed = null
    try { parsed = zcf.load(file) } catch (_) {}
    return {
      exists: true,
      fileName: (meta && meta.originalFileName) || 'installation.zcf',
      bytes: fs.statSync(file).size,
      vesselName: (meta && meta.vesselName) || (parsed && parsed.vesselName) || null,
      circuits: parsed ? parsed.circuits.length : null,
      modes: parsed ? parsed.modes.length : null
    }
  }

  function listNetworkConfigs () {
    fs.mkdirSync(networkConfigDir(), { recursive: true })
    return fs.readdirSync(networkConfigDir())
      .filter(name => /\.czone\.net$/i.test(name))
      .sort()
      .map(name => {
        const filePath = path.join(networkConfigDir(), name)
        let meta = null
        try { meta = JSON.parse(fs.readFileSync(`${filePath}.json`, 'utf8')) } catch (_) {}
        return { file: name, bytes: fs.statSync(filePath).size, metadata: meta }
      })
  }

  async function saveAndRestart (newSettings) {
    // Follow the same lifecycle pattern as the existing signalk-czone plugin:
    // persist the configuration first, then ask Signal K to restart this plugin
    // when the lifecycle callback is available. A missing callback must not turn
    // a successfully validated ZCF upload into an upload failure.
    await persistPluginOptions(newSettings)
    if (typeof restartPlugin === 'function') {
      restartPlugin(newSettings)
      return { restartRequested: true }
    }

    log('ZCF installed and configuration persisted, but Signal K did not provide a plugin restart callback; the new ZCF will be activated when the plugin next starts')
    return { restartRequested: false }
  }

  function hasNmea2000Source () {
    if (typeof app.getPath !== 'function') return false
    try {
      const sources = app.getPath('/sources')
      if (!sources || typeof sources !== 'object') return false
      return Object.values(sources).some(source => {
        if (!source || typeof source !== 'object') return false
        if (source.type === 'NMEA2000') return true
        return Object.values(source).some(value =>
          value && typeof value === 'object' && value.type === 'NMEA2000'
        )
      })
    } catch (_) {
      return false
    }
  }

  const plugin = {
    id: PLUGIN_ID,
    name: 'CZone Circuits',

    schema: () => ({
      type: 'object',
      properties: {
        enableSending: {
          type: 'boolean',
          title: 'Enable NMEA 2000 sending',
          default: false,
          description: 'Safety interlock for circuit and Mode control. Network configuration reads are explicit maintenance actions and do not require this control interlock.'
        },
        configurationSource: {
          type: 'string',
          title: 'Configuration source',
          enum: ['installedZcf', 'networkCache'],
          enumNames: ['Use installed/uploaded ZCF', 'Use saved network configuration'],
          default: 'installedZcf',
          description: 'Choose which local configuration the plugin loads at Signal K startup. Reading from the CZone network is a manual action below; it is never performed automatically during startup.'
        },
        networkConfigFile: {
          type: 'string',
          title: 'Saved network configuration',
          enum: ['', ...listNetworkConfigs().map(item => item.file)],
          enumNames: ['Select a saved .czone.net file', ...listNetworkConfigs().map(item => `${item.file} (${item.bytes} bytes)`)],
          default: '',
          description: 'Used when Configuration source is set to Saved network configuration. Use the CZone Circuits configuration panel to read a new configuration from the network.'
        },
        trendDirectory: {
          type: 'string',
          title: 'Trend folder (optional)',
          default: '',
          description: 'Leave blank for automatic: on a Victron GX, trends go to an SD card or USB stick (never internal flash); on other systems, to the Signal K data folder.'
        },
        trendSampleSeconds: {
          type: 'number',
          title: 'Trend sample rate',
          enum: [5, 10, 15, 30, 60],
          enumNames: ['5 seconds', '10 seconds', '15 seconds', '30 seconds', '1 minute'],
          default: 10,
          description: 'How often monitored values are sampled for trends. A value is only written when it changes (and at least every 10 minutes). Minimum 16 GB SD card or USB stick recommended.'
        },
        trendRetentionDays: {
          type: 'number',
          title: 'Keep full-detail trend data for',
          enum: [0, 31, 90, 365],
          enumNames: ['As long as there is space', '31 days', '90 days', '1 year'],
          default: 0,
          description: 'Ten-minute summaries are always kept. When storage runs low, the oldest full-detail days are removed first, then the oldest summaries.'
        },
        showVirtualCircuits: {
          type: 'boolean',
          title: 'Show virtual switch circuits',
          default: false,
          description: 'Circuits that only drive CZone virtual switches (VS 01, VS 02, …) are hidden from the webapp and the Victron switch pane unless this is ticked.'
        },
        victronSwitches: {
          type: 'boolean',
          title: 'Show CZone circuits in the Victron switch pane',
          default: false,
          description: 'Venus OS 3.60+ only. Adds every circuit to the GX switch pane (and VRM), grouped by CZone category. Switching from the pane still needs NMEA 2000 sending enabled.'
        },
        victronSwitchCurrent: {
          type: 'boolean',
          title: 'Show circuit current in the switch label',
          default: true,
          description: 'While a circuit is on, its switch reads e.g. "Light 1 · 1.5 A". The Venus OS switch pane does not display current itself yet.'
        }
      }
    }),

    start: (newSettings, restart) => {
      settings = { enableSending: false, configurationSource: 'installedZcf', networkConfigFile: '', ...(newSettings || {}) }
      restartPlugin = restart
      fs.mkdirSync(configDir, { recursive: true })
      loadConfiguredZcf()
      monitor.setControls({
        state: (slug, on) => sendCircuitState(circuitByName(slug), on),
        brightness: (slug, level) => sendCircuitBrightness(circuitByName(slug), level),
        // [fork] The decoded state the webapp shows, for the Victron switch pane.
        getState: slug => {
          const c = mapping && mapping.circuits.find(x => x.slug === slug || x.name === slug)
          return (c && runtimeState.get(c.name)) || null
        }
      })
      monitor.start(settings, zcfPath())
      registerCircuitPutHandlers()
      registerModePutHandlers()

      const ready = (reason = 'nmea2000OutAvailable event') => {
        nmeaReady = true
        nmeaReadyAt = new Date().toISOString()
        if (nmeaReadyRetryTimer) clearInterval(nmeaReadyRetryTimer)
        nmeaReadyRetryTimer = null
        log(`NMEA 2000 output is READY (${reason}; app.isNmea2000OutAvailable=${app.isNmea2000OutAvailable === true})`)
      }
      app.on('nmea2000OutAvailable', () => ready())
      nmeaReadyRetryCount = 0
      if (app.isNmea2000OutAvailable === true) {
        ready('plugin start')
      } else if (hasNmea2000Source()) {
        // Some Signal K / Venus OS combinations can expose the active N2K
        // source to plugins without updating the plugin's shallow
        // app.isNmea2000OutAvailable snapshot or delivering the one-shot
        // readiness event after the plugin listener is attached. The same
        // canboatjs connection handles both NMEA 2000 input and output, so
        // an active NMEA2000 source is a safe compatibility fallback.
        ready('active NMEA 2000 source detected')
      } else {
        nmeaReadyRetryTimer = setInterval(() => {
          if (app.isNmea2000OutAvailable === true) return ready('startup readiness check')
          if (hasNmea2000Source()) return ready('active NMEA 2000 source detected')
          nmeaReadyRetryCount += 1
          if (nmeaReadyRetryCount >= NMEA_READY_RETRY_LIMIT) {
            clearInterval(nmeaReadyRetryTimer)
            nmeaReadyRetryTimer = null
            log(`NMEA 2000 output readiness check ended after ${NMEA_READY_RETRY_LIMIT} attempts; waiting for nmea2000OutAvailable event or an active NMEA 2000 source`)
          }
        }, NMEA_READY_RETRY_MS)
      }

      if (typeof app.on === 'function') {
        reassembler = nmea.createFastPacketReassembler(packet => decodeDcStatePacket(packet))
        rawListener = handleRawFrame
        app.on('canboatjs:rawoutput', rawListener)
      }

      startupModeInferenceDone = false
      if (startupModeInferenceTimer) clearTimeout(startupModeInferenceTimer)
      startupModeInferenceTimer = setTimeout(() => {
        startupModeInferenceTimer = null
        if (!activeMode) {
          inferStartupMode('startup window')
          if (!activeMode) log('CZone startup mode reconciliation did not reach a confident match; mode remains unknown until an authoritative mode activation is observed')
        }
      }, 12000)

      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus(mapping
          ? `${settings.enableSending ? 'Sending ENABLED' : 'Sending disabled'} · Loaded ${mapping.circuits.length} CZone circuits`
          : `${settings.enableSending ? 'Sending ENABLED' : 'Sending disabled'} · Waiting for CZone ZCF upload`)
      }
    },

    stop: () => {
      monitor.stop()
      if (startupModeInferenceTimer) clearTimeout(startupModeInferenceTimer)
      startupModeInferenceTimer = null
      nmeaReady = false
      nmeaReadyAt = null
      if (nmeaReadyRetryTimer) clearInterval(nmeaReadyRetryTimer)
      nmeaReadyRetryTimer = null
      nmeaReadyRetryCount = 0
      lastNmeaOutput = null
      if (rawListener && typeof app.removeListener === 'function') app.removeListener('canboatjs:rawoutput', rawListener)
      rawListener = null
      if (reassembler) reassembler.clear()
      reassembler = null
      configFastPacket = null
      clearConfigTransfer()
      activeMode = null
      mapping = null
      runtimeState.clear()
      publishedCircuitValues.clear()
    },

    registerWithRouter: router => {
      monitor.registerRoutes(router)
      router.get('/status', (_req, res) => {
        res.json({
          sendingEnabled: settings.enableSending === true,
          nmeaReady,
          nmeaReadyAt,
          lastNmeaOutput,
          zcf: mapping ? { fileName: mapping.fileName, fileSize: mapping.fileSize, vesselName: mapping.vesselName || null, circuits: mapping.circuits.length, modes: mapping.modes.length, commandDeviceId: mapping.commandDeviceId, warnings: mapping.warnings } : null,
          configuration: { source: settings.configurationSource || 'installedZcf', networkConfigFile: settings.networkConfigFile || '', availableNetworkConfigs: listNetworkConfigs(), lastNetworkRead: lastNetworkConfig ? { ...lastNetworkConfig, blocks: undefined } : null },
          activeMode: activeMode ? { id: activeMode.id, runtimeId: activeMode.runtimeId, name: activeMode.name, slug: activeMode.slug, modeGroupId: activeMode.modeGroupId } : null
        })
      })

      router.get('/circuits', (_req, res) => {
        res.json({
          sendingEnabled: settings.enableSending === true,
          nmeaReady,
          nmeaReadyAt,
          lastNmeaOutput,
          file: mapping ? mapping.fileName : null,
          warnings: mapping ? mapping.warnings : [],
          modes: mapping ? mapping.modes : [],
          activeMode: activeMode ? { id: activeMode.id, runtimeId: activeMode.runtimeId, name: activeMode.name, slug: activeMode.slug, modeGroupId: activeMode.modeGroupId } : null,
          circuits: mapping
            ? mapping.circuits.map(c => ({
                ...c,
                state: runtimeState.get(c.name) || null,
                current: monitor.valueAt(`electrical.czone.${c.slug}.current`)
              }))
            : []
        })
      })

      router.get('/circuits/:name/state', (req, res) => {
        try {
          const circuit = circuitByName(req.params.name)
          const state = runtimeState.get(circuit.name) || null
          res.json({ ok: true, circuit: circuit.name, state })
        } catch (err) { res.status(400).json({ ok: false, error: err.message }) }
      })

      router.get('/modes', (_req, res) => {
        res.json({
          sendingEnabled: settings.enableSending === true,
          file: mapping ? mapping.fileName : null,
          active: activeMode ? { id: activeMode.id, runtimeId: activeMode.runtimeId, name: activeMode.name, slug: activeMode.slug, modeGroupId: activeMode.modeGroupId } : null,
          modes: mapping ? mapping.modes : []
        })
      })

      router.get('/configuration', (_req, res) => {
        res.json({
          source: settings.configurationSource || 'installedZcf',
          networkConfigFile: settings.networkConfigFile || '',
          current: mapping ? { fileName: mapping.fileName, vesselName: mapping.vesselName || null, bytes: mapping.fileSize, circuits: mapping.circuits.length, modes: mapping.modes.length } : null,
          installedZcf: installedZcfInfo(),
          availableNetworkConfigs: listNetworkConfigs(),
          networkRead: lastNetworkConfig ? { ...lastNetworkConfig, blocks: undefined } : null,
          nmeaReady
        })
      })

      router.post('/configuration/network/read', (_req, res) => {
        try {
          const state = readConfigurationFromNetwork()
          res.status(202).json({ ok: true, status: 'reading', startedAt: state.startedAt, message: 'CZone configuration read started. This does not change the active configuration.' })
        } catch (err) { res.status(400).json({ ok: false, error: err.message }) }
      })

      router.get('/configuration/network/status', (_req, res) => {
        res.json({
          nmeaReady,
          read: lastNetworkConfig ? { ...lastNetworkConfig, blocks: undefined } : null
        })
      })

      router.post('/configuration/network/use', async (req, res) => {
        try {
          const filename = path.basename(String((req.body && req.body.file) || ''))
          if (!/\.czone\.net$/i.test(filename)) throw new Error('Please select a .czone.net configuration file')
          const source = path.join(networkConfigDir(), filename)
          if (!fs.existsSync(source)) throw new Error(`Network configuration file not found: ${filename}`)
          const temp = path.join(configDir, `${Date.now()}.network-use.zcf.tmp`)
          fs.copyFileSync(source, temp)
          const next = zcf.load(temp)
          try { fs.unlinkSync(temp) } catch (_) {}
          const newSettings = {
            enableSending: settings.enableSending === true,
            configurationSource: 'networkCache',
            networkConfigFile: filename
          }
          const restartResult = await saveAndRestart(newSettings)
          res.json({ ok: true, file: filename, bytes: next.fileSize, vesselName: next.vesselName || null, configuration: newSettings, restartRequested: restartResult.restartRequested })
        } catch (err) { res.status(400).json({ ok: false, error: err.message }) }
      })

      router.post('/zcf/upload', async (req, res) => {
        try {
          const body = await readRequestBody(req)
          const file = parseMultipartSingleFile(body, req.headers['content-type'])
          if (!file.filename.toLowerCase().endsWith('.zcf')) throw new Error('Please upload a .zcf file')

          const target = path.join(configDir, 'installation.zcf')
          const temp = `${target}.tmp`
          fs.mkdirSync(configDir, { recursive: true })
          try {
            fs.writeFileSync(temp, file.data)
            const next = zcf.load(temp)
            fs.renameSync(temp, target)
            try {
              fs.writeFileSync(`${target}.json`, JSON.stringify({
                format: 'signalk-czone-installed-zcf',
                originalFileName: path.basename(file.filename),
                vesselName: next.vesselName || null,
                bytes: file.data.length,
                savedAt: new Date().toISOString()
              }, null, 2))
            } catch (_) {}
            const newSettings = {
              enableSending: settings.enableSending === true,
              configurationSource: 'installedZcf',
              networkConfigFile: ''
            }
            const restartResult = await saveAndRestart(newSettings)
            res.json({
              ok: true,
              file: path.basename(target),
              bytes: file.data.length,
              modes: next.modes,
              circuits: next.circuits,
              configuration: newSettings,
              restartRequested: restartResult.restartRequested,
              message: restartResult.restartRequested
                ? 'ZCF installed successfully. The plugin is restarting with the new configuration.'
                : 'ZCF installed successfully. Configuration was persisted; the new ZCF will be activated when the plugin next starts.'
            })
          } finally {
            try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (_) {}
          }
        } catch (err) {
          res.status(400).json({ ok: false, error: err.message })
        }
      })

      router.post('/modes/:name/activate', (req, res) => {
        try {
          const mode = modeByName(req.params.name)
          const line = sendMode(mode)
          res.json({
            ok: true,
            mode: {
              id: mode.id,
              runtimeId: mode.runtimeId,
              name: mode.name,
              slug: mode.slug,
              modeGroupId: mode.modeGroupId
            },
            line
          })
        } catch (err) { res.status(400).json({ ok: false, error: err.message }) }
      })

      router.post('/circuits/:name/on', (req, res) => {
        try {
          const circuit = circuitByName(req.params.name)
          const deviceId = commandDeviceId()
          const commands = circuit.capabilities.dimmer
            ? czone.dimmerOn(requireProtocolId(circuit), deviceId, 0x08)
            : [
                czone.on(requireProtocolId(circuit), deviceId, 0x08),
                czone.switchComplete(requireProtocolId(circuit), deviceId, 0x08)
              ]
          const lines = emitCommandSequence(circuit, commands, 'ON')
          const state = runtimeState.get(circuit.name)
          res.json({ ok: true, circuit: circuit.name, line: lines.at(-1), lines, state })
        } catch (err) { res.status(400).json({ ok: false, error: err.message }) }
      })

      router.post('/circuits/:name/off', (req, res) => {
        try {
          const circuit = circuitByName(req.params.name)
          const deviceId = commandDeviceId()
          const commands = circuit.capabilities.dimmer
            ? czone.dimmerOff(requireProtocolId(circuit), deviceId, 0x08)
            : [
                czone.off(requireProtocolId(circuit), deviceId, 0x08),
                czone.switchComplete(requireProtocolId(circuit), deviceId, 0x08)
              ]
          const lines = emitCommandSequence(circuit, commands, 'OFF')
          const state = runtimeState.get(circuit.name)
          res.json({ ok: true, circuit: circuit.name, line: lines.at(-1), lines, state })
        } catch (err) { res.status(400).json({ ok: false, error: err.message }) }
      })

      router.post('/circuits/:name/level', (req, res) => {
        try {
          const circuit = circuitByName(req.params.name)
          const percent = Number(req.body && req.body.percent)
          if (circuit.capabilities.dimmer) {
            const commands = []
            const state = runtimeState.get(circuit.name)
            if (!state || state.state !== 'ON') {
              commands.push(...czone.dimmerOn(requireProtocolId(circuit), commandDeviceId(), 0x08))
            }
            commands.push(czone.level(requireProtocolId(circuit), percent, commandDeviceId(), 0x08))
            const lines = emitCommandSequence(circuit, commands, `LEVEL ${Math.round(percent)}%${commands.length > 1 ? ' + ON' : ''}`)
            res.json({ ok: true, circuit: circuit.name, line: lines.at(-1), lines, state: runtimeState.get(circuit.name) })
          } else {
            const data = czone.level(requireProtocolId(circuit), percent, commandDeviceId(), 0x08)
            const line = emitCommandSequence(circuit, [data], `LEVEL ${Math.round(percent)}%`)
            const state = runtimeState.get(circuit.name)
            res.json({ ok: true, circuit: circuit.name, line: line.at(-1), lines: line, state })
          }
        } catch (err) { res.status(400).json({ ok: false, error: err.message }) }
      })
    }
  }

  return plugin
}
