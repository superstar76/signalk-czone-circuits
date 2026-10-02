/* Signal K classic Module Federation configuration panel. */
var signalk_czone_circuits = (function () {
  function getReact () {
    var React = globalThis.__SK_REACT__ || globalThis.React
    if (!React) throw new Error('Signal K Admin UI React host was not found')
    return React
  }

  function PluginConfigurationPanel (props) {
    var React = getReact()
    var configuration = props.configuration || {}
    var save = props.save
    var state = React.useState(null)
    var data = state[0]
    var setData = state[1]
    var busyState = React.useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    var errorState = React.useState('')
    var error = errorState[0]
    var setError = errorState[1]
    var readState = React.useState(null)
    var read = readState[0]
    var setRead = readState[1]
    var selectedState = React.useState(configuration.networkConfigFile || '')
    var selected = selectedState[0]
    var setSelected = selectedState[1]
    var sourceState = React.useState(configuration.configurationSource || 'installedZcf')
    var localSource = sourceState[0]
    var setLocalSource = sourceState[1]
    var uploadState = React.useState(null)
    var uploadFile = uploadState[0]
    var setUploadFile = uploadState[1]

    function loadConfiguration () {
      return fetch('/plugins/signalk-czone-circuits/configuration', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('Could not load CZone configuration status'); return r.json() })
        .then(function (value) {
          setData(value)
          setSelected(value.networkConfigFile || configuration.networkConfigFile || '')
          setLocalSource(value.source || configuration.configurationSource || 'installedZcf')
          if (value.networkRead) setRead(value.networkRead)
          return value
        })
    }

    React.useEffect(function () {
      loadConfiguration().catch(function (err) { setError(err.message || String(err)) })
    }, [])

    React.useEffect(function () {
      if (!read || read.status !== 'reading') return undefined
      var timer = setInterval(function () {
        loadConfiguration().catch(function () {})
      }, 1000)
      return function () { clearInterval(timer) }
    }, [read && read.status])

    function persist(next) {
      setBusy(true); setError('')
      try {
        save(Object.assign({}, configuration, next))
        setData(Object.assign({}, data || {}, next))
      } catch (err) {
        setError(err.message || String(err))
      } finally {
        setBusy(false)
      }
    }

    function setSending (value) {
      persist({ enableSending: value })
    }

    function setVictronSwitches (value) {
      persist({ victronSwitches: value })
    }

    function setVictronSwitchCurrent (value) {
      persist({ victronSwitchCurrent: value })
    }

    function setShowVirtualCircuits (value) {
      persist({ showVirtualCircuits: value })
    }

    function setTrendDirectory (value) {
      persist({ trendDirectory: String(value || '').trim() })
    }

    function setTrendNumber (key, value) {
      var next = {}
      next[key] = Number(value)
      persist(next)
    }

    function chooseSource (value) {
      setLocalSource(value)
      if (value === 'installedZcf') {
        setSelected('')
        persist({ configurationSource: 'installedZcf', networkConfigFile: '' })
      } else if (selected) {
        persist({ configurationSource: 'networkCache', networkConfigFile: selected })
      }
    }

    function useSelected () {
      if (!selected) return
      setBusy(true); setError('')
      fetch('/plugins/signalk-czone-circuits/configuration/network/use', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: selected })
      }).then(function (r) {
        return r.text().then(function (body) {
          var value
          try { value = JSON.parse(body) } catch (_) { value = null }
          if (!r.ok) throw new Error(value && value.error ? value.error : body || ('HTTP ' + r.status))
          return value || {}
        })
      }).then(function () {
        configuration.configurationSource = 'networkCache'
        configuration.networkConfigFile = selected
        setData(Object.assign({}, data || {}, { source: 'networkCache', networkConfigFile: selected }))
      }).catch(function (err) {
        setError(err.message || String(err))
      }).finally(function () { setBusy(false); loadConfiguration().catch(function () {}) })
    }

    function uploadZcf () {
      if (!uploadFile) return
      var name = String(uploadFile.name || '')
      if (!/\.zcf$/i.test(name)) {
        setError('Please choose a .zcf file')
        return
      }
      setBusy(true); setError('')
      var form = new FormData()
      form.append('file', uploadFile, name)
      fetch('/plugins/signalk-czone-circuits/zcf/upload', {
        method: 'POST', credentials: 'same-origin', body: form
      }).then(function (r) {
        return r.text().then(function (body) {
          var value
          try { value = JSON.parse(body) } catch (_) { value = null }
          if (!r.ok) throw new Error(value && value.error ? value.error : body || ('HTTP ' + r.status))
          return value || {}
        })
      }).then(function (value) {
        setLocalSource('installedZcf')
        setSelected('')
        setUploadFile(null)
        configuration.configurationSource = 'installedZcf'
        configuration.networkConfigFile = ''
        setData(Object.assign({}, data || {}, { source: 'installedZcf', networkConfigFile: '' }))
        return loadConfiguration().then(function () {
          setRead({ status: 'complete', message: value.message || 'ZCF uploaded and installed.' })
        })
      }).catch(function (err) {
        setError(err.message || String(err))
      }).finally(function () { setBusy(false) })
    }

    function readFromNetwork () {
      setBusy(true); setError(''); setRead({ status: 'reading', message: 'Starting CZone configuration read…' })
      fetch('/plugins/signalk-czone-circuits/configuration/network/read', {
        method: 'POST', credentials: 'same-origin'
      }).then(function (r) {
        return r.text().then(function (body) {
          var value
          try { value = JSON.parse(body) } catch (_) { value = null }
          if (!r.ok) throw new Error(value && value.error ? value.error : body || ('HTTP ' + r.status))
          return value || {}
        })
      }).then(function (value) {
        setRead(value)
        return loadConfiguration()
      }).catch(function (err) {
        setError(err.message || String(err))
        setRead({ status: 'error', error: err.message || String(err) })
      }).finally(function () { setBusy(false) })
    }

    var installed = data && data.installedZcf
    var files = data && data.availableNetworkConfigs ? data.availableNetworkConfigs : []
    var source = localSource
    var nmeaReady = data && data.nmeaReady === true
    var current = data && data.current
    var reading = read && read.status === 'reading'

    return React.createElement('div', null,
      React.createElement('h4', null, 'CZone Circuits Configuration'),
      React.createElement('p', null, 'Configuration is loaded locally at Signal K startup. Reading from the CZone network is an explicit maintenance action and is never performed automatically at startup.'),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('strong', null, 'Configuration source'),
        React.createElement('div', { style: { marginTop: 9 } },
          React.createElement('label', { style: { display: 'block', marginBottom: 8 } },
            React.createElement('input', { type: 'radio', name: 'czone-source', checked: source === 'installedZcf', disabled: busy, onChange: function () { chooseSource('installedZcf') } }),
            ' Use installed/uploaded ZCF'
          ),
          React.createElement('div', { style: { marginLeft: 24, fontSize: 12 } }, installed && installed.exists
            ? (installed.fileName || 'installation.zcf') + (installed.vesselName ? ' · ' + installed.vesselName : '') + (installed.circuits != null ? ' · ' + installed.circuits + ' circuits · ' + installed.modes + ' modes' : '')
            : 'No uploaded ZCF is installed.'),
          React.createElement('label', { style: { display: 'block', marginTop: 13 } },
            React.createElement('input', { type: 'radio', name: 'czone-source', checked: source === 'networkCache', disabled: busy, onChange: function () { chooseSource('networkCache') } }),
            ' Use saved CZone network configuration'
          ),
          React.createElement('div', { style: { marginTop: 7, marginLeft: 24 } },
            React.createElement('select', { value: selected, disabled: busy || !files.length, onChange: function (e) { setSelected(e.target.value) }, style: { maxWidth: '100%', padding: 5 } },
              React.createElement('option', { value: '' }, files.length ? 'Select a .czone.net file…' : 'No saved network configurations'),
              files.map(function (item) { return React.createElement('option', { key: item.file, value: item.file }, item.file + ' (' + item.bytes + ' bytes)') })
            ),
            React.createElement('button', { type: 'button', disabled: busy || !selected, onClick: useSelected, style: { marginLeft: 8 } }, 'Use Selected')
          )
        )
      ),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('strong', null, 'ZCF file'),
        React.createElement('p', { style: { margin: '7px 0', fontSize: 12 } }, 'Upload a CZone .zcf file to install it as the local configuration. Uploading switches the configuration source back to the installed/uploaded ZCF.'),
        React.createElement('input', { type: 'file', accept: '.zcf,application/octet-stream', disabled: busy, onChange: function (e) { setUploadFile(e.target.files && e.target.files[0] ? e.target.files[0] : null) } }),
        React.createElement('div', { style: { marginTop: 8 } },
          React.createElement('button', { type: 'button', disabled: busy || !uploadFile, onClick: uploadZcf }, busy ? 'Uploading ZCF…' : 'Upload and install ZCF'),
          uploadFile ? React.createElement('span', { style: { marginLeft: 8, fontSize: 12 } }, uploadFile.name) : null
        )
      ),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('strong', null, 'CZone network configuration'),
        React.createElement('p', { style: { margin: '7px 0', fontSize: 12 } }, 'Read the complete configuration from the CZone network and save it locally as a .czone.net file. This may take several seconds.'),
        React.createElement('button', { type: 'button', disabled: busy || reading || !nmeaReady, onClick: readFromNetwork }, reading ? 'Reading CZone configuration…' : 'Read From Network and Save'),
        !nmeaReady ? React.createElement('div', { style: { marginTop: 7, fontSize: 12 } }, 'NMEA 2000 output is waiting; the read action becomes available when output is ready.') : null,
        reading ? React.createElement('div', { style: { marginTop: 8, fontSize: 12 } }, read.message || ('Receiving configuration · ' + (read.receivedBytes || 0) + ' bytes')) : null,
        read && read.status === 'complete' ? React.createElement('div', { style: { marginTop: 8, fontSize: 12 } }, 'Saved: ' + (read.file || 'CZone network configuration')) : null
      ),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('label', null,
          React.createElement('input', { type: 'checkbox', checked: configuration.enableSending === true, disabled: busy, onChange: function (e) { setSending(e.target.checked) } }),
          ' Allow this plugin to send NMEA 2000 messages'
        ),
        React.createElement('div', { style: { marginTop: 6, fontSize: 12 } }, 'When enabled, the plugin can send CZone circuit and Mode control PGNs to your NMEA 2000 network.')
      ),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('label', null,
          React.createElement('input', { type: 'checkbox', checked: configuration.showVirtualCircuits === true, disabled: busy, onChange: function (e) { setShowVirtualCircuits(e.target.checked) } }),
          ' Show virtual switch circuits'
        ),
        React.createElement('div', { style: { marginTop: 6, fontSize: 12 } }, 'Circuits that only drive CZone virtual switches (VS 01, VS 02, …) are hidden from the webapp and the Victron switch pane unless this is ticked.')
      ),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('label', null,
          React.createElement('input', { type: 'checkbox', checked: configuration.victronSwitches === true, disabled: busy, onChange: function (e) { setVictronSwitches(e.target.checked) } }),
          ' Show CZone circuits in the Victron switch pane'
        ),
        React.createElement('div', { style: { marginTop: 6, fontSize: 12 } }, 'Venus OS 3.60 or newer. Adds every circuit to the GX switch pane and VRM, one card per CZone category. Switching from the pane also needs NMEA 2000 sending allowed above.'),
        React.createElement('label', { style: { display: 'block', marginTop: 8 } },
          React.createElement('input', { type: 'checkbox', checked: configuration.victronSwitchCurrent !== false, disabled: busy || configuration.victronSwitches !== true, onChange: function (e) { setVictronSwitchCurrent(e.target.checked) } }),
          ' Show circuit current in the switch label (e.g. "Light 1 · 1.5 A")'
        )
      ),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('label', null, 'Trend folder (optional) ',
          React.createElement('input', { type: 'text', style: { width: '60%' }, placeholder: 'Automatic', defaultValue: configuration.trendDirectory || '', disabled: busy, onBlur: function (e) { if ((e.target.value || '').trim() !== (configuration.trendDirectory || '')) setTrendDirectory(e.target.value) } })
        ),
        React.createElement('div', { style: { marginTop: 6, fontSize: 12 } }, 'Blank = automatic. On a Victron GX trends go to an SD card or USB stick, never internal flash. On a Pi or PC they go to the Signal K data folder.')
      ),

      React.createElement('div', { style: { marginBottom: 14, padding: 12, border: '1px solid #ccc', borderRadius: 6 } },
        React.createElement('label', { style: { display: 'block' } }, 'Trend sample rate ',
          React.createElement('select', { value: String(configuration.trendSampleSeconds || 10), disabled: busy, onChange: function (e) { setTrendNumber('trendSampleSeconds', e.target.value) } },
            [[5, '5 seconds'], [10, '10 seconds'], [15, '15 seconds'], [30, '30 seconds'], [60, '1 minute']].map(function (o) {
              return React.createElement('option', { key: o[0], value: String(o[0]) }, o[1])
            })
          )
        ),
        React.createElement('label', { style: { display: 'block', marginTop: 8 } }, 'Keep full-detail trend data for ',
          React.createElement('select', { value: String(configuration.trendRetentionDays || 0), disabled: busy, onChange: function (e) { setTrendNumber('trendRetentionDays', e.target.value) } },
            [[0, 'As long as there is space'], [31, '31 days'], [90, '90 days'], [365, '1 year']].map(function (o) {
              return React.createElement('option', { key: o[0], value: String(o[0]) }, o[1])
            })
          )
        ),
        React.createElement('div', { style: { marginTop: 6, fontSize: 12 } }, 'Minimum 16 GB SD card or USB stick recommended. Values are written when they change, and ten-minute summaries are always kept. When storage runs low the oldest full-detail days are removed first, then the oldest summaries, so recording never stops.')
      ),

      current ? React.createElement('div', { style: { fontSize: 12 } }, 'Currently loaded: ' + (current.vesselName || current.fileName) + ' · ' + current.circuits + ' circuits · ' + current.modes + ' modes') : null,
      error ? React.createElement('div', { role: 'alert', style: { marginTop: 9 } }, 'Error: ' + error) : null
    )
  }

  var modules = { './PluginConfigurationPanel': function () { return { default: PluginConfigurationPanel } } }
  return {
    get: function (request) {
      if (!modules[request]) return Promise.reject(new Error('Unknown exposed module: ' + request))
      return Promise.resolve(modules[request])
    },
    init: function () { return Promise.resolve() }
  }
})()
