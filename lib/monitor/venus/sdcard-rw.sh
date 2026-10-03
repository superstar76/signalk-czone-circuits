#!/bin/sh
# signalk-czone-circuits: let Signal K (user signalk) write trend data to an SD
# card or USB stick in a Victron GX. Venus OS mounts FAT cards writable by root
# only, and FAT permissions can only be set when a card is mounted, so each
# card is mounted again with open permissions. The VRM logger holds the card,
# so it is stopped for the moment that takes.
#
# Run at boot from /data/rc.local. Does nothing when there is no card or the
# card is already open. For a test: MOUNTS=<file> DRY=1 WAIT=0 sh sdcard-rw.sh
MOUNTS=${MOUNTS:-/proc/mounts}
WAIT=${WAIT:-30}
RUN=${DRY:+echo}
cards() { awk '$3 == "vfat" && $2 ~ /^\/(run\/)?media\//' "$MOUNTS"; }
closed() { cards | awk '$4 !~ /fmask=0000/ { print $1 " " $2 }'; }

i=0
while [ $i -lt "$WAIT" ] && [ -z "$(cards)" ]; do sleep 2; i=$((i+1)); done
[ -n "$(closed)" ] || exit 0

$RUN svc -d /service/vrmlogger 2>/dev/null
closed | while read dev dir; do
  if [ -n "$DRY" ]; then
    echo umount "$dir"
    echo mount -t vfat -o rw,relatime,umask=0000 "$dev" "$dir"
    continue
  fi
  n=0
  while grep -q "^$dev " "$MOUNTS" && [ $n -lt 10 ]; do umount "$dir" 2>/dev/null || sleep 1; n=$((n+1)); done
  # Mount only when the old mount has gone, or the two would stack.
  grep -q "^$dev " "$MOUNTS" || mount -t vfat -o rw,relatime,umask=0000 "$dev" "$dir"
done
$RUN svc -u /service/vrmlogger 2>/dev/null
exit 0
