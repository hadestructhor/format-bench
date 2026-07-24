#!/usr/bin/env bash
# Launch one background lane PER PROVIDER. Within a lane, models run one-by-one (plain then explained,
# resumable — a completed convert-*.json is skipped). Providers run as parallel lanes (independent
# endpoints/limits). nvidia keeps 2 streams (cc=2, set inside convert-hosted.sh); others cc=3.
# Free-only. Priority models (previously queued) run first in the nvidia lane so they land tonight.
set -uo pipefail
cd "$(dirname "$0")/.."
SP="/tmp/claude-1000/-home-hades-projects/ecc152a7-3ab9-44f8-87f0-ad7d5c2e4625/scratchpad"
mkdir -p "$SP"
EXCL='embed|bge-|arctic|nvclip|nemoretriever|colbert|deplot|fuyu|kosmos|vila|neva|vision|multimodal|-vl|vl-|guard|content-safety|topic-control|reward|riva|translate|parse|video|gliner|ising|cosmos-reason|synthetic'

launch() {  # launch <provider> <model...>
  local prov="$1"; shift
  local pairs=(); local m
  for m in "$@"; do pairs+=("$prov|$m"); done
  [ ${#pairs[@]} -eq 0 ] && { echo "  $prov: no models — skip"; return; }
  echo "  🛣  lane $prov: ${#pairs[@]} models → runs/.lane-$prov.out"
  nohup bash scripts/convert-hosted.sh "${pairs[@]}" > "runs/.lane-$prov.out" 2>&1 &
  echo "     pid $!"
}

# ── nvidia: applicable text models, FASTEST-FIRST (small / MoE-active-params first; reasoning giants last).
#    gemma-4-31b PARKED (degraded on nvidia ~80s/case; retry manually when a fast free source is up).
#    Slow reasoning models (minimax, kimi, glm-5.1, 340b, 675b…) run last and resume from their partials. ──
mapfile -t NV < <(python3 -c "
import re
EXCL=re.compile(r'embed|bge-|arctic|nvclip|nemoretriever|colbert|deplot|fuyu|kosmos|vila|neva|vision|multimodal|-vl|vl-|guard|content-safety|topic-control|reward|riva|translate|parse|video|gliner|ising|cosmos-reason|synthetic',re.I)
ms=[s.strip() for s in open('models.nvidia-free.txt') if s.strip() and not s.strip().startswith('#') and not EXCL.search(s) and not re.search(r'openai/gpt-oss-(120|20)b',s)]
R=('minimax','glm-5','deepseek-v4-pro','kimi','qwen3.5-397','qwen3.5-122','nemotron-3-ultra','nemotron-3-super','nemotron-ultra','omni','mistral-large-3','nemotron-4-340','-reasoning','thinking','llama-3.1-nemotron-ultra')
def sz(m):
    a=re.search(r'a(\d+)b',m.lower())
    if a: return int(a.group(1))
    b=re.findall(r'(\d+(?:\.\d+)?)b',m.lower()); return float(b[0]) if b else 45
def k(m): v=sz(m); return (1,-v) if any(r in m.lower() for r in R) else (0,-v)  # BIG-FIRST: biggest normal models first (nvidia GPUs handle them well); slow reasoning giants still last
ms=[m for m in ms if m!='google/gemma-4-31b-it']   # parked — degraded on nvidia; retry manually
ms.sort(key=k)
print(chr(10).join(ms))
")

# ── zenmux: stepfun then grok, both free (glm-4.7/4.6v dropped — too slow, per user) ──
# ── zenmux: LANE RETIRED 2026-07-21 — both its models are done with. x-ai/grok-4.5-free went 404 (removed /
#    paid-only; was 429-capped at 91 cases); stepfun/step-3.7-flash-free already completed both modes. ──
ZEN=()

# ── openrouter: DISABLED — free-models-per-day quota exhausted (every :free returns 429 "add credits");
#    nex-n2-pro:free is now paid-only (404, made a 0/0 garbage run). These big models run free on kilo/nvidia
#    anyway. Uncomment the launch line below to retry after the daily quota resets. ──
OR=(nvidia/nemotron-3-ultra-550b-a55b:free
    nvidia/nemotron-3-super-120b-a12b:free
    qwen/qwen3-next-80b-a3b-instruct:free
    qwen/qwen3-coder:free
    nvidia/nemotron-3-nano-30b-a3b:free
    nvidia/nemotron-nano-9b-v2:free
    poolside/laguna-m.1:free
    poolside/laguna-xs.2:free)

# ── googleai: DROPPED — user's free quota exhausted (doesn't work) ───────────────────

# ── opencode/zen: hy3 + the free models (capped tier — may rate-limit, esp. while hades-bench shares the key) ──
OC=(ling-3.0-flash-free laguna-s-2.1-free hy3-free big-pickle deepseek-v4-flash-free mimo-v2.5-free north-mini-code-free nemotron-3-ultra-free)  # ling-3.0-flash = newest free model on zen (2026-07-24), run first

# ── kilo: isFree=true only (auto-router kilo-auto/free + openrouter/free and the content-safety model excluded) ──
KILO=(inclusionai/ling-3.0-flash:free
      kwaipilot/kat-coder-pro-v2.5:free tencent/hy3:free stepfun/step-3.7-flash:free poolside/laguna-xs-2.1:free cohere/north-mini-code:free
      nvidia/nemotron-3-ultra-550b-a55b:free nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
      poolside/laguna-xs.2:free poolside/laguna-m.1:free nvidia/nemotron-3-super-120b-a12b:free)

# ── grok: the installed Grok CLI (free X-account tier → grok-4.5). Driven as a subprocess (not HTTP) by run.ts;
#    convert-hosted.sh skips the HTTP preflight and runs cc=2. Auth = ~/.grok/auth.json (OIDC, CLI auto-refreshes). ──
GROK=(grok-4.5)

# ── tokenrouter: glm-5.2 (slow reasoning + 503-prone; preflight skipped in convert-hosted.sh) ──
TR=(z-ai/glm-5.2-free)

# ── groq: the 4 free models. Per-model RPD caps (1k–7k/day) so it parks daily and resumes next sweep.
#    NOTE: GROQM (groq) is deliberately named apart from GROK (the X CLI) — different providers. ──
GROQM=(allam-2-7b meta-llama/llama-4-scout-17b-16e-instruct qwen/qwen3.6-27b qwen/qwen3-32b)

WANT=" ${*:-nvidia opencodezen kilo grok tokenrouter groq} "   # no args = all live lanes (restart default); else only the named ones
echo "🚦 launching hosted lanes ·$(date '+ %F %T') · want:$WANT"
case "$WANT" in *" nvidia "*)      launch nvidia      "${NV[@]}";; esac
# openrouter DISABLED — free-models-per-day quota exhausted; add "openrouter" arg + uncomment to retry after reset
case "$WANT" in *" opencodezen "*) launch opencodezen "${OC[@]}";; esac
case "$WANT" in *" kilo "*)        launch kilo        "${KILO[@]}";; esac
case "$WANT" in *" grok "*)        launch grok        "${GROK[@]}";; esac
case "$WANT" in *" tokenrouter "*) launch tokenrouter "${TR[@]}";; esac
case "$WANT" in *" groq "*)        launch groq        "${GROQM[@]}";; esac
echo "🚦 lanes launched (want:$WANT · nvidia=${#NV[@]} opencode=${#OC[@]} kilo=${#KILO[@]} grok=${#GROK[@]} tokenrouter=${#TR[@]} groq=${#GROQM[@]})"
