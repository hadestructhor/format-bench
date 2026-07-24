#!/usr/bin/env bash
# Local model ladder, smallest → biggest. GGUF-only (every entry resolves to a prebuilt GGUF).
# Each model: convert-cycle.sh downloads the GGUF, probes the best thread count FOR THAT MODEL, serves it
# on 8091 with the A/B-tuned config (serial · -ngl 0 · --parallel 1 · --concurrency 1 · -c 8192), runs
# convert plain+explained (resumable), then DELETES the model.
# Resume the whole ladder by re-running this script: models with both convert-*.json are skipped; a model
# killed mid-mode resumes from its .partial checkpoint.
#
# Config locked by the serial-vs-concurrent A/B (LFM2.5-1.2B, 24 cases · all score 75, no quality delta):
#   serial-cpu-t10     par=1 t=10 conc=1 | 237s | ctx 8192 ✓   ← WINNER (full context)
#   serial-llvmpipe    par=1 t=8  conc=1 | 274s | ctx 8192      (llvmpipe = more CPU, no win)
#   serial-cpu-t8      par=1 t=8  conc=1 | 337s | ctx 8192
#   concurrent-cpu-t8  par=4 t=8  conc=4 | 229s | ctx 2048 ✗    (8 s faster but TRUNCATES context → rejected)
#   concurrent-old     par=4 t=12 conc=4 | 355s | ctx 2048 ✗
# Serial wins on the axes the user set: fastest at full 8192 context, native CPU (lower power than llvmpipe).
# The 8-second edge of the concurrent config is not worth halving every model's usable context to 2048.
set -uo pipefail
cd "$(dirname "$0")/.."
CYCLE="scripts/convert-cycle.sh"
LOG="$HOME/projects/format-bench/runs/.local-ladder.log"
: > "$LOG"
say() { echo "$@" | tee -a "$LOG"; }

