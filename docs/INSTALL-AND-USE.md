# CZone Circuits for Signal K: installation and use

This guide is for the person fitting or using the plugin on a boat. It covers the development version with monitoring, trends, the Victron switch pane and the chartplotter view. Draft of 4 October 2026.

## What it does

The plugin reads your boat's CZone configuration file (ZCF) and, from that one file, gives you:

- **Circuits:** every CZone circuit in a webapp, with its state, and switching and dimming from the browser.
- **Monitoring:** every battery, AC meter, tank and temperature in the CZone configuration, live.
- **Trends:** history for every monitored value and every circuit's current.
- **Victron switch pane:** the CZone circuits as switches on a Victron GX screen and in VRM.
- **Chartplotter tile:** the webapp on a B&G, Simrad or Lowrance plotter.

Nothing is set up by hand beyond loading the ZCF. If something in the ZCF does not appear, section 9 says why.

## 1. What you need

| You need | Notes |
|---|---|
| A CZone system on NMEA 2000 | Any mix of CZone modules. Tested with Output Interface, Meter Interface, Signal Interface and Control X PLUS |
| Signal K server, version 2.x, Node 20 or newer | On a Victron GX (Venus OS Large), a Raspberry Pi or a PC |
| An NMEA 2000 connection in Signal K that can send as well as receive | Needed for switching. On a GX this is the built-in VE.Can port. Reading works without it |
| The boat's ZCF file | The `.zcf` saved from the CZone Configuration Tool. It must be the configuration that is loaded on the boat now |

Optional:

| For | You need |
|---|---|
| Trends on a Victron GX | An SD card or USB stick, 16 GB or larger, FAT32 |
| The Victron switch pane | Venus OS 3.60 or newer |
| The chartplotter tile | A B&G, Simrad or Lowrance plotter on the same Ethernet network as Signal K |

## 2. Installing

### 2.1 Install the plugin

The plugin is not in the Signal K Appstore yet. Until it is, it is installed from GitHub, which needs a login to the machine Signal K runs on: see Appendix A.

Once it is published, installing will be:

1. In the Signal K admin page, go to **Appstore → Available**.
2. Search for **CZone Circuits** and install it.
3. Restart Signal K when asked.

### 2.2 Load the CZone configuration

1. Go to **Server → Plugin Config → CZone Circuits**.
2. Under **ZCF file**, choose your `.zcf` file and press **Upload and install ZCF**.
3. The page shows what it loaded: the number of circuits and Modes.

Whenever the configuration on the boat is changed with the CZone Configuration Tool, upload the new ZCF here. Circuits, meters, categories and names all come from it.

### 2.3 Allow switching

Switching is off until you allow it.

1. On the same page, tick **Allow this plugin to send NMEA 2000 messages**.

Without it, the webapp still shows every circuit and its state; it just cannot switch.

Changes on this page are saved as you make them. There is no Save button; a green "Saved" notice confirms each change.

### 2.4 Check it is working

1. Go to **Webapps → CZone Circuits**.
2. The title shows your vessel's name and the corner shows **Connected**.
3. Circuits that are on show **ON** in green. Switch a light from the page and from a CZone display, and check each follows the other.

If the list is empty, see section 10.

## 3. Using the webapp

### 3.1 Finding a circuit

| On the left | Shows |
|---|---|
| All Circuits | everything |
| In Use | circuits that are on |
| Favorites | circuits you have starred |
| AC / DC | circuits of that type |
| Monitoring | meters, tanks and temperatures (section 4) |
| Categories | the CZone categories of the circuits in the current view |

- **Categories** are the ones ticked for each circuit in the CZone Configuration Tool, including your own user-defined ones. Clicking a category narrows the current view; clicking it again clears it.
- **Search** and **sort** (A–Z, In Use, Brightness) are at the top of the list.
- **The star** beside a circuit adds it to Favorites. Favorites are kept in that browser.

