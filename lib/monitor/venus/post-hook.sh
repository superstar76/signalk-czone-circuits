#!/bin/sh
# signalk-czone-circuits: run by Venus OS at boot, after it has unpacked
# venus-data.tgz from the card into /data. Makes the GX open the trend card
# for Signal K at every start. Safe to run any number of times.
chmod +x /data/sdcard-rw.sh
[ -f /data/rc.local ] || echo '#!/bin/sh' > /data/rc.local
grep -q '/data/sdcard-rw.sh' /data/rc.local || echo '/data/sdcard-rw.sh &' >> /data/rc.local
chmod +x /data/rc.local
exit 0
