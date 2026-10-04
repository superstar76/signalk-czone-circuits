// Monitoring view for the CZone Circuits webapp.
//
// Items come from /monitor/items (built from the ZCF Meters and Inputs tables
// plus circuit current). Trends come from /trend (SD card on the GX).
// The host page calls window.czoneMonitor.show(true|false) when the Monitoring
// nav entry is selected, and reads window.czoneMonitor.count() for the badge.
(() => {
  const API = '/plugins/signalk-czone-circuits';
  const GROUPS = ['Batteries', 'Solar', 'Alternators', 'Converters', 'Wind Generators', 'AC Power', 'Tanks', 'Temperatures', 'Environment', 'Circuit current', 'Inputs', 'Other'];
  // Group icon + colour token. Colours are CSS variables in monitor.css so a
  // future theme configurator can set them; defaults reuse the webapp palette.
  const GROUP_STYLE = {
    Batteries: ['🔋', 'batteries'], Solar: ['☀', 'solar'], Alternators: ['⚙', 'alternators'], Converters: ['⇄', 'converters'], 'Wind Generators': ['༄', 'wind'], 'AC Power': ['♆', 'ac'], Tanks: ['◒', 'tanks'], Temperatures: ['🌡', 'temperatures'],
    Environment: ['◎', 'environment'], 'Circuit current': ['⚡', 'current'], Inputs: ['⏻', 'inputs'], Other: ['•••', 'other']
  }
  const groupOf = item => GROUPS.includes(item.group) ? item.group : 'Other'
  const groupVar = g => `var(--mon-${(GROUP_STYLE[g] || GROUP_STYLE.Other)[1]})`
  // [fork] drawn icons on a chartplotter, whose fonts lack these symbols
  const groupIcon = g => window.czoneMfdIcon ? window.czoneMfdIcon(g) : (GROUP_STYLE[g] || GROUP_STYLE.Other)[0]
  const RANGES = [['1h', '1 h'], ['24h', '24 h'], ['7d', '7 d'], ['31d', '31 d'], ['90d', '90 d'], ['1y', '1 y']];
  const RANGE_MS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '31d': 31 * 86400e3, '90d': 90 * 86400e3, '1y': 365 * 86400e3 };
  const PREF_KEY = 'signalk-czone-circuits:monitor';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Lists are updated in place where the host page offers it: only values that
  // changed are touched, so the value boxes do not flicker on a slow screen.
  const put = (el, html) => { if (window.czonePatch) window.czonePatch(el, html); else el.innerHTML = html }

  let items = []
  let trend = { available: false }
  let visible = false
  let groupFilter = null // one group only, chosen in the host page's category list
  let pollTimer = null
  let prefs = { showUnmapped: false }
  try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') } } catch (_) {}
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)) } catch (_) {} }

  // ---- Units: Signal K is SI; show what a skipper reads on the panel.
  function convert (unit, v, path) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    switch (unit) {
      case 'K': return { v: v - 273.15, u: '°C', d: 1 }
      case 'ratio': return { v: v * 100, u: '%', d: 0 }
      case 'Pa': return /outside\.pressure$/.test(path || '') || v > 50000 ? { v: v / 100, u: 'hPa', d: 0 } : { v: v / 1000, u: 'kPa', d: 0 }
      case 'm3': return { v: v * 1000, u: 'L', d: 0 }
      case 'V': return { v, u: 'V', d: /^electrical\.ac\./.test(path || '') ? 1 : 2 }
      case 'A': return { v, u: 'A', d: 1 }
      case 'W': return { v, u: 'W', d: 0 }
      case 'Hz': return { v, u: 'Hz', d: 1 }
      default: return { v, u: unit || '', d: 2 }
    }
  }
  const fmt = (unit, v, path) => { const c = convert(unit, v, path); return c ? { text: c.v.toFixed(c.d), unit: c.u } : { text: '—', unit: '' } }

  // ---- DOM scaffolding (added once, next to the circuits section)
  function mount () {
    if (document.querySelector('#monitorView')) return
    const main = document.querySelector('.main')
    const section = document.createElement('section')
    section.className = 'section'
    section.id = 'monitorView'
    section.innerHTML = `
      <div class="section-head"><span class="mon-head-icon">◔</span><div><h2>Monitoring</h2><span class="subtle" id="monCount"></span></div>
        <span class="mon-pill" id="monTrend"><i></i><span>Checking SD card…</span></span>
        <label class="mon-check"><input type="checkbox" id="monShowAll"> Show unmapped</label>
      </div>
      <div class="mon-card-fix" id="monCardFix" hidden>
        <strong id="monCardFixHead"></strong>
        <ol>
          <li><a href="${API}/trend/card-setup" download="venus-data.tgz">Download venus-data.tgz</a></li>
          <li id="monCardFixCopy"></li>
          <li>Restart the GX. Trends start by themselves, and keep working after updates</li>
        </ol>
      </div>
      <div id="monBody"><div class="empty">Loading…</div></div>`
    main.appendChild(section)
    const cb = section.querySelector('#monShowAll')
    cb.checked = !!prefs.showUnmapped
    cb.addEventListener('change', () => { prefs.showUnmapped = cb.checked; savePrefs(); render(); if (typeof window.czoneMonitorReady === 'function') window.czoneMonitorReady() })
    section.addEventListener('click', onClick)

    const panel = document.createElement('section')
    panel.className = 'section mon-trend'
    panel.id = 'monPanel'
    panel.innerHTML = `
      <div class="section-head"><span class="mon-trend-icon" id="monIcon"></span><div><h2 id="monTitle"></h2><span class="subtle" id="monSub"></span></div><button class="sort mon-close" aria-label="Close trend" data-close>✕ Close</button></div>
      <div class="mon-controls"><div class="mon-seg" id="monReadings"></div><div class="mon-seg" id="monRanges"></div><div class="mon-seg" id="monMode"></div><button class="sort mon-add" id="monAdd">＋ Add value</button></div>
      <div class="mon-custom" id="monCustom"><label>From <input type="datetime-local" id="monFrom"></label><label>To <input type="datetime-local" id="monTo"></label><button class="sort" id="monApply">Apply</button><span id="monCustomMsg"></span></div>
      <div class="mon-picker" id="monPicker"><input type="search" id="monSearch" placeholder="Search values…" aria-label="Search values"><div id="monPickList"></div></div>
      <div class="mon-stats" id="monStats"></div>
      <div class="mon-legend" id="monLegend"></div>
      <div class="mon-chart"><canvas id="monCanvas"></canvas><div class="mon-tip" id="monTip"></div><div class="mon-chart-msg" id="monMsg"></div></div>`
    // [fork] Above the first list on the page, so a trend opens at the top
    // whichever tab it is opened from (it used to sit between the circuit list
    // and the Monitoring list: top of Monitoring, bottom of the circuit tabs).
    main.insertBefore(panel, main.querySelector('.section') || section)
    panel.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeTrend() })
    panel.querySelector('#monReadings').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setPrimaryReading(b.dataset.key) })
    panel.querySelector('#monRanges').addEventListener('click', e => {
      const b = e.target.closest('button')
      if (!b) return
      if (b.dataset.range === 'custom') { chart.customOpen = true; controls(); return } // nothing reloads until Apply
      chart.customOpen = false; chart.custom = null; chart.range = b.dataset.range
      loadTrend()
    })
    panel.querySelector('#monApply').addEventListener('click', applyCustom)
    panel.querySelector('#monCustom').addEventListener('keydown', e => { if (e.key === 'Enter') applyCustom() })
    panel.querySelector('#monMode').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { chart.mode = b.dataset.mode; prefs.trendMode = chart.mode; savePrefs(); chart.hover = null; controls(); draw() } })
    panel.querySelector('#monAdd').addEventListener('click', () => {
      chart.picker = !chart.picker
      if (chart.picker) panel.querySelector('#monSearch').value = ''
      controls()
      if (chart.picker) panel.querySelector('#monSearch').focus()
    })
    panel.querySelector('#monSearch').addEventListener('input', pickerList)
    panel.querySelector('#monPickList').addEventListener('click', e => { const b = e.target.closest('[data-add]'); if (b) addSeries(b.dataset.add, b.dataset.key) })
    panel.querySelector('#monLegend').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) removeSeries(b.dataset.remove) })
    const canvas = panel.querySelector('#monCanvas')
    canvas.addEventListener('mousemove', e => hover(e.offsetX))
    canvas.addEventListener('mouseleave', () => { chart.hover = null; draw(); document.querySelector('#monTip').style.display = 'none' })
    canvas.addEventListener('touchmove', e => { const r = canvas.getBoundingClientRect(); hover(e.touches[0].clientX - r.left) }, { passive: true })
    document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (chart.picker) { chart.picker = false; controls() } else closeTrend() })
    window.addEventListener('resize', () => { if (chart.open) draw() })
  }

  // ---- Data
  async function refresh () {
    try {
      const r = await fetch(`${API}/monitor/items`, { cache: 'no-store', credentials: 'include' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      items = Array.isArray(data.items) ? data.items : []
      if (visible) render()
      if (typeof window.czoneMonitorReady === 'function') window.czoneMonitorReady()
    } catch (e) {
      if (visible) put(document.querySelector('#monBody'), `<div class="empty">Monitoring data unavailable (${esc(e.message)}).</div>`)
    }
  }
  async function refreshTrendStatus () {
    try {
      const r = await fetch(`${API}/trend/status`, { cache: 'no-store', credentials: 'include' })
      trend = await r.json()
    } catch (_) { trend = { available: false, reason: 'unavailable' } }
    const pill = document.querySelector('#monTrend')
    if (!pill) return
    pill.classList.toggle('ok', !!trend.available)
    pill.title = trend.detail || trend.dir || ''
    const fix = document.querySelector('#monCardFix')
    // On a GX: a card that is there but closed to Signal K, or no card yet.
    // Either way the owner needs the setup file, so offer it in both cases.
    const closed = trend.available === false && trend.reason === 'write_failed' && !!trend.mount
    const none = trend.available === false && trend.reason === 'no_sd_card'
    if (fix) {
      fix.hidden = !(closed || none)
      fix.querySelector('#monCardFixHead').textContent = closed
        ? 'Trends are off: the GX will not let Signal K write to this card yet.'
        : 'Trends need an SD card or USB stick in the GX (16 GB or larger). Before fitting it:'
      fix.querySelector('#monCardFixCopy').textContent = closed
        ? 'Take the card out, copy the file onto it (not into a folder) with a computer, and put the card back'
        : 'Copy the file onto the card (not into a folder) with a computer, and put the card in the GX'
    }
    pill.querySelector('span').textContent = trend.available
      ? `Trending ${trend.trending || 0} values · every ${trend.sampleSeconds || 10} s · ${trend.location !== 'removable' ? 'on disk' : trend.mount && /\/(sd|usb)/.test(trend.mount) ? 'on USB' : 'on SD card'}${typeof trend.freeBytes === 'number' ? ` · ${(trend.freeBytes / 1073741824).toFixed(1)} GB free` : ''}`
      : trend.reason === 'no_sd_card' ? 'No SD card or USB stick: trends off' : trend.reason === 'write_failed' ? 'Card found but not writable: trends off' : 'Trends unavailable'
  }
  function schedule () {
    clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => { await refresh(); schedule() }, visible ? 5000 : 60000)
  }

  // ---- Rendering
  const primary = item => item.readings.find(r => r.path) || item.readings[0]
  // Where a reading's trend is stored: its live series, or the one it was last
  // recorded under (a sensor that is switched off still has a history).
  const trendKey = r => r.series || r.history || null
  const trendable = item => { const live = item.readings.filter(r => r.series); return live.length ? live : item.readings.filter(r => r.history) }
  const sortByName = (a, b) => a.name.localeCompare(b.name)

  // Rows reuse the webapp's own circuit-row classes so Monitoring looks like
  // the circuit list: name + subtitle, tags, status dot, value box, arrow.
  // Group names as shown (the catalogue keeps its own keys).
  const GROUP_LABEL = { 'Circuit current': 'Circuits' }
  const groupLabel = g => GROUP_LABEL[g] || g

  // One value box per live reading (e.g. battery V / A / %), each opens its trend.
  function valueBox (item, r) {
    const f = fmt(r.unit, r.value, r.path)
    const on = chart.open && chart.series.some(s => s.id === seriesId(item, r)) ? 'active' : ''
    const level = r.unit === 'ratio' && typeof r.value === 'number' ? `<span class="mon-level"><span style="width:${Math.max(0, Math.min(100, r.value * 100))}%"></span></span>` : ''
    // [fork] A value box opens that value's trend, and so does the arrow at
    // the end of the row. The rest of the row does not (a touch anywhere on
    // it used to, by accident).
    const attrs = r.series ? `data-item="${esc(item.id)}" data-key="${esc(r.key)}" title="${esc(r.label)}: show trend"` : `title="${esc(r.label)}"`
    return `<div class="mon-value ${on} ${r.series ? 'clickable' : ''}" ${attrs}><span>${f.text}<small>${esc(f.unit)}</small></span>${level}</div>`
  }

  function row (item) {
    const p = primary(item)
    const g = groupOf(item)
    const where = item.group === 'Circuit current' && item.outputs && item.outputs[0]
      ? `module ${Number(item.outputs[0].module).toString(16).padStart(2, '0').toUpperCase()} / ch ${item.outputs.map(o => o.channel).join(', ')}`
      : item.instance !== undefined ? `instance ${item.instance}`
        : item.module ? `module ${Number(item.module).toString(16).padStart(2, '0').toUpperCase()}${item.input !== undefined ? ` / input ${item.input + 1}` : ''}` : ''
    // Not on the bus: say which NMEA 2000 instance the ZCF expects, since that
    // is the number to set on the sending device.
    const waiting = item.instance !== undefined ? `Nothing is sending instance ${item.instance} on NMEA 2000` : `Waiting for ${(p && p.candidates[0]) || 'a Signal K path'}`
    const sub = item.mapped ? (where || groupLabel(g)) : (item.note || waiting)
    const live = item.mapped
    const shown = live ? item.readings.filter(r => r.path) : (p ? [p] : [])
    const active = chart.open && chart.series.some(s => s.item.id === item.id) ? 'active' : ''
    const clickable = p && trendKey(p)
    return `<div class="circuit mon-row ${shown.length > 1 ? 'multi' : ''} ${live ? '' : 'unmapped'} ${active}" style="--cat:${groupVar(g)}">
      <span class="mon-icon">${groupIcon(g)}</span>
      <div class="circuit-name"><strong>${esc(item.name)}</strong><small>${esc(sub)}</small></div>
      <div class="mon-right"><div class="status ${live ? 'on' : ''}"><span class="status-dot"></span>${live ? 'LIVE' : 'NOT ON BUS'}</div><div class="mon-values">${shown.map(r => valueBox(item, r)).join('')}</div></div>
      ${clickable ? `<button type="button" class="arrow trend-arrow" title="Trend" aria-label="${esc(item.name)} trend" data-item="${esc(item.id)}" data-key="${esc(p.key)}">›</button>` : '<span class="arrow"></span>'}</div>`
  }

  // Circuit current is trended from the circuit list (arrow beside ON/OFF),
  // not listed again here.
  const monitored = () => items.filter(i => i.group !== 'Circuit current')

  function render () {
    const body = document.querySelector('#monBody')
    if (!body) return
    const all = monitored()
    const mapped = all.filter(i => i.mapped).length
    document.querySelector('#monCount').textContent = `${mapped} of ${all.length} items live`
    const shown = all.filter(i => prefs.showUnmapped || i.mapped)
    if (!all.length) { put(body, '<div class="empty">No meters or inputs found in the ZCF.</div>'); return }
    if (!shown.length) { put(body, '<div class="empty">Nothing from the ZCF is on the bus yet. Tick “Show unmapped” to see what is expected.</div>'); return }
    if (groupFilter && !shown.some(i => groupOf(i) === groupFilter)) groupFilter = null // that group has gone
    put(body, GROUPS.filter(g => !groupFilter || g === groupFilter).map(g => {
      const list = shown.filter(i => groupOf(i) === g)
      if (!list.length) return ''
      const live = list.filter(i => i.mapped).length
      if (g === 'Circuit current') list.sort((a, b) => (primary(b).value || 0) - (primary(a).value || 0) || sortByName(a, b))
      else list.sort(sortByName)
      return `<div class="mon-subhead" style="--cat:${groupVar(g)}"><span class="mon-icon">${groupIcon(g)}</span><strong>${esc(groupLabel(g))}</strong><span class="subtle">${live} of ${list.length} live</span></div>${list.map(row).join('')}`
    }).join(''))
  }

  function onClick (e) {
    const b = e.target.closest('[data-item]')
    if (!b || b.disabled) return
    const item = items.find(i => i.id === b.dataset.item)
    if (item) openTrend(item, b.dataset.key)
  }

  // ---- Trend chart
  // One chart, up to MAX_SERIES values. The first is the one the trend was
  // opened from and keeps its group colour; added values take the next free
  // palette colour and keep it until removed. Each unit has its own scale.
  const MAX_SERIES = 5
  // Categorical palette for added values (validated for the dark panel; no red: red reads as an alarm).
  const OVERLAY_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9']
  const chart = { open: false, item: null, key: null, series: [], range: '24h', custom: null, customOpen: false, picker: false, mode: prefs.trendMode === 'stacked' ? 'stacked' : 'overlay', start: 0, end: 0, hover: null, timer: null, seq: 0 }

  // CSS colour (var(), hex, …) -> [r, g, b]; canvas and colour distance need numbers.
  function cssRgb (color) {
    const probe = document.createElement('span')
    probe.style.color = color
    document.querySelector('#monPanel').appendChild(probe)
    const rgb = (getComputedStyle(probe).color.match(/[\d.]+/g) || [24, 213, 232]).slice(0, 3).map(Number)
    probe.remove()
    return rgb
  }
  const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
  // Perceptual distance (OKLab × 100): keeps an added colour off the first one's.
  function colorDistance (a, b) {
    const lab = rgb => {
      const [r, g, bl] = rgb.map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) })
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl)
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl)
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl)
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
    }
    const x = lab(a); const y = lab(b)
    return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
  }

  const seriesId = (item, r) => `${item.id}|${r.key}`
  function makeSeries (item, r, rgb) {
    const probe = convert(r.unit, 0, r.path)
    return { id: seriesId(item, r), item, r, rgb, unit: probe ? probe.u : '', data: [], gapMs: 0 }
  }
  function nextColor () {
    const used = chart.series.map(s => s.rgb.join())
    const first = chart.series[0].rgb
    for (const hex of OVERLAY_COLORS) {
      const rgb = cssRgb(hex)
      if (!used.includes(rgb.join()) && colorDistance(rgb, first) >= 15) return rgb
    }
    return cssRgb(OVERLAY_COLORS[0])
  }
  const seriesName = s => trendable(s.item).length > 1 || s.item.group === 'Circuit current' ? `${s.item.name} · ${s.r.label}` : s.item.name

  function openTrend (item, key) {
    const readings = trendable(item)
    const r = readings.find(x => x.key === key) || readings[0]
    if (!r) return
    chart.open = true
    chart.item = item
    chart.key = r.key
    chart.picker = false
    const panel = document.querySelector('#monPanel')
    const g = groupOf(item)
    panel.style.setProperty('--cat', groupVar(g))
    panel.classList.add('show')
    chart.series = [makeSeries(item, r, cssRgb('var(--cat)'))]
    document.querySelector('#monIcon').innerHTML = `<div class="cat-icon">${groupIcon(g)}</div>`
    document.querySelector('#monTitle').textContent = item.name
    render()
    loadTrend()
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function closeTrend () {
    chart.open = false
    clearInterval(chart.timer)
    const p = document.querySelector('#monPanel')
    if (p) p.classList.remove('show')
    render()
  }
  // The reading buttons (Voltage / Current / …) change the first value only.
  function setPrimaryReading (key) {
    const r = trendable(chart.item).find(x => x.key === key)
    if (!r) return
    const id = seriesId(chart.item, r)
    chart.series = chart.series.filter((s, i) => i === 0 || s.id !== id)
    chart.series[0] = makeSeries(chart.item, r, chart.series[0].rgb)
    chart.key = r.key
    render()
    loadTrend()
  }
  function addSeries (itemId, key) {
    const item = items.find(i => i.id === itemId)
    const r = item && trendable(item).find(x => x.key === key)
    if (!r || chart.series.length >= MAX_SERIES || chart.series.some(s => s.id === seriesId(item, r))) return
    chart.series.push(makeSeries(item, r, nextColor()))
    chart.picker = false
    loadTrend()
  }
  function removeSeries (id) {
    const i = chart.series.findIndex(s => s.id === id)
    if (i <= 0) return
    chart.series.splice(i, 1)
    chart.hover = null
    controls(); legend(); draw()
  }

  // datetime-local wants local time as YYYY-MM-DDTHH:MM.
  const toLocalInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16) }
  const units = () => [...new Set(chart.series.map(s => s.unit))]

  function controls () {
    const readings = trendable(chart.item)
    const first = chart.series[0]
    document.querySelector('#monSub').textContent = chart.series.length > 1
      ? `${chart.series.length} values`
      : `${first.r.path || first.r.candidates[0]}${first.r.sourceModule !== undefined ? ` · from module ${Number(first.r.sourceModule).toString(16).padStart(2, '0').toUpperCase()}` : ''}`
    const seg = document.querySelector('#monReadings')
    seg.innerHTML = readings.length > 1 ? readings.map(x => `<button data-key="${esc(x.key)}" class="${x.key === first.r.key ? 'active' : ''}">${esc(x.label)}</button>`).join('') : ''
    seg.style.display = readings.length > 1 ? '' : 'none'
    const customOn = chart.customOpen || chart.range === 'custom'
    document.querySelector('#monRanges').innerHTML = RANGES.map(([k, l]) => `<button data-range="${k}" class="${!customOn && k === chart.range ? 'active' : ''}">${l}</button>`).join('') +
      `<button data-range="custom" class="${customOn ? 'active' : ''}">Custom</button>`
    document.querySelector('#monCustom').classList.toggle('show', customOn)
    const mode = document.querySelector('#monMode')
    mode.style.display = units().length > 1 ? '' : 'none'
    mode.innerHTML = [['overlay', 'Overlay'], ['stacked', 'Stacked']].map(([k, l]) => `<button data-mode="${k}" class="${chart.mode === k ? 'active' : ''}">${l}</button>`).join('')
    const add = document.querySelector('#monAdd')
    add.disabled = chart.series.length >= MAX_SERIES
    add.title = add.disabled ? `Up to ${MAX_SERIES} values on one chart` : 'Add another value to this chart'
    add.classList.toggle('active', chart.picker)
    document.querySelector('#monPicker').classList.toggle('show', chart.picker)
    if (chart.picker) pickerList()
  }

  // Everything that is being trended can be added: meters, senders and circuit currents.
  function pickerList () {
    const q = (document.querySelector('#monSearch').value || '').trim().toLowerCase()
    const have = new Set(chart.series.map(s => s.id))
    const html = GROUPS.map(g => {
      const rows = []
      // Live values first; ones that are off (history only) after them.
      const isLive = i => i.readings.some(r => r.series)
      for (const item of items.filter(i => groupOf(i) === g).sort((x, y) => Number(isLive(y)) - Number(isLive(x)) || sortByName(x, y))) {
        for (const r of trendable(item)) {
          if (have.has(seriesId(item, r))) continue
          const c = convert(r.unit, 0, r.path)
          if (q && !`${item.name} ${r.label} ${groupLabel(g)}`.toLowerCase().includes(q)) continue
          rows.push(`<button data-add="${esc(item.id)}" data-key="${esc(r.key)}"><span>${esc(item.name)}</span><small>${esc(r.label)}${c && c.u ? ` · ${esc(c.u)}` : ''}${r.series ? '' : ' · not live'}</small></button>`)
        }
      }
      return rows.length ? `<div class="mon-pick-group" style="--cat:${groupVar(g)}"><span class="mon-icon">${groupIcon(g)}</span>${esc(groupLabel(g))}</div>${rows.join('')}` : ''
    }).join('')
    document.querySelector('#monPickList').innerHTML = html || '<div class="empty">Nothing else to add.</div>'
  }

  function applyCustom () {
    const from = new Date(document.querySelector('#monFrom').value).getTime()
    const to = new Date(document.querySelector('#monTo').value).getTime()
    const msg = document.querySelector('#monCustomMsg')
    if (!Number.isFinite(from) || !Number.isFinite(to)) { msg.textContent = 'Enter a start and an end.'; return }
    if (to <= from) { msg.textContent = 'The start must be before the end.'; return }
    msg.textContent = ''
    chart.range = 'custom'
    chart.custom = { from, to }
    loadTrend()
  }

  async function loadTrend () {
    if (!chart.series.length) return
    controls()
    const seq = ++chart.seq
    setMsg('Loading…')
    const query = chart.range === 'custom' && chart.custom ? `from=${chart.custom.from}&to=${chart.custom.to}` : `range=${chart.range}`
    const wanted = chart.series.slice()
    const results = await Promise.all(wanted.map(async s => {
      try {
        const resp = await fetch(`${API}/trend?path=${encodeURIComponent(trendKey(s.r))}&${query}`, { cache: 'no-store', credentials: 'include' })
        return await resp.json()
      } catch (e) { return { available: false, detail: e.message } }
    }))
    if (seq !== chart.seq || !chart.open) return
    wanted.forEach((s, i) => {
      const res = results[i]
      // Rows are [t, value] (full detail) or [t, avg, min, max] (summarised).
      // Kept as [t, value, decimals, min, max]; min/max are null for full detail.
      s.data = (res.data || []).map(([t, v, lo, hi]) => {
        const c = convert(s.r.unit, v, s.r.path)
        if (!c) return null
        const cl = lo === undefined ? null : convert(s.r.unit, lo, s.r.path)
        const ch = hi === undefined ? null : convert(s.r.unit, hi, s.r.path)
        return [t, c.v, c.d, cl ? Math.min(cl.v, ch.v) : null, ch ? Math.max(cl.v, ch.v) : null]
      }).filter(Boolean)
      s.gapMs = Number(res.gapMs) || 16 * 60e3
    })
    const head = results[0]
    const now = Date.now()
    chart.end = Number(head.end) || (chart.custom && chart.range === 'custom' ? chart.custom.to : now)
    chart.start = Number(head.start) || (chart.custom && chart.range === 'custom' ? chart.custom.from : now - (RANGE_MS[chart.range] || RANGE_MS['24h']))
    if (!chart.customOpen || chart.range !== 'custom') {
      document.querySelector('#monFrom').value = toLocalInput(chart.start)
      document.querySelector('#monTo').value = toLocalInput(chart.end)
    }
    chart.hover = null
    document.querySelector('#monTip').style.display = 'none'
    if (!head.available) setMsg(head.detail || 'Trends are not available. Insert an SD card in the GX.')
    else if (chart.series.every(s => !s.data.length)) setMsg(chart.range === 'custom' ? 'Nothing was recorded in this period.' : 'No samples in this range yet.')
    else setMsg('')
    controls()
    legend()
    draw()
    clearInterval(chart.timer)
    if (chart.range === '1h' || chart.range === '24h') chart.timer = setInterval(() => { if (chart.open) loadTrend() }, 60000)
  }

  function setMsg (text) {
    const m = document.querySelector('#monMsg')
    m.textContent = text
    m.classList.toggle('show', !!text)
  }

  function summarise (s) {
    const d = s.data
    if (!d.length) return null
    const vals = d.map(p => p[1])
    return {
      dp: d[0][2],
      now: vals[vals.length - 1],
      min: Math.min(...d.map(p => p[3] === null ? p[1] : p[3])),
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      max: Math.max(...d.map(p => p[4] === null ? p[1] : p[4]))
    }
  }

  // One value: four tiles. Several: a legend row each, colour swatch beside the
  // name, numbers in plain ink.
  function legend () {
    const tiles = document.querySelector('#monStats')
    const leg = document.querySelector('#monLegend')
    const many = chart.series.length > 1
    tiles.style.display = many ? 'none' : ''
    leg.classList.toggle('show', many)
    if (!many) {
      const s = chart.series[0]
      const st = summarise(s)
      if (!st) { tiles.innerHTML = ''; return }
      const u = esc(s.unit)
      const tile = (icon, label, v) => `<div class="stat"><div class="stat-icon">${icon}</div><div><strong>${v.toFixed(st.dp)} <small>${u}</small></strong><span>${label}</span></div></div>`
      tiles.innerHTML = tile('●', 'Now', st.now) + tile('↓', 'Minimum', st.min) + tile('≈', 'Average', st.avg) + tile('↑', 'Maximum', st.max)
      return
    }
    const cell = (st, v, u) => st ? `<b>${v.toFixed(st.dp)}<small> ${esc(u)}</small></b>` : '<b class="none">—</b>'
    const last = chart.range === 'custom' ? 'Last' : 'Now'
    leg.innerHTML = `<div class="mon-leg-row head"><span></span><span></span><span>${last}</span><span>Min</span><span class="avg">Avg</span><span>Max</span><span></span></div>` +
      chart.series.map((s, i) => {
        const st = summarise(s)
        return `<div class="mon-leg-row"><i class="mon-swatch" style="background:${rgba(s.rgb, 1)}"></i><span class="mon-leg-name">${esc(seriesName(s))}${st ? '' : '<small> · no data in this period</small>'}</span>` +
          `${cell(st, st && st.now, s.unit)}${cell(st, st && st.min, s.unit)}<span class="avg">${cell(st, st && st.avg, s.unit)}</span>${cell(st, st && st.max, s.unit)}` +
          (i ? `<button class="mon-leg-x" data-remove="${esc(s.id)}" aria-label="Remove ${esc(seriesName(s))}" title="Remove">✕</button>` : '<span></span>') + '</div>'
      }).join('')
  }

  function niceTicks (min, max, count = 5) {
    if (min === max) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad }
    const raw = (max - min) / count
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw
    const lo = Math.floor(min / step) * step
    const hi = Math.ceil(max / step) * step
    const ticks = []
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step)
    return { lo, hi, ticks, step }
  }
  // A scale with exactly n intervals, so every unit's ticks sit on the same grid lines.
  function alignedTicks (min, max, n) {
    if (min === max) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad }
    const raw = (max - min) / n
    for (let mag = Math.pow(10, Math.floor(Math.log10(raw))); ; mag *= 10) {
      for (const m of [1, 2, 2.5, 5, 10]) {
        const step = m * mag
        if (step < raw * 0.999) continue
        const lo = Math.floor(min / step + 1e-9) * step
        if (lo + n * step >= max - step * 1e-6) return { lo, hi: lo + n * step, step, ticks: Array.from({ length: n + 1 }, (_, i) => lo + i * step) }
      }
    }
  }

  function timeLabel (t, span) {
    const d = new Date(t)
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (span <= 36 * 3600e3) return hm
    if (span <= 10 * 86400e3) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm
    if (span <= 200 * 86400e3) return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
    return d.toLocaleDateString([], { month: 'short', year: '2-digit' })
  }

  let geom = null
  function draw () {
    const canvas = document.querySelector('#monCanvas')
    if (!canvas) return
    geom = null
    const withData = chart.series.filter(s => s.data.length)
    // One scale per unit, in the order the units were added.
    const axes = units().map(unit => ({ unit, series: withData.filter(s => s.unit === unit) })).filter(a => a.series.length)
    const stacked = chart.mode === 'stacked' && axes.length > 1
    const panes = stacked ? axes.map(a => [a]) : [axes]
    canvas.style.height = stacked ? `${panes.length * 180 + 40}px` : ''
    const dpr = window.devicePixelRatio || 1
    const W = canvas.clientWidth
    const H = canvas.clientHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!axes.length) return

    const css = getComputedStyle(document.documentElement)
    const ink = css.getPropertyValue('--muted').trim() || '#8fa7be'
    const single = chart.series.length === 1
    ctx.font = '11px Inter, system-ui, sans-serif'

    // Scales. In one plot every unit gets the same number of intervals.
    for (const pane of panes) {
      pane.forEach((a, i) => {
        // A lone value shows its min–max band, so the scale must cover it.
        const lows = a.series.flatMap(s => s.data.map(p => single && p[3] !== null ? p[3] : p[1]))
        const highs = a.series.flatMap(s => s.data.map(p => single && p[4] !== null ? p[4] : p[1]))
        const lo = Math.min(...lows); const hi = Math.max(...highs)
        a.y = i === 0 ? niceTicks(lo, hi, stacked ? 3 : 5) : alignedTicks(lo, hi, pane[0].y.ticks.length - 1)
        a.dp = Math.max(0, -Math.floor(Math.log10(a.y.step) + 1e-9))
        if (a.y.ticks.some(t => Math.abs(t * Math.pow(10, a.dp) - Math.round(t * Math.pow(10, a.dp))) > 1e-6)) a.dp++
        a.w = Math.max(...a.y.ticks.map(t => ctx.measureText(t.toFixed(a.dp)).width), ctx.measureText(a.unit).width + a.series.length * 9) + 14
      })
    }
    const headed = axes.length > 1 // unit names above the axes
    const pad = { l: Math.max(...panes.map(p => p[0].w)), r: Math.max(12, ...panes.map(p => p.slice(1).reduce((n, a) => n + a.w, 0))), t: headed ? 24 : 12, b: 26 }
    const pw = W - pad.l - pad.r
    const gap = stacked ? 36 : 0
    const ph = (H - pad.t - pad.b - gap * (panes.length - 1)) / panes.length
    const t0 = chart.start
    const t1 = chart.end
    const X = t => pad.l + ((t - t0) / (t1 - t0)) * pw
    panes.forEach((pane, i) => {
      const top = pad.t + i * (ph + gap)
      pane.top = top
      pane.forEach(a => { a.Y = v => top + (1 - (v - a.y.lo) / (a.y.hi - a.y.lo)) * ph })
    })

    for (const pane of panes) {
      // Grid + y labels (recessive)
      ctx.strokeStyle = 'rgba(148,193,235,.10)'
      ctx.lineWidth = 1
      ctx.textBaseline = 'middle'
      let right = W - pad.r
      pane.forEach((a, i) => {
        ctx.fillStyle = ink
        ctx.textAlign = i === 0 ? 'right' : 'left'
        const lx = i === 0 ? pad.l - 8 : right + 8
        for (const t of a.y.ticks) {
          const yy = Math.round(a.Y(t)) + 0.5
          if (i === 0) { ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke() }
          ctx.fillText(t.toFixed(a.dp), lx, yy)
        }
        if (headed) {
          // Unit name above its axis, with a dot per value that uses it.
          const hy = pane.top - 13
          const uw = ctx.measureText(a.unit).width
          let x = i === 0 ? pad.l - 8 - uw - a.series.length * 9 : right + 8
          for (const s of a.series) { ctx.fillStyle = rgba(s.rgb, 1); ctx.beginPath(); ctx.arc(x + 3, hy, 3, 0, Math.PI * 2); ctx.fill(); x += 9 }
          ctx.fillStyle = ink
          ctx.textAlign = 'left'
          ctx.fillText(a.unit, x, hy)
        }
        if (i > 0) right += a.w
      })
    }
    // X labels
    ctx.fillStyle = ink
    ctx.textBaseline = 'top'
    const n = Math.max(2, Math.min(7, Math.floor(pw / 110)))
    for (let i = 0; i <= n; i++) {
      const t = t0 + (i / n) * (t1 - t0)
      ctx.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center'
      ctx.fillText(timeLabel(t, t1 - t0), X(t), H - pad.b + 8)
    }

    ctx.save()
    ctx.beginPath(); ctx.rect(pad.l, 0, pw, H); ctx.clip()
    for (const pane of panes) {
      const base = pane.top + ph
      // The first value is drawn last, on top.
      const drawn = pane.flatMap(a => a.series.map(s => ({ s, Y: a.Y }))).reverse()
      for (const { s, Y } of drawn) {
        const d = s.data
        const color = rgba(s.rgb, 1)
        // Break the line where samples are missing (plugin stopped, card out).
        const segments = []
        let seg = [d[0]]
        for (let i = 1; i < d.length; i++) {
          if (d[i][0] - d[i - 1][0] > s.gapMs) { segments.push(seg); seg = [] }
          seg.push(d[i])
        }
        segments.push(seg)
        for (const g of segments) {
          if (g.length === 1) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(g[0][0]), Y(g[0][1]), 2.5, 0, Math.PI * 2); ctx.fill(); continue }
          if (single) {
            // Min–max band behind the average (summarised data), else a soft fill.
            const banded = g.some(p => p[3] !== null && p[4] !== p[3])
            ctx.beginPath()
            if (banded) {
              g.forEach((p, i) => { const v = p[4] === null ? p[1] : p[4]; i ? ctx.lineTo(X(p[0]), Y(v)) : ctx.moveTo(X(p[0]), Y(v)) })
              for (let i = g.length - 1; i >= 0; i--) ctx.lineTo(X(g[i][0]), Y(g[i][3] === null ? g[i][1] : g[i][3]))
              ctx.fillStyle = rgba(s.rgb, 0.20)
            } else {
              g.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))
              ctx.lineTo(X(g[g.length - 1][0]), base)
              ctx.lineTo(X(g[0][0]), base)
              const grad = ctx.createLinearGradient(0, pane.top, 0, base)
              grad.addColorStop(0, rgba(s.rgb, 0.22))
              grad.addColorStop(1, rgba(s.rgb, 0))
              ctx.fillStyle = grad
            }
            ctx.closePath()
            ctx.fill()
          }
          ctx.beginPath()
          g.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))
          ctx.strokeStyle = color
          ctx.lineWidth = 2
          ctx.lineJoin = 'round'
          ctx.stroke()
        }
      }
    }
    ctx.restore()

    geom = { X, pad, pw, W, H, t0, t1, top: pad.t, bottom: H - pad.b }
    if (chart.hover) {
      const x = Math.round(X(chart.hover.t)) + 0.5
      ctx.strokeStyle = 'rgba(237,246,255,.35)'
      ctx.lineWidth = 1
      for (const pane of panes) { ctx.beginPath(); ctx.moveTo(x, pane.top); ctx.lineTo(x, pane.top + ph); ctx.stroke() }
      const ring = css.getPropertyValue('--panel').trim() || '#0b1a2b'
      for (const pane of panes) {
        for (const a of pane) {
          for (const s of a.series) {
            const p = chart.hover.points.get(s.id)
            if (!p) continue
            ctx.fillStyle = rgba(s.rgb, 1)
            ctx.strokeStyle = ring
            ctx.lineWidth = 2
            ctx.beginPath(); ctx.arc(X(p[0]), a.Y(p[1]), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
            if (s === chart.series[0]) geom.firstY = a.Y(p[1])
          }
        }
      }
    }
  }

  function nearest (d, t) {
    let lo = 0; let hi = d.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (d[mid][0] < t) lo = mid; else hi = mid }
    return Math.abs(d[lo][0] - t) <= Math.abs(d[hi][0] - t) ? d[lo] : d[hi]
  }

  // The crosshair snaps to the nearest sample of any value; each value then
  // reports its own sample at that time (or nothing, inside a gap).
  function hover (px) {
    const tip = document.querySelector('#monTip')
    const live = chart.series.filter(s => s.data.length)
    if (!geom || !live.length) { tip.style.display = 'none'; return }
    const t = geom.t0 + ((px - geom.pad.l) / geom.pw) * (geom.t1 - geom.t0)
    const snap = live.map(s => nearest(s.data, t)).reduce((a, b) => Math.abs(a[0] - t) <= Math.abs(b[0] - t) ? a : b)
    const points = new Map()
    for (const s of live) {
      const p = nearest(s.data, snap[0])
      if (Math.abs(p[0] - snap[0]) <= s.gapMs) points.set(s.id, p)
    }
    chart.hover = { t: snap[0], points }
    draw()
    const x = geom.X(snap[0])
    const span = geom.t1 - geom.t0
    const when = new Date(snap[0]).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', ...(span > 300 * 86400e3 ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit' })
    if (chart.series.length === 1) {
      const p = snap
      const spread = p[3] !== null && p[4] !== p[3] ? `<small>min ${p[3].toFixed(p[2])} · max ${p[4].toFixed(p[2])}</small>` : ''
      tip.innerHTML = `<b>${p[1].toFixed(p[2])} ${esc(chart.series[0].unit)}</b>${spread}<small>${esc(when)}</small>`
    } else {
      tip.innerHTML = `<small>${esc(when)}</small>` + chart.series.map(s => {
        const p = points.get(s.id)
        return `<div class="mon-tip-row"><i class="mon-swatch" style="background:${rgba(s.rgb, 1)}"></i><span>${esc(seriesName(s))}</span><b>${p ? `${p[1].toFixed(p[2])} ${esc(s.unit)}` : '—'}</b></div>`
      }).join('')
    }
    tip.style.display = 'block'
    const tw = tip.offsetWidth
    const left = x + 14 + tw > geom.W - 8 ? x - 14 - tw : x + 14
    tip.style.left = `${Math.max(8, left) + 12}px`
    tip.style.top = `${chart.series.length === 1 && geom.firstY !== undefined ? Math.max(12, geom.firstY - 20) : geom.top + 14}px`
  }

  // ---- Public hooks for the host page
  window.czoneMonitor = {
    // group: show that group only (null = all). Chosen from the category list.
    show (on, group = null) {
      mount()
      const filter = on && group ? group : null
      if (visible === !!on) {
        if (filter !== groupFilter) { groupFilter = filter; if (visible) render() }
        return
      }
      groupFilter = filter
      visible = !!on
      if (chart.open) closeTrend() // a trend belongs to the view it was opened from
      document.querySelector('#monitorView').classList.toggle('show', visible)
      if (visible) {
        render(); refresh(); refreshTrendStatus()
        if (window.innerWidth <= 780) document.querySelector('#monitorView').scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      schedule()
    },
    count: () => monitored().filter(i => i.mapped).length,
    // The groups on the Monitoring tab, for the host page's category list.
    groups () {
      const shown = monitored().filter(i => prefs.showUnmapped || i.mapped)
      return GROUPS.map(g => {
        const list = shown.filter(i => groupOf(i) === g)
        return list.length ? { name: g, label: groupLabel(g), icon: groupIcon(g), color: groupVar(g), count: list.length, live: list.filter(i => i.mapped).length } : null
      }).filter(Boolean)
    },
    // Open the trend for a Signal K path (circuit list arrow).
    trendPath (skPath) {
      mount()
      const item = items.find(i => i.readings.some(r => r.candidates[0] === skPath))
      if (!item) return false
      const r = item.readings.find(x => x.candidates[0] === skPath)
      openTrend(item, r.key)
      return true
    }
  }

  mount()
  refresh()
  refreshTrendStatus()
  setInterval(refreshTrendStatus, 60000)
  schedule()
})()