### 3.2 Switching

- **ON / OFF button:** press to switch. It shows "Sending…" until the CZone system confirms.
- **Dimmable circuits** have a slider.
- **Modes** are in their own panel. Press a Mode to activate it.

### 3.3 What each row tells you

- **Under the name:** the circuit's type and where its own load is wired, for example "DC · module 02 / ch 5". Channels are numbered as in the CZone Configuration Tool. If the circuit also switches another circuit's load, hovering over that line names it.
- **Under ON:** the current the circuit is drawing, in amps.
- **Beside the name:** a temperature, where one belongs to the circuit (section 9.1).
- **The arrow** at the end of the row opens the trend of that circuit's current.

### 3.4 Circuits you will not see

Two kinds of circuit are left out, because nobody switches them by hand:

- **Virtual-switch circuits**, which only drive CZone virtual switches (thermostat set-points and the like).
- **Circuits that are not on any CZone display**, such as thermostat feeds, "pump running" indicators and alarm relays.

Both can be shown with a setting (section 8). Their state is still published to Signal K either way.

## 4. Monitoring

The **Monitoring** tab lists everything the CZone configuration monitors, grouped as Batteries, Solar, Alternators, Converters, AC Power, Tanks, Temperatures and so on.

- **LIVE** means the value is arriving now.
- **NOT ON BUS** means the configuration expects it but nothing is sending it. The row names the NMEA 2000 instance it is waiting for, for example "Nothing is sending instance 3 on NMEA 2000". Set that instance on the sending device and the row goes live. Tick **Show unmapped** to see these rows.
- **Click a row** to open its trend.

## 5. Trends

Trends record every live monitored value and every circuit's current, and draw them as charts.

### 5.1 Where trends are kept

| System | Storage |
|---|---|
| Victron GX | an SD card or USB stick in the GX. Nothing is written to the GX's own storage |
| Raspberry Pi or PC | the Signal K data folder |

A **Trend folder** setting overrides this.

### 5.2 Setting up the card on a Victron GX

A GX only lets its own system write to a card, so a new card needs one step before trends can use it. You do this once per GX, and you never need to log in to the GX.

1. **Download `venus-data.tgz`** from the Monitoring tab. The link is there whenever trends are off, whether the card is already in the GX or not yet fitted.
2. **Copy the file onto the card** with a computer. Put it at the top level, not in a folder. A USB stick works too: the file can go on any stick, it does not have to be the trend card.
3. **Put the card (or stick) in the GX and restart the GX** (Settings → General → Reboot).

Within a minute or two of the restart the trend status turns green. From then on the GX opens the card at every start, including after a firmware update.

- **One and done:** the file is only needed for that one restart. Afterwards you can delete it, or remove the USB stick.
- **If it stops working** after a factory reset of the GX, repeat the three steps.

### 5.3 Reading the trend status

The status is at the top of the Monitoring tab.

| It says | Meaning |
|---|---|
| Trending 24 values · every 10 s · on SD card · 29 GB free | recording |
| No SD card or USB stick: trends off | fit a card (GX only) |
| Card found but not writable: trends off | do the three steps in 5.2 |

### 5.4 Charts

- **Period:** 1 h, 24 h, 7 d, 31 d, 90 d, 1 y, or **Custom** for your own from and to.
- **Now, minimum, average, maximum** for the period are shown above the chart.
- **Add value** puts another value on the same chart, up to five, each unit with its own scale. **Stacked** gives each unit its own plot on the same time axis.
- Longer periods draw the average with a band from minimum to maximum, so short peaks stay visible.

### 5.5 How much is kept

Everything is kept until the card runs low. Then the oldest detailed days are removed first and the ten-minute summaries last, so recording never stops. A setting can limit detailed data to 31, 90 or 365 days.

## 6. Victron switch pane

On a Victron GX, the circuits can appear as switches on the GX screen, in Remote Console and in VRM.

