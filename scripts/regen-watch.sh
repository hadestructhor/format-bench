#!/usr/bin/env bash
# Regenerate global + per-model result pages whenever ANY convert-*.json changes (local or hosted).
# Decoupled from the runners so it covers every mode completion on both tracks.
cd "$(dirname "$0")/.."
sig() { find runs -name 'convert-*.json' -printf '%T@ %s %p\n' 2>/dev/null | sort | md5sum | cut -d' ' -f1; }
last=""
while true; do
  cur=$(sig)
  if [ "$cur" != "$last" ]; then
    bun scripts/build-data.ts >/dev/null 2>&1
    echo "$(date '+%F %T') regen (sig ${cur:0:8})" >> runs/.regen-watch.log
    last="$cur"
  fi
  sleep 30
done
