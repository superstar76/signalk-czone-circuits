'use strict'

// Builds the Monitor catalogue from the ZCF (Meters and Inputs tables plus
// circuit currents) and resolves each reading to a Signal K path.
//
// Each reading lists candidate Signal K paths; at runtime the first candidate
// that has a value is used. Readings with no candidates are reported as
// "not mapped yet" together with the reason.

const { parseMeters, parseInputs } = require('../zcf-monitor')
const { parseCircuits } = require('../zcf-circuits')

// NMEA 2000 temperature source (PGN 130312/130316) -> Signal K location.
const TEMPERATURE_SOURCE = {
  0: 'environment.water',
  1: 'environment.outside',
  2: 'environment.inside',
  3: 'environment.inside.engineRoom',
  4: 'environment.inside.mainCabin',
  5: 'tanks.liveWell',
  6: 'tanks.baitWell',
  7: 'environment.inside.refrigerator',
  8: 'environment.inside.heating',
  13: 'environment.inside.freezer'
}

const slug = name => String(name || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'CZoneCircuit'
const reading = (key, label, unit, candidates) => ({ key, label, unit, candidates: candidates.filter(Boolean) })

function meterItem (m) {
  const id = `meter.${m.type}.${m.instance}${m.virtual ? '' : `.m${m.module}`}`
  // Every meter uses its configured NMEA 2000 instance from the ZCF (bench:
  // Meter Interface "House Battery" instance 0 -> electrical.batteries.0).
  // Other devices can publish the same instance (the Cerbo re-broadcasts its
  // own battery as instance 0), so a wired meter is read only from its own
  // module's NMEA 2000 source address.
  const n = m.instance
  const sourceModule = m.virtual ? undefined : m.module
  const withSource = r => (sourceModule === undefined ? r : { ...r, sourceModule })
  if (m.type === 'DC') {
    const base = `electrical.batteries.${n}`
    return {
      id, name: m.name, group: 'Batteries', source: 'zcf-meter', instance: n, module: m.module, virtual: m.virtual,
      readings: [
        reading('voltage', 'Voltage', 'V', [`${base}.voltage`]),
        reading('current', 'Current', 'A', [`${base}.current`]),
        reading('soc', 'State of charge', 'ratio', [`${base}.capacity.stateOfCharge`, `${base}.stateOfCharge`]),
        reading('temperature', 'Temperature', 'K', [`${base}.temperature`])
      ].map(withSource)
    }
  }
  const ac = `electrical.ac.${n}`
  return {
    id, name: m.name, group: 'AC Power', source: 'zcf-meter', instance: n, module: m.module, virtual: m.virtual,
    readings: [
      reading('voltage', 'Voltage', 'V', [`${ac}.phase.A.lineNeutralVoltage`, `${ac}.voltage`]),
      reading('current', 'Current', 'A', [`${ac}.phase.A.current`, `${ac}.current`]),
      reading('power', 'Power', 'W', [`${ac}.phase.A.realPower`, `${ac}.power`]),
      reading('frequency', 'Frequency', 'Hz', [`${ac}.phase.A.frequency`, `${ac}.frequency`])
    ].map(withSource)
  }
}

function inputItem (i) {
  const base = { name: i.name, source: i.thirdParty ? 'zcf-sender' : 'zcf-input' }
  if (i.type === 'tank' && typeof i.fluidType === 'string') {
    const t = `tanks.${i.fluidType}.${i.instance}`
    return {
      ...base, id: `tank.${i.fluidType}.${i.instance}`, group: 'Tanks', instance: i.instance,
      readings: [
        reading('level', 'Level', 'ratio', [`${t}.currentLevel`]),
        reading('volume', 'Volume', 'm3', [`${t}.currentVolume`])
      ]
    }
  }
  if (i.type === 'temperature') {
    const loc = TEMPERATURE_SOURCE[i.source]
    const candidates = loc
      ? [`${loc}.${i.instance}.temperature`, `${loc}.temperature`, `environment.temperature.${i.instance}.temperature`]
      : [`environment.temperature.${i.instance}.temperature`]
    return {
      ...base, id: `temperature.${i.source}.${i.instance}`, group: 'Temperatures', instance: i.instance,
      readings: [reading('temperature', 'Temperature', 'K', candidates)]
    }
  }
  if (i.type === 'pressure') {
    const candidates = i.source === 0 ? ['environment.outside.pressure'] : [`environment.pressure.${i.instance}.pressure`]
    return { ...base, id: `pressure.${i.source}.${i.instance}`, group: 'Environment', instance: i.instance, readings: [reading('pressure', 'Pressure', 'Pa', candidates)] }
  }
  if (i.type === 'switch') {
    return {
      ...base, id: `input.m${i.module}.${i.input}`, group: 'Inputs', module: i.module, input: i.input, wiring: i.wiring,
      readings: [],
      note: 'Switch input state source on the bus not yet identified'
    }
  }
  return {
    ...base, id: `sender.m${i.module}.${i.input}`, group: 'Other', readings: [],
    note: `Sender type 0x${i.kind.toString(16).padStart(2, '0')} not mapped yet`
  }
}

function circuitCurrentItems (circuits) {
  return circuits
    .filter(c => c.outputs.some(o => o.levelRaw > 0))
    .map(c => ({
      id: `circuit.${c.id}`,
      name: c.name.trim(),
      group: 'Circuit current',
      source: 'signalk-czone',
      circuitId: c.id,
      readings: [reading('current', 'Current', 'A', [`electrical.czone.${slug(c.name)}.current`])]
    }))
}

// Build the catalogue from a ZCF buffer. Never throws: a table that cannot be
// read is reported in `warnings` and the rest of the catalogue still builds.
function buildCatalog (buf) {
  const items = []
  const warnings = []
  if (!Buffer.isBuffer(buf)) return { items, warnings: ['No ZCF loaded'] }

  const meters = safe(() => parseMeters(buf), warnings, 'Meters table')
  if (meters) items.push(...meters.meters.map(meterItem))
  else warnings.push('Meters table not found')

  const inputs = safe(() => parseInputs(buf), warnings, 'Inputs table')
  if (inputs) items.push(...inputs.inputs.map(inputItem))
  else warnings.push('Inputs table not found')

  const circuits = safe(() => parseCircuits(buf), warnings, 'Circuit table')
  if (circuits) items.push(...circuitCurrentItems(circuits))

  return { items, warnings }
}

function safe (fn, warnings, label) {
  try { return fn() } catch (err) { warnings.push(`${label}: ${err.message}`); return null }
}

// Trend/series key: the path, plus the source module for source-filtered readings.
function seriesKey (path, sourceModule) {
  return sourceModule === undefined ? path : `${path}@czone-${Number(sourceModule).toString(16).padStart(2, '0')}`
}

// Pick, for each reading, the first candidate path that currently has a value
// (from the required source module, when the reading names one).
function resolveCatalog (items, getValue) {
  return items.map(item => {
    const readings = item.readings.map(r => {
      const hit = r.candidates.find(p => getValue(p, r.sourceModule) !== undefined)
      return {
        ...r,
        path: hit || null,
        series: hit ? seriesKey(hit, r.sourceModule) : null,
        value: hit ? getValue(hit, r.sourceModule) : null
      }
    })
    const mapped = readings.some(r => r.path)
    return { ...item, readings, mapped }
  })
}

module.exports = { buildCatalog, resolveCatalog, seriesKey, slug, TEMPERATURE_SOURCE }