1. In **Plugin Config → CZone Circuits**, tick **Show CZone circuits in the Victron switch pane**.
2. Switching from the pane also needs **Allow this plugin to send NMEA 2000 messages** (section 2.3).

What you get:

- **One switch per circuit**, a slider for a dimmable circuit, grouped by CZone category.
- **The label** shows the name, then the temperature and the current: "Freezer (-8.2 °C, 2.9 A)". Temperature follows the unit set on the GX. Both can be turned off in the settings.
- **Both directions:** a change made anywhere shows in the pane, and a tap in the pane switches the circuit.
- **Renaming:** names, groups and the device name can be edited on the GX and are kept.
- **Order:** the GX lists switches alphabetically within a group. That cannot be changed.

## 7. Chartplotter (B&G, Simrad, Lowrance)

The webapp can run as a tile on a Navico plotter. This part is new and has been tried on one plotter model so far.

You need:

- **The plotter and Signal K on the same Ethernet network**, by cable. A router between them stops it working.
- **A second plugin, Navico MFD Embedder** (`signalk-navico-embedder`), from the Signal K Appstore. The plotter's browser is old, and this plugin converts the pages so it can run them.

Setting it up, in **Plugin Config → Navico MFD Embedder**:

1. **Local IP address override:** the address of the Signal K machine on the plotter's network.
2. **MFD Apps:** enable **CZone Circuits**.
3. **Authentication:** set the level to **Admin** and press **Generate Authentication Token**; approve the request under **Security → Access Requests** in a second browser tab, then return and press **Save Configuration**.
4. **Client IP whitelist:** add the plotter's IP address, so only the plotter can use that login.

A **CZone Circuits** tile then appears on the plotter. On the plotter the page uses a touch layout: larger rows and buttons, and you scroll by dragging.

Notes:

- A GX also shows a **Signal K** tile by itself. On current Signal K versions that tile opens to a blank page on the plotter; use the CZone Circuits tile.
- The embedder does its converting on the Signal K machine. On a Cerbo GX that is already busy, pages can be slow to open.

## 8. Settings

All in **Server → Plugin Config → CZone Circuits**.

| Setting | Default | What it does |
|---|---|---|
| Allow this plugin to send NMEA 2000 messages | off | lets the webapp and the switch pane switch circuits |
| Show virtual switch circuits | off | lists circuits that only drive virtual switches |
| Show circuits that are not on any CZone display | off | lists circuits no CZone display shows |
| Show CZone circuits in the Victron switch pane | off | adds the circuits to the GX switch pane and VRM |
| Show circuit current in the switch label | on | "Light 1 (1.5 A)" |
| Show temperature in the switch label | on | "Freezer (-8.2 °C, 2.9 A)" |
| Trend folder | automatic | where trends are stored |
| Trend sample rate | 10 seconds | 5, 10, 15, 30 or 60 seconds |
| Keep full-detail trend data for | as long as there is space | or 31, 90 or 365 days |

## 9. Getting the most from the CZone configuration

The plugin takes everything from the ZCF, so a few choices in the CZone Configuration Tool decide what you see.

### 9.1 A temperature beside a circuit

Name the temperature input after the circuit, followed by "Temperature" or "Temp". Circuit **Freezer** and input **Freezer Temperature** are paired; the temperature then shows beside the circuit, in the switch label and as a trend. Nothing else is needed.

### 9.2 Categories

Tick the categories each circuit belongs to. They become the groups in the webapp and in the Victron switch pane. Your own categories (User Definable 1 to 5) are used with the names you gave them.

### 9.3 Meters

- **DC Type:** set each DC meter's type (Battery, Alternator, Solar and so on). The meter is listed under that group, and where several devices send on the same instance, the type decides which one is used.
- **Instance:** the meter's NMEA 2000 instance in the configuration must match the device that sends it. A row that says NOT ON BUS gives the instance it is waiting for.
- **One instance per measurement** is best. Where two devices must share an instance, the plugin picks by type; a chartplotter may not.

