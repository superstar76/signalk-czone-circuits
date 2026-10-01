// Monitoring view for the CZone Circuits webapp.
//
// Items come from /monitor/items (built from the ZCF Meters and Inputs tables
// plus circuit current). Trends come from /trend (SD card on the GX).
// The host page calls window.czoneMonitor.show(true|false) when the Monitoring
// nav entry is selected, and reads window.czoneMonitor.count() for the badge.
(() => {
  const API = '/plugins/signalk-czone-circuits';
  const GROUPS = ['Batteries', 'AC Power', 'Tanks', 'Temperatures', 'Environment', 'Circuit current', 'Inputs', 'Other'];
  // Group icon + colour token. Colours are CSS variables in monitor.css so a
  // future theme configurator can set them; defaults reuse the webapp palette.
  const GROUP_STYLE = {
    Batteries: ['🔋', 'batteries'], 'AC Power': ['♆', 'ac'], Tanks: ['◒', 'tanks'], Temperatures: ['🌡', 'temperatures'],
    Environment: ['◎', 'environment'], 'Circuit current': ['⚡', 'current'], Inputs: ['⏻', 'inputs'], Other: ['•••', 'other']
  }
  const groupOf = item => GROUPS.includes(item.group) ? item.group : 'Other'
  const groupVar = g => `var(--mon-${(GROUP_STYLE[g] || GROUP_STYLE.Other)[1]})`
  const groupIcon = g => (GROUP_STYLE[g] || GROUP_STYLE.Other)[0]
  const RANGES = [['1h', '1 h'], ['24h', '24 h'], ['7d', '7 days'], ['31d', '31 days']];
  const PREF_KEY = 'signalk-czone-circuits:monitor';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let items = []
  let trend = { available: false }
  let visible = false
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
      <div class="section-head"><span>◔</span><div><h2>Monitoring</h2><span class="subtle" id="monCount"></span></div>
        <span class="mon-pill" id="monTrend"><i></i><span>Checking SD card…</span></span>
        <label class="mon-check"><input type="checkbox" id="monShowAll"> Show unmapped</label>
      </div>
      <div id="monBody"><div class="empty">Loading…</div></div>`
    main.appendChild(section)
    const cb = section.querySelector('#monShowAll')
    cb.checked = !!prefs.showUnmapped
    cb.addEventListener('change', () => { prefs.showUnmapped = cb.checked; savePrefs(); render() })
    section.addEventListener('click', onClick)

    const panel = document.createElement('section')
    panel.className = 'section mon-trend'
    panel.id = 'monPanel'
    panel.innerHTML = `
      <div class="section-head"><span class="mon-trend-icon" id="monIcon"></span><div><h2 id="monTitle"></h2><span class="subtle" id="monSub"></span></div><button class="sort mon-close" aria-label="Close trend" data-close>✕ Close</button></div>
      <div class="mon-controls"><div class="mon-seg" id="monReadings"></div><div class="mon-seg" id="monRanges"></div></div>
      <div class="mon-stats" id="monStats"></div>
      <div class="mon-chart"><canvas id="monCanvas"></canvas><div class="mon-tip" id="monTip"></div><div class="mon-chart-msg" id="monMsg"></div></div>`
    main.insertBefore(panel, section)
    panel.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeTrend() })
    panel.querySelector('#monReadings').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { chart.key = b.dataset.key; loadTrend() } })
    panel.querySelector('#monRanges').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { chart.range = b.dataset.range; loadTrend() } })
    const canvas = panel.querySelector('#monCanvas')
    canvas.addEventListener('mousemove', e => hover(e.offsetX))
    canvas.addEventListener('mouseleave', () => { chart.hoverIdx = null; draw(); document.querySelector('#monTip').style.display = 'none' })
    canvas.addEventListener('touchmove', e => { const r = canvas.getBoundingClientRect(); hover(e.touches[0].clientX - r.left) }, { passive: true })
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTrend() })
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
      if (visible) document.querySelector('#monBody').innerHTML = `<div class="empty">Monitoring data unavailable (${esc(e.message)}).</div>`
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
    pill.querySelector('span').textContent = trend.available
      ? `Trending ${trend.trending || 0} values · ${trend.retentionDays || 31} days on SD card`
      : trend.reason === 'no_sd_card' ? 'No SD card: trends off' : trend.reason === 'write_failed' ? 'SD card read-only: trends off' : 'Trends unavailable'
  }
  function schedule () {
    clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => { await refresh(); schedule() }, visible ? 5000 : 60000)
  }

  // ---- Rendering
  const primary = item => item.readings.find(r => r.path) || item.readings[0]
  const sortByName = (a, b) => a.name.localeCompare(b.name)

  // Rows reuse the webapp's own circuit-row classes so Monitoring looks like
  // the circuit list: name + subtitle, tags, status dot, value box, arrow.
  // Group names as shown (the catalogue keeps its own keys).
  const GROUP_LABEL = { 'Circuit current': 'Circuits' }
  const groupLabel = g => GROUP_LABEL[g] || g

  // One value box per live reading (e.g. battery V / A / %), each opens its trend.
  function valueBox (item, r) {
    const f = fmt(r.unit, r.value, r.path)
    const on = chart.open && chart.item && chart.item.id === item.id && chart.key === r.key ? 'active' : ''
    const level = r.unit === 'ratio' && typeof r.value === 'number' ? `<span class="mon-level"><span style="width:${Math.max(0, Math.min(100, r.value * 100))}%"></span></span>` : ''
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
    const sub = item.mapped ? (where || groupLabel(g)) : (item.note || `Waiting for ${(p && p.candidates[0]) || 'a Signal K path'}`)
    const live = item.mapped
    const shown = live ? item.readings.filter(r => r.path) : (p ? [p] : [])
    const active = chart.open && chart.item && chart.item.id === item.id ? 'active' : ''
    const clickable = p && p.series
    return `<div class="circuit mon-row ${shown.length > 1 ? 'multi' : ''} ${live ? '' : 'unmapped'} ${active} ${clickable ? 'clickable' : ''}" style="--cat:${groupVar(g)}" ${clickable ? `data-item="${esc(item.id)}" data-key="${esc(p.key)}"` : ''}>
      <span class="mon-icon">${groupIcon(g)}</span>
      <div class="circuit-name"><strong>${esc(item.name)}</strong><small>${esc(sub)}</small></div>
      <div class="mon-right"><div class="status ${live ? 'on' : ''}"><span class="status-dot"></span>${live ? 'LIVE' : 'NOT ON BUS'}</div><div class="mon-values">${shown.map(r => valueBox(item, r)).join('')}</div></div>
      <span class="arrow">${clickable ? '›' : ''}</span></div>`
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
    if (!all.length) { body.innerHTML = '<div class="empty">No meters or inputs found in the ZCF.</div>'; return }
    if (!shown.length) { body.innerHTML = '<div class="empty">Nothing from the ZCF is on the bus yet. Tick “Show unmapped” to see what is expected.</div>'; return }
    body.innerHTML = GROUPS.map(g => {
      const list = shown.filter(i => groupOf(i) === g)
      if (!list.length) return ''
      const live = list.filter(i => i.mapped).length
      if (g === 'Circuit current') list.sort((a, b) => (primary(b).value || 0) - (primary(a).value || 0) || sortByName(a, b))
      else list.sort(sortByName)
      return `<div class="mon-subhead" style="--cat:${groupVar(g)}"><span class="mon-icon">${groupIcon(g)}</span><strong>${esc(groupLabel(g))}</strong><span class="subtle">${live} of ${list.length} live</span></div>${list.map(row).join('')}`
    }).join('')
  }

  function onClick (e) {
    const b = e.target.closest('[data-item]')
    if (!b || b.disabled) return
    const item = items.find(i => i.id === b.dataset.item)
    if (item) openTrend(item, b.dataset.key)
  }

  // ---- Trend chart
  const chart = { open: false, item: null, key: null, range: '24h', data: [], unit: '', hoverIdx: null, timer: null, seq: 0 }

  function openTrend (item, key) {
    chart.open = true
    chart.item = item
    chart.key = key
    const panel = document.querySelector('#monPanel')
    const g = groupOf(item)
    panel.style.setProperty('--cat', groupVar(g))
    panel.classList.add('show')
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

  async function loadTrend () {
    const item = chart.item
    const readings = item.readings.filter(r => r.series)
    const r = readings.find(x => x.key === chart.key) || readings[0]
    if (!r) return
    chart.key = r.key
    document.querySelector('#monSub').textContent = `${r.path}${r.sourceModule !== undefined ? ` · from module ${Number(r.sourceModule).toString(16).padStart(2, '0').toUpperCase()}` : ''}`
    document.querySelector('#monReadings').innerHTML = readings.length > 1 ? readings.map(x => `<button data-key="${esc(x.key)}" class="${x.key === r.key ? 'active' : ''}">${esc(x.label)}</button>`).join('') : ''
    document.querySelector('#monReadings').style.display = readings.length > 1 ? '' : 'none'
    document.querySelector('#monRanges').innerHTML = RANGES.map(([k, l]) => `<button data-range="${k}" class="${k === chart.range ? 'active' : ''}">${l}</button>`).join('')
    const seq = ++chart.seq
    setMsg('Loading…')
    let res
    try {
      const resp = await fetch(`${API}/trend?path=${encodeURIComponent(r.series)}&range=${chart.range}`, { cache: 'no-store', credentials: 'include' })
      res = await resp.json()
    } catch (e) { res = { available: false, detail: e.message } }
    if (seq !== chart.seq || !chart.open) return
    const probe = convert(r.unit, 0, r.path)
    chart.unit = probe ? probe.u : ''
    chart.data = (res.data || []).map(([t, v]) => { const c = convert(r.unit, v, r.path); return c ? [t, c.v, c.d] : null }).filter(Boolean)
    chart.hoverIdx = null
    if (!res.available) setMsg(res.detail || 'Trends are not available. Insert an SD card in the GX.')
    else if (!chart.data.length) setMsg('No samples in this range yet. Values are sampled every 30 seconds.')
    else setMsg('')
    stats()
    draw()
    clearInterval(chart.timer)
    if (chart.range === '1h' || chart.range === '24h') chart.timer = setInterval(() => { if (chart.open) loadTrend() }, 60000)
  }

  function setMsg (text) {
    const m = document.querySelector('#monMsg')
    m.textContent = text
    m.classList.toggle('show', !!text)
  }

  function stats () {
    const el = document.querySelector('#monStats')
    const d = chart.data
    if (!d.length) { el.innerHTML = ''; return }
    const vals = d.map(p => p[1])
    const dp = d[0][2]
    const f = v => v.toFixed(dp)
    const u = esc(chart.unit)
    const tile = (icon, label, v) => `<div class="stat"><div class="stat-icon">${icon}</div><div><strong>${f(v)} <small>${u}</small></strong><span>${label}</span></div></div>`
    el.innerHTML = tile('●', 'Now', vals[vals.length - 1]) + tile('↓', 'Minimum', Math.min(...vals)) + tile('≈', 'Average', vals.reduce((a, b) => a + b, 0) / vals.length) + tile('↑', 'Maximum', Math.max(...vals))
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

  function timeLabel (t, range) {
    const d = new Date(t)
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    if (range === '1h' || range === '24h') return hm
    if (range === '7d') return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  }

  // Canvas needs a concrete colour: resolve any CSS colour (var(), hex) to rgba.
  function withAlpha (color, a) {
    const probe = document.createElement('span')
    probe.style.color = color
    document.body.appendChild(probe)
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g) || [24, 213, 232]
    probe.remove()
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
  }

  let geom = null
  function draw () {
    const canvas = document.querySelector('#monCanvas')
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const W = canvas.clientWidth
    const H = canvas.clientHeight
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const d = chart.data
    geom = null
    if (!d.length) return

    const css = getComputedStyle(document.documentElement)
    const ink = css.getPropertyValue('--muted').trim() || '#8fa7be'
    const panelCss = getComputedStyle(document.querySelector('#monPanel'))
    const lineColor = panelCss.getPropertyValue('--mon-line').trim() || css.getPropertyValue('--cyan').trim() || '#18d5e8'
    const vals = d.map(p => p[1])
    const y = niceTicks(Math.min(...vals), Math.max(...vals))
    const dp = Math.max(0, -Math.floor(Math.log10(y.step)))
    ctx.font = '11px Inter, system-ui, sans-serif'
    const labelW = Math.max(...y.ticks.map(t => ctx.measureText(t.toFixed(dp)).width)) + 12
    const pad = { l: labelW, r: 12, t: 12, b: 26 }
    const pw = W - pad.l - pad.r
    const ph = H - pad.t - pad.b
    const now = Date.now()
    const span = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '31d': 31 * 86400e3 }[chart.range]
    const t0 = Math.min(d[0][0], now - span)
    const t1 = now
    const X = t => pad.l + ((t - t0) / (t1 - t0)) * pw
    const Y = v => pad.t + (1 - (v - y.lo) / (y.hi - y.lo)) * ph

    // Grid + y labels (recessive)
    ctx.strokeStyle = 'rgba(148,193,235,.10)'
    ctx.lineWidth = 1
    ctx.fillStyle = ink
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const t of y.ticks) {
      const yy = Math.round(Y(t)) + 0.5
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke()
      ctx.fillText(t.toFixed(dp), pad.l - 8, yy)
    }
    // X labels
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    const n = Math.max(2, Math.min(7, Math.floor(pw / 110)))
    for (let i = 0; i <= n; i++) {
      const t = t0 + (i / n) * (t1 - t0)
      const x = X(t)
      ctx.textAlign = i === 0 ? 'left' : i === n ? 'right' : 'center'
      ctx.fillText(timeLabel(t, chart.range), x, H - pad.b + 8)
    }

    // Break the line where samples are missing (plugin stopped, card out).
    const gaps = []
    for (let i = 1; i < d.length; i++) gaps.push(d[i][0] - d[i - 1][0])
    const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0
    const breakAt = Math.max(median * 5, 5 * 60e3)
    const segments = []
    let seg = [d[0]]
    for (let i = 1; i < d.length; i++) {
      if (d[i][0] - d[i - 1][0] > breakAt) { segments.push(seg); seg = [] }
      seg.push(d[i])
    }
    segments.push(seg)

    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph)
    grad.addColorStop(0, withAlpha(lineColor, 0.22))
    grad.addColorStop(1, withAlpha(lineColor, 0))
    for (const s of segments) {
      if (s.length === 1) { ctx.fillStyle = lineColor; ctx.beginPath(); ctx.arc(X(s[0][0]), Y(s[0][1]), 2.5, 0, Math.PI * 2); ctx.fill(); continue }
      ctx.beginPath()
      s.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))
      ctx.lineTo(X(s[s.length - 1][0]), pad.t + ph)
      ctx.lineTo(X(s[0][0]), pad.t + ph)
      ctx.closePath()
      ctx.fillStyle = grad
      ctx.fill()
      ctx.beginPath()
      s.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))
      ctx.strokeStyle = lineColor
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.stroke()
    }

    geom = { X, Y, pad, ph, W }
    if (chart.hoverIdx !== null && d[chart.hoverIdx]) {
      const p = d[chart.hoverIdx]
      const x = X(p[0])
      ctx.strokeStyle = 'rgba(237,246,255,.35)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, pad.t); ctx.lineTo(Math.round(x) + 0.5, pad.t + ph); ctx.stroke()
      ctx.fillStyle = lineColor
      ctx.strokeStyle = css.getPropertyValue('--panel').trim() || '#0b1a2b'
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(x, Y(p[1]), 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    }
  }

  function hover (px) {
    const tip = document.querySelector('#monTip')
    if (!geom || !chart.data.length) { tip.style.display = 'none'; return }
    let best = 0
    let bestDx = Infinity
    chart.data.forEach((p, i) => { const dx = Math.abs(geom.X(p[0]) - px); if (dx < bestDx) { bestDx = dx; best = i } })
    chart.hoverIdx = best
    draw()
    const p = chart.data[best]
    const x = geom.X(p[0])
    const when = new Date(p[0]).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    tip.innerHTML = `<b>${p[1].toFixed(p[2])} ${esc(chart.unit)}</b><small>${esc(when)}</small>`
    tip.style.display = 'block'
    const tw = tip.offsetWidth
    const left = x + 14 + tw > geom.W - 8 ? x - 14 - tw : x + 14
    tip.style.left = `${Math.max(8, left) + 12}px`
    tip.style.top = `${Math.max(12, geom.Y(p[1]) - 20)}px`
  }

  // ---- Public hooks for the host page
  window.czoneMonitor = {
    show (on) {
      mount()
      if (visible === !!on) return
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
