#!/usr/bin/env bash
# Convert rerun — hosted models, in leaderboard order. Each model: plain then explained.
# Args: "provider|model" pairs in order. NO_REPORT=1 skips the format model-card rewrite (avoid races).
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
export NO_REPORT=1
slug() { echo "$1" | sed 's/[^a-zA-Z0-9._-]\+/_/g'; }
page() { :; }  # regen handled centrally by regen-watch.sh (single writer → no HTML races across lanes)
# Mid-run stall guard: a mode (plain/explained) is "truly frozen" if its partial gains NO new case for
# STALL_SECS. A healthy model — even a slow one (~200s/case) at cc≥2 — writes within a couple minutes, so
# ~6 min of ZERO growth means the in-flight requests are wedged (dead sockets the fetch abort never released,
# e.g. opencode/hy3 froze 9h this way). On stall: kill the run (partial is append-only → fully resumable),
# requeue the model, and switch to the next one — same skip logic as the launch-time preflight.
STALL_SECS=${STALL_SECS:-360}   # ~6 min of no new case = frozen; override via env
POLL=60
run_mode() {  # provider model flags partial cc  → 0 = ran/complete, 2 = stalled (killed)
  local p="$1" m="$2" flags="$3" part="$4" cc="$5" log; log="$(mktemp)"
  # setsid → the run gets its own process group so we can kill the WHOLE tree. `bun bench.ts run` forks a
  # worker child; killing only $! leaks that worker (reparents, keeps a wedged socket + ~40MB). Group-kill reaps it.
  setsid bun bench.ts run --provider "$p" -m "$m" --bench convert $flags --concurrency "$cc" > "$log" 2>&1 &
  local pid=$! last=-1 stall=0 n
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$POLL"
    if [ -f "$part" ]; then n=$(wc -l < "$part" 2>/dev/null || echo "$last"); else n=$last; fi  # partial gone = completing, not stalled
    if [ "$n" -gt "$last" ]; then last=$n; stall=0; else stall=$((stall + POLL)); fi
    if [ "$stall" -ge "$STALL_SECS" ]; then
      kill -TERM -"$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; sleep 2   # kill the group, then any stray
      kill -KILL -"$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null
      grep -E "▶ convert|= task|GLOBAL SCORE" "$log" || true; rm -f "$log"
      echo "  ⏸ STALLED ${STALL_SECS}s, no new case (at line $n) → killed, requeue, switch to next model"
      return 2
    fi
  done
  wait "$pid"; local rc=$?
  grep -E "▶ convert|= task|GLOBAL SCORE" "$log" || true; rm -f "$log"
  return $rc
}
one() {
  local p="${1%%|*}" m="${1#*|}"
  local cc=3; [ "$p" = "nvidia" ] && cc=10; [ "$p" = "ovh" ] && cc=1; [ "$p" = "groq" ] && cc=2; [ "$p" = "grok" ] && cc=2   # nvidia c=10 (measured ~20-concurrent cap); ovh c=1 (2 RPM); groq c=2 (6K TPM); grok c=2 (CLI subprocess, heavy ~14k-tok overhead/call); 429s auto-retry
  local d="runs/$(slug "$p")/$(slug "$m")"
  echo "════════════════ $p / $m ════════════════"
  # already fully done → no probe, no run
  if [ -f "$d/convert-plain.json" ] && [ -f "$d/convert-ex.json" ]; then echo "  ⏭  fully done"; return 0; fi
  # preflight: skip a model that is saturated/dead AT LAUNCH → requeue it
  if [ "$p" != "ovh" ] && [ "$p" != "grok" ] && [ "$p" != "tokenrouter" ] && ! bun scripts/probe-model.ts "$p" "$m" >/dev/null 2>&1; then   # ovh/grok/tokenrouter skip preflight (grok = CLI not HTTP; tokenrouter's glm-5.2 is slow-reasoning + 503-prone so a probe falsely fails); stall-guard + capped-run guard handle them
    echo "  ⚠ saturated/unreachable → requeue"; echo "$1" >> "runs/.$(slug "$p").requeue"; return 0
  fi
  # each mode is stall-guarded: a mid-run wedge kills+requeues the model and switches to the next
  if [ -f "$d/convert-plain.json" ]; then echo "  ⏭  plain done"; else
    run_mode "$p" "$m" "" "$d/convert-plain.partial.jsonl" "$cc"
    [ $? -eq 2 ] && { echo "$1" >> "runs/.$(slug "$p").requeue"; return 0; }
  fi
  if [ -f "$d/convert-ex.json" ]; then echo "  ⏭  explained done"; else
    run_mode "$p" "$m" "--explain" "$d/convert-ex.partial.jsonl" "$cc"
    [ $? -eq 2 ] && { echo "$1" >> "runs/.$(slug "$p").requeue"; return 0; }
  fi
}
prov0=$(slug "${1%%|*}"); rq="runs/.$prov0.requeue"; : > "$rq"   # fresh requeue list for this lane
for pm in "$@"; do one "$pm" || echo "⚠ $pm failed"; done
# requeue pass: retry once the models that were saturated at launch (free gateways recover) — single pass, no infinite loop
if [ -s "$rq" ]; then
  mapfile -t RETRY < "$rq"; : > "$rq"
  echo "── requeue pass: ${#RETRY[@]} model(s) that were saturated ──"
  for pm in "${RETRY[@]}"; do one "$pm" || echo "⚠ $pm failed"; done
fi
echo "✅ CONVERT HOSTED DONE"