### 9.4 Which circuits appear

A circuit appears when one of its Circuit Controls is a display (All Display Interfaces, a named display, or the Wireless Interface). To have a circuit listed, give it a display control. To keep one out, leave it with switch inputs only.

## 10. If something is not right

| What you see | Likely cause | What to do |
|---|---|---|
| "Not logged in to Signal K", no circuits | this browser has no Signal K login at this address | log in to Signal K, then reload. A login is kept per address, so the boat's name and its IP address each need one |
| Circuits listed but ON/OFF does nothing | sending is not allowed, or Signal K's NMEA 2000 connection cannot send | tick "Allow this plugin to send NMEA 2000 messages"; check the connection |
| Every circuit shows OFF | the ZCF loaded may not be the one on the boat | upload the current ZCF |
| A circuit is missing | it is a virtual-switch circuit or has no display control | see 3.4 and 9.4 |
| A meter says NOT ON BUS | nothing is sending that instance | set the instance on the sending device (section 4) |
| "Card found but not writable: trends off" | the GX has not been told to open the card | section 5.2 |
| "No SD card or USB stick: trends off" | no card in the GX | fit one |
| Switch pane shows no CZone switches | the setting is off, or Venus OS is older than 3.60 | section 6 |
| Plotter shows no CZone Circuits tile | plotter and Signal K are on different networks, or the embedder is not enabled | section 7 |
| Plotter tile opens but the list is empty | the embedder has no token | section 7, step 3 |

For anything else, the diagnostic pages in Appendix B show what the plugin is seeing.

## 11. Updating

- **A new version of the plugin:** from the Appstore once it is published; until then, Appendix A, "Updating". Settings, trends and the installed ZCF are kept either way.
- **A changed CZone configuration:** upload the new ZCF (section 2.2).

## Appendix A. Installing from GitHub

Until the plugin is in the Appstore, it is installed from GitHub with a login to the machine Signal K runs on. On a Victron GX that means enabling root access and using SSH.

### First install

Run these in Signal K's configuration folder: `/data/conf/signalk` on a GX, usually `~/.signalk` on a Raspberry Pi or PC.

```
cd /data/conf/signalk
npm install https://github.com/superstar76/signalk-czone-circuits/tarball/monitoring
```

On a GX, also give the files to the Signal K user and restart Signal K:

```
chown -R signalk:signalk node_modules package.json package-lock.json
svc -t /service/signalk-server
```

On a Cerbo GX the install takes several minutes and Signal K a couple more to come back. On a Raspberry Pi or PC, restart Signal K from its admin page.

### Updating

On a GX this is much quicker than a fresh install:

```
cd /data/conf/signalk/node_modules/signalk-czone-circuits
curl -sL -o /tmp/fork.tgz https://github.com/superstar76/signalk-czone-circuits/tarball/monitoring
tar tzf /tmp/fork.tgz | wc -l
tar xzf /tmp/fork.tgz --strip-components=1
chown -R signalk:signalk .
svc -t /service/signalk-server
```

- The third line prints the number of files fetched. A 0 or 1 means the download failed; do not carry on.
- Enter the lines one at a time, or make sure the last one is followed by Enter. If it runs together with whatever is typed next, Signal K is not restarted.
- Afterwards, reload the webapp with Ctrl+F5 so the browser fetches the new pages.

## Appendix B. Diagnostic pages

Open these in a browser that is logged in to Signal K, after the address of the Signal K server and `/plugins/signalk-czone-circuits`.

| Page | Shows |
|---|---|
| `/monitor/items` | every monitored item with its live readings |
| `/monitor/bus` | which device each reading is taken from, and every device seen sending it |
| `/monitor/modules` | CZone modules and their NMEA 2000 addresses |
| `/trend/status` | where trends are stored and how much space is free |
| `/victron/status` | what the switch pane holds for each circuit |
