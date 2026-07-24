#!/usr/bin/env bash
# Hard stop at $1 (HH:MM, default 07:50) local time. Tears down format-bench runners + watchers + OUR
# llama-server (8091 only), final regen, everything resumable. NEVER touches 8080 or hades-bench.
cd "$(dirname "$0")/.."
LOG="runs/.stop-at.log"
T="${1:-07:50}"
TARGET=$(date -d "today $T" +%s); NOW=$(date +%s)
[ "$TARGET" -le "$NOW" ] && TARGET=$(date -d "tomorrow $T" +%s)
echo "$(date '+%F %T') armed → stop at $(date -d @$TARGET '+%F %T') (in $((TARGET-NOW))s)" >> "$LOG"
while [ "$(date +%s)" -lt "$TARGET" ]; do sleep 30; done
echo "$(date '+%F %T') STOP fired — tearing down" >> "$LOG"
pkill -f nvidia-watch.sh   2>/dev/null   # stop nvidia auto-restart FIRST (else it rejoins the lane)
pkill -f regen-watch.sh    2>/dev/null   # stop regen loop
pkill -f convert-local.sh  2>/dev/null   # stop local orchestrator (no new model spawns)
pkill -f convert-hosted.sh 2>/dev/null   # stop hosted lanes
pkill -f convert-cycle.sh  2>/dev/null   # triggers per-model delete trap (checkpoint survives)
pkill -f 'bench.ts run'    2>/dev/null   # in-flight bench children (local + hosted)
PID=$(ss -ltnp 2>/dev/null | grep :8091 | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && kill "$PID" 2>/dev/null  # our server only, by 8091
sleep 3
rm -f /home/hades/models/lfm/*.gguf       # in case a trap was skipped
bun scripts/build-data.ts >/dev/null 2>&1   # final site data rebuild
echo "$(date '+%F %T') teardown done; 8091 $(ss -ltnp 2>/dev/null | grep -q :8091 && echo STILL-UP || echo clear); 8080 $(ss -ltnp 2>/dev/null | grep -q :8080 && echo up-untouched || echo n/a)" >> "$LOG"