# REPO (GGUF source) | LABEL (Org/Model → runs/<org>/<model> + leaderboard) | QUANT (blank = Q4_K_M) | TYPE
LADDER=(
  # ── 135M–270M ──────────────────────────────────────────────────────────────
  "unsloth/SmolLM2-135M-Instruct-GGUF          | HuggingFaceTB/SmolLM2-135M-Instruct |      | gen"
  "LiquidAI/LFM2.5-230M-GGUF                    | LiquidAI/LFM2.5-230M                |      | gen"
  "AKMESSI/lfm2.5-230m-fable-5                  | AKMESSI/lfm2.5-230m-fable-5         |      | fine-tune"
  "unsloth/gemma-3-270m-it-GGUF                 | google/gemma-3-270m-it              |      | gen"
  # ── 350M–360M ──────────────────────────────────────────────────────────────
  "LiquidAI/LFM2-350M-GGUF                      | LiquidAI/LFM2-350M                  |      | gen"
  "LiquidAI/LFM2.5-350M-GGUF                    | LiquidAI/LFM2.5-350M                |      | gen"
  "ibm-granite/granite-4.0-h-350m-GGUF          | ibm-granite/granite-4.0-h-350m      |      | gen"
  "unsloth/SmolLM2-360M-Instruct-GGUF           | HuggingFaceTB/SmolLM2-360M-Instruct |      | gen"
  "LiquidAI/LFM2-350M-Extract-GGUF              | LiquidAI/LFM2-350M-Extract          |      | extract*"
  "LiquidAI/LFM2-350M-Math-GGUF                 | LiquidAI/LFM2-350M-Math             |      | math*"
  "kurakurai/Luth-LFM2-350M-GGUF                | kurakurai/Luth-LFM2-350M            |      | fine-tune"
  # ── 0.5B–0.6B ──────────────────────────────────────────────────────────────
  "Qwen/Qwen2.5-0.5B-Instruct-GGUF              | Qwen/Qwen2.5-0.5B-Instruct          |      | gen"
  "DevQuasar-3/numind.NuExtract-tiny-v1.5-GGUF  | numind/NuExtract-tiny-v1.5          |      | extract*"
  "Melvin56/Hammer2.1-0.5b-GGUF                 | MadeAgents/Hammer2.1-0.5b           |      | func*"
  "second-state/Osmosis-Structure-0.6B-GGUF     | osmosis-ai/Osmosis-Structure-0.6B   |      | struct*"
  "kurakurai/Luth-0.6B-Instruct-GGUF            | kurakurai/Luth-0.6B-Instruct        |      | fine-tune"
  # ── 700M ───────────────────────────────────────────────────────────────────
  "LiquidAI/LFM2-700M-GGUF                      | LiquidAI/LFM2-700M                  |      | gen"
  "kurakurai/Luth-LFM2-700M-GGUF                | kurakurai/Luth-LFM2-700M            |      | fine-tune"
  # ── 1B ─────────────────────────────────────────────────────────────────────
  "Salesforce/xLAM-2-1b-fc-r-gguf               | Salesforce/xLAM-2-1b-fc-r           |      | func*"
  "ibm-granite/granite-4.0-h-1b-GGUF            | ibm-granite/granite-4.0-h-1b        |      | gen"
  "ggml-org/gemma-3-1b-it-GGUF                  | google/gemma-3-1b-it                |      | gen"
  "unsloth/Llama-3.2-1B-Instruct-GGUF           | meta-llama/Llama-3.2-1B-Instruct    |      | gen"
  # ── 1.2B ───────────────────────────────────────────────────────────────────
  "LiquidAI/LFM2-1.2B-GGUF                      | LiquidAI/LFM2-1.2B                  |      | gen"
  "LiquidAI/LFM2.5-1.2B-Instruct-GGUF           | LiquidAI/LFM2.5-1.2B-Instruct       |      | gen"
  "kurakurai/Luth-LFM2-1.2B-GGUF                | kurakurai/Luth-LFM2-1.2B            |      | fine-tune"
  "LiquidAI/LFM2-1.2B-Tool-GGUF                 | LiquidAI/LFM2-1.2B-Tool             |      | func*"
  "LiquidAI/LFM2-1.2B-Extract-GGUF              | LiquidAI/LFM2-1.2B-Extract          |      | extract*"
  "LiquidAI/LFM2-1.2B-RAG-GGUF                  | LiquidAI/LFM2-1.2B-RAG              |      | RAG*"
  "LiquidAI/LFM2.5-1.2B-Thinking-GGUF           | LiquidAI/LFM2.5-1.2B-Thinking       |      | reasoning"
  # ── 1.5B ───────────────────────────────────────────────────────────────────
  "katanemo/Arch-Function-1.5B.gguf             | katanemo/Arch-Function-1.5B         |      | func*"
  "Melvin56/Hammer2.1-1.5b-GGUF                 | MadeAgents/Hammer2.1-1.5b           |      | func*"
  # ── 1.7B ───────────────────────────────────────────────────────────────────
  "unsloth/SmolLM2-1.7B-Instruct-GGUF           | HuggingFaceTB/SmolLM2-1.7B-Instruct |      | gen"
  "kurakurai/Luth-1.7B-Instruct-GGUF            | kurakurai/Luth-1.7B-Instruct        |      | fine-tune"
  # ── 2B ─────────────────────────────────────────────────────────────────────
  "google/gemma-4-E2B-it-qat-q4_0-gguf          | google/gemma-4-E2B-it               | q4_0 | gen"
  "mradermacher/NuExtract-2.0-2B-GGUF           | numind/NuExtract-2.0-2B             |      | extract*"
  # ── 2.6B ───────────────────────────────────────────────────────────────────
  "LiquidAI/LFM2-2.6B-GGUF                      | LiquidAI/LFM2-2.6B                  |      | gen"
  "LiquidAI/LFM2-2.6B-Transcript-GGUF           | LiquidAI/LFM2-2.6B-Transcript       |      | transcript*"
  # ── 3.8B ───────────────────────────────────────────────────────────────────
  "bartowski/NuExtract-v1.5-GGUF                | numind/NuExtract-v1.5               |      | extract*"
  "unsloth/Phi-4-mini-instruct-GGUF             | microsoft/Phi-4-mini-instruct       |      | gen"
  # ── 4B ─────────────────────────────────────────────────────────────────────
  "unsloth/gemma-4-E4B-it-GGUF                  | google/gemma-4-E4B-it               |      | gen"
  # ── 8B (requested; ~5 GB Q4, slow) ─────────────────────────────────────────
  "LiquidAI/LFM2.5-8B-A1B-GGUF                  | LiquidAI/LFM2.5-8B-A1B              |      | gen"
)

N=${#LADDER[@]}
say "🪜 local ladder: $N models, smallest → biggest · $(date '+%F %T')"
i=0
for row in "${LADDER[@]}"; do
  i=$((i+1))
  IFS='|' read -r repo label quant type <<< "$row"
  repo="$(echo "$repo" | xargs)"; label="$(echo "$label" | xargs)"; quant="$(echo "$quant" | xargs)"; type="$(echo "$type" | xargs)"
  say ""
  say "▶▶▶ [$i/$N] $label  ($type)  ← $repo  $(date '+%T')"
  predone=0; { [ -f "runs/$label/convert-plain.json" ] && [ -f "runs/$label/convert-ex.json" ]; } && predone=1  # already-complete → a skip, must NOT trigger the stop sentinel
  bash "$CYCLE" "$repo" "$label" ${quant:+"$quant"} 2>&1 | tee -a "$LOG"
  rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] && say "✅ [$i/$N] $label done" || say "⚠️  [$i/$N] $label exited rc=$rc — continuing"
  [ "$predone" = 0 ] && [ -f runs/.local-stop ] && { say "🛑 runs/.local-stop → halting local ladder after [$i/$N] $label (hosted lanes unaffected)"; break; }
done
say ""
say "🏁 LOCAL LADDER COMPLETE · $(date '+%F %T')"
