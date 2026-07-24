#!/usr/bin/env bash
# Groq free tier caps each model at ~1K requests/day. One convert-hosted pass (~4050 calls/model) drains a
# day's budget in ~2h, then the RPD wall errors the rest and the lane exits. This wrapper re-runs the lane so
# it resumes from the append-only convert-*.partial.jsonl and completes over ~2-3 weeks, unattended. Fully-done
# modes are skipped cheaply; on an exhausted day the preflight probe 429s and the whole pass is a quick no-op.
# ponytail: 6h fixed poll (not aligned to the UTC RPD reset) — good enough; align to reset only if it drags.
cd "$(cd "$(dirname "$0")/.." && pwd)"
echo $$ > runs/.groq.daily.pid   # liveness: kill -0 $(cat runs/.groq.daily.pid); stop: kill $(cat …)
MODELS=("groq|allam-2-7b" "groq|meta-llama/llama-4-scout-17b-16e-instruct" "groq|qwen/qwen3.6-27b" "groq|qwen/qwen3-32b")
SLUGS=(allam-2-7b meta-llama_llama-4-scout-17b-16e-instruct qwen_qwen3.6-27b qwen_qwen3-32b)
while :; do
  bash scripts/convert-hosted.sh "${MODELS[@]}"
  done=1
  for s in "${SLUGS[@]}"; do
    [ -f "runs/groq/$s/convert-plain.json" ] && [ -f "runs/groq/$s/convert-ex.json" ] || done=0
  done
  [ "$done" = 1 ] && { echo "✅ all 4 groq models complete"; break; }
  echo "⏳ $(date -u +%H:%MZ) day budget spent — sleep 6h, then resume from partials"
  sleep 21600
done
