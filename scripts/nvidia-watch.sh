#!/usr/bin/env bash
# nvidia outage auto-recovery: poll nvidia every 4 min; when it answers 200 and no nvidia lane is running,
# restart the fast-first lane from runs/.nvidia-order.txt, then exit. Run as a FILE so pgrep never self-matches.
cd "$HOME/projects/format-bench" || exit 1
K=$(grep '^NVIDIA_API_KEY=' .env | cut -d= -f2- | tr -d "\"' ")
LOG=runs/.nvidia-watch.log
echo "$(date '+%F %T') armed — polling nvidia every 240s until it recovers" >> "$LOG"
while true; do
  if ! pgrep -f 'scripts/convert-hosted.sh nvidia' >/dev/null 2>&1; then
    code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://integrate.api.nvidia.com/v1/chat/completions \
      -H "Authorization: Bearer $K" -H 'content-type: application/json' \
      -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"ok"}],"max_tokens":3,"temperature":0}')  # canary: gpt-oss-20b is live+fast; llama-3.2-1b was silently killed (hung forever → false "down")
    if [ "$code" = "200" ]; then
      mapfile -t NV < runs/.nvidia-order.txt
      pairs=(); for m in "${NV[@]}"; do pairs+=("nvidia|$m"); done
      nohup bash scripts/convert-hosted.sh "${pairs[@]}" > runs/.lane-nvidia.out 2>&1 &
      echo "$(date '+%F %T') nvidia UP (200) → fast lane restarted (${#NV[@]} models, pid $!)" >> "$LOG"
      exit 0
    fi
    echo "$(date '+%F %T') nvidia still down (HTTP $code)" >> "$LOG"
  fi
  sleep 240
done
