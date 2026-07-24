#!/usr/bin/env bash
# One local model: resolve a GGUF (download prebuilt, else convert safetensors) → serve on 8091 with the
# TUNED config → run convert plain+explained (resumable via run.ts .partial checkpoints) → delete the model.
# Args: <hf_repo> <Org/Label> [quant=Q4_K_M]
# Tuned config from the llama-bench + serial-vs-concurrent A/B (override via env: NGL/PAR/THR/CONC/CTX).
set -uo pipefail
REPO="$1"; LABEL="$2"; QUANT="${3:-Q4_K_M}"
NGL="${NGL:-0}"; PAR="${PAR:-1}"; THR="${THR:-10}"; CONC="${CONC:-1}"; CTX="${CTX:-8192}"
DIR="$HOME/models/lfm"; PORT=8091; SRV_LOG="$DIR/.server.log"
mkdir -p "$DIR"; export NO_REPORT=1
slug() { echo "$1" | sed 's/[^a-zA-Z0-9._-]\+/_/g'; }
RUNDIR="$HOME/projects/format-bench/runs/$(slug "${LABEL%%/*}")/$(slug "${LABEL#*/}")"
PLAIN="$RUNDIR/convert-plain.json"; EX="$RUNDIR/convert-ex.json"
if [ -f "$PLAIN" ] && [ -f "$EX" ]; then echo "⏭  $LABEL already complete — skip"; exit 0; fi

cleanup() {  # delete the model after trying it (user request); the .partial checkpoints live under runs/ and survive
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  sleep 1; rm -f "$DIR"/*.gguf; rm -rf "$DIR/src"
  rm -rf "$HOME/.cache/huggingface/hub/models--${REPO//\//--}"
  echo "🧹 deleted $LABEL ; lfm dir now: $(du -sh "$DIR" 2>/dev/null | cut -f1)"
}
trap cleanup EXIT INT TERM

echo "════════════════ $LABEL  ($REPO · $QUANT) ════════════════"
# 1) prebuilt GGUF of the requested quant …
hf download "$REPO" --include "*${QUANT}*.gguf" --local-dir "$DIR" >/dev/null 2>&1 || true
GGUF=$(ls "$DIR"/*.gguf 2>/dev/null | grep -iE "${QUANT//_/[_-]}" | head -1 || true)
# 2) … else any Q4 gguf in the repo …
if [ -z "$GGUF" ]; then
  hf download "$REPO" --include "*.gguf" --local-dir "$DIR" >/dev/null 2>&1 || true
  GGUF=$(ls "$DIR"/*.gguf 2>/dev/null | grep -iE "q4" | head -1 || true)
  [ -z "$GGUF" ] && GGUF=$(ls -S "$DIR"/*.gguf 2>/dev/null | tail -1 || true)
fi
# 3) … else convert safetensors → GGUF (LFM2/Qwen/etc. supported by llama.cpp)
if [ -z "$GGUF" ]; then
  echo "  no prebuilt GGUF — converting safetensors"
  SRC="$DIR/src"; rm -rf "$SRC"; mkdir -p "$SRC"
  hf download "$REPO" --local-dir "$SRC" >/dev/null 2>&1 || { echo "download failed"; exit 1; }
  CONV=$(command -v convert_hf_to_gguf.py || echo "$HOME/llama.cpp/convert_hf_to_gguf.py")
  python3 "$CONV" "$SRC" --outfile "$DIR/m-f16.gguf" --outtype f16 >/dev/null 2>&1 || { echo "convert failed"; exit 1; }
  if command -v llama-quantize >/dev/null 2>&1; then llama-quantize "$DIR/m-f16.gguf" "$DIR/m-${QUANT}.gguf" "$QUANT" >/dev/null 2>&1 && rm -f "$DIR/m-f16.gguf"; fi
  GGUF=$(ls "$DIR"/m-*.gguf 2>/dev/null | head -1); rm -rf "$SRC"
fi
[ -z "$GGUF" ] && { echo "could not obtain a GGUF for $REPO"; exit 1; }

# Per-model investigation: quick llama-bench thread probe → pick the fastest generation thread count for THIS model.
# (Serial vs concurrent + native-CPU vs llvmpipe were settled globally by the A/B: serial + -ngl 0 win.)
if [ -z "${THR_FIXED:-}" ]; then
  echo "  probing best thread count (generation)…"
  PROBE=$(llama-bench -m "$GGUF" -ngl "$NGL" -t 6,8,10,12 -p 64 -n 96 -r 2 2>/dev/null \
    | awk -F'|' '$7 ~ /tg/ {gsub(/ /,"",$6); split($8,a,"±"); v=a[1]+0; if(v>best){best=v; t=$6; b=v}} END{if(t)printf "%s %.1f", t, b}')
  if [ -n "$PROBE" ]; then THR="${PROBE%% *}"; echo "  → best: ${PROBE##* } tok/s at threads=$THR"; else echo "  → probe failed, using threads=$THR"; fi
fi
echo "  serving $(basename "$GGUF") ($(du -h "$GGUF" | cut -f1)) · ngl=$NGL parallel=$PAR threads=$THR ctx=$CTX conc=$CONC"

llama-server -m "$GGUF" --port "$PORT" --host 127.0.0.1 -c "$CTX" -fa on -ngl "$NGL" --parallel "$PAR" -t "$THR" --jinja > "$SRV_LOG" 2>&1 &
SRV_PID=$!
for i in $(seq 1 90); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; kill -0 "$SRV_PID" 2>/dev/null || { echo "server died:"; tail -5 "$SRV_LOG"; exit 1; }; sleep 2; done
echo "  server up (pid $SRV_PID)"

cd "$HOME/projects/format-bench"
page() { :; }  # regen handled centrally by regen-watch.sh (single writer → no HTML races across lanes)
# Resumable: a killed mode leaves runs/<label>/convert-<mode>.partial.jsonl; rerunning the same command skips done cases.
if [ -f "$PLAIN" ]; then echo "  ⏭  plain done"; else bun bench.ts run --local -m "$LABEL" --bench convert           --concurrency "$CONC"; page; fi
if [ -f "$EX" ];    then echo "  ⏭  explained done"; else bun bench.ts run --local -m "$LABEL" --bench convert --explain --concurrency "$CONC"; page; fi
