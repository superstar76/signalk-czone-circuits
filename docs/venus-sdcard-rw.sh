#!/bin/sh
# Let Signal K (user signalk) write trend data to the SD card. Venus OS mounts
# FAT cards writable by root only, and FAT masks can only be set at mount time.
D=/dev/mmcblk0p1
M=/run/media/mmcblk0p1
i=0
while [ $i -lt 30 ] && ! grep -q "^$D $M vfat" /proc/mounts; do sleep 2; i=$((i+1)); done
grep -q "^$D $M vfat" /proc/mounts || exit 0
grep "^$D $M vfat" /proc/mounts | grep -q "fmask=0000" && exit 0
svc -d /service/vrmlogger 2>/dev/null
n=0
while grep -q "^$D " /proc/mounts && [ $n -lt 10 ]; do umount $M 2>/dev/null || sleep 1; n=$((n+1)); done
grep -q "^$D " /proc/mounts || mount -t vfat -o rw,relatime,umask=0000 $D $M
svc -u /service/vrmlogger 2>/dev/null
