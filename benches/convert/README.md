# convert — cross-format reformatting dataset

Convert data `from` one format `to` another **while applying stated challenges**. Difficulty grows on two
axes at once: **nesting depth** (level 1–5) and **stacked challenges** (1 → all). Deterministic — every
`expected` is computed in code, so it's provably correct. Regenerate with `bun scripts/gen-convert.ts`.

## Files

| file | rows | contents |
|---|--:|---|
| `test.jsonl` | 2025 | the benchmark — every direction × level × challenge-tier cell |
| `train.jsonl` | 625 | the worked example pool for `--explain`, and a fine-tuning set |

The two splits share **no input strings** — the generator enforces disjointness before writing. `train` draws
from a different value pool (names, cities, notes, number ranges) than `test`, so a model tuned on `train` is
measured on genuinely unseen values.

Both splits cover the full difficulty range (`train` is easy 93 · moderate 202 · hard 174 · extreme 156);
difficulty is *not* held out. If you want a generalisation split that withholds the hardest compositions,
filter `train.jsonl` on `difficulty !== "extreme"` yourself.

## Case schema

```json
{ "id":"test-0001", "split":"test", "from":"yaml", "to":"json",
  "level":3, "challenges":["count","enum"], "difficulty":"hard",
  "instructions":"- Keep every key…\n- Normalize `role`…",
  "prompt":"Convert the following YAML to JSON.\n<instructions>\n…\n\n<input>",
  "input":"<source in `from`>",
  "expected": <target VALUE>,
  "output":"<canonical target serialization>" }
```

- **Eval:** feed `prompt`; parse the model's reply as `to`; `deep-equal` against `expected`
  (object keys order-insensitive, arrays ordered — see `score.ts`).
- **Train (SFT):** input = `prompt`, target = `"Output: " + output`.

## Challenges

| key | source → expected |
|---|---|
| `type` | number/bool written as a string → real number/boolean |
| `unit` | `"22C"` → `22` |
| `enum` | `"  ADMIN "` → `"admin"` (∈ admin \| user \| guest) |
| `escape` | commas / quotes / newlines / `\` / unicode preserved exactly |
| `count` | keep the top-2 records by `score`, highest first *(collections)* |
| `wrap` | put the list under `items`, drop `active` *(collections)* |

Nesting buries the data (and the fields a challenge targets) under wrapper keys, and at level ≥3 adds a
per-record `meta` object, level ≥4 a `tags` array. `difficulty = f(level-1 + #challenges)`:
`easy ≤1 · moderate ≤3 · hard ≤5 · extreme ≥6`.

Run it with `bun bench.ts run --provider <id> -m <model>` (add `--explain` for the worked-example mode), and
verify the data against the scorer at any time with `bun bench.ts gold` — it must report 2025/2025.
