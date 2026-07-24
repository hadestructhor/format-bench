#!/usr/bin/env bash
cd "$HOME/projects/format-bench"
echo "══════════ STATUS $(date '+%F %T') ══════════"
echo "-- completed models: $(ls runs/*/*/convert-plain.json 2>/dev/null | wc -l) plain / $(ls runs/*/*/convert-ex.json 2>/dev/null | wc -l) ex --"
echo "-- in-flight partials (top 8 by lines) --"
ls -S runs/*/*/*.partial.jsonl 2>/dev/null | head -8 | while read f; do printf "  %5s  %s\n" "$(wc -l < "$f")" "${f#runs/}"; done
echo "-- lanes --"
pgrep -af 'bash scripts/convert-(hosted|cycle)\.sh' | sed -E 's/ (nvidia|kilo)\|.*/ \1 [queue…]/; s#(convert-cycle.sh [^ ]+).*#\1#' | sed 's/^/  /'
echo "-- 8091/load --"
curl -s -o /dev/null -w '  8091 HTTP %{http_code}\n' http://localhost:8091/health 2>/dev/null || echo "  8091 down"
uptime | grep -oE 'load average.*'
