#!/usr/bin/env bash
# ONE retry loop for every parkable lane (nvidia · opencodezen · kilo · grok · tokenrouter · groq).
#
# Why this works with no extra bookkeeping: free-tier providers cap mid-run and park. The append-only
# convert-*.partial.jsonl keeps every REAL answer, and run.ts's capped-run guard refuses to finalize a
# mostly-errored mode — so a parked model has its progress banked and no bogus json. hosted-lanes.sh already
# skips fully-done models and resumes partials, so a periodic re-sweep is all that's needed to pick everything
# back up the moment a quota window resets. Nothing here re-runs completed work.
#
# Per-provider dispatch: a sweep relaunches only the providers with no live lane. That kills two problems the
# old "wait for ALL lanes to drain" version had — nvidia's 80-model queue blocked every other provider's retry
# for hours (head-of-line), and a sweep firing while a lane was still up double-ran the same model into the
# same partial (duplicate ids).
#
# Usage: bash scripts/retry-loop.sh [interval_seconds]   (default 5400 = 90 min between sweeps)
# Stop:  kill $(cat runs/.retry-loop.pid)
set -uo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
echo $$ > runs/.retry-loop.pid
INTERVAL="${1:-5400}"
PROVIDERS=(nvidia opencodezen kilo grok tokenrouter groq)
sweep=0
while :; do
  sweep=$((sweep + 1))
  echo "══════ retry sweep #$sweep · $(date -u '+%F %T')Z ══════"
  live=$(pgrep -af 'convert-hoste[d]' 2>/dev/null || true)   # lane argv looks like: convert-hosted.sh nvidia|model …
  for p in "${PROVIDERS[@]}"; do
    if printf '%s\n' "$live" | grep -q " $p|"; then
      echo "  ⏩ $p: lane still running — skip"
    else
      bash scripts/hosted-lanes.sh "$p"
    fi
  done
  echo "── sweep #$sweep dispatched · sleeping ${INTERVAL}s ──"
  sleep "$INTERVAL"
done
