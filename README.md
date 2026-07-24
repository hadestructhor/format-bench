# format-bench

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Dataset](https://img.shields.io/badge/dataset-2025%20cases-informational)](benches/convert/test.jsonl)
[![Leaderboard](https://img.shields.io/badge/leaderboard-live-success)](https://hadestructhor.github.io/format-bench/)

**Can a model rewrite your data into another format without breaking it?**

Converting text, JSON, YAML and CSV into one another looks trivial and isn't. The model has to keep every
field, reconstruct the types CSV threw away, strip units, clamp ranges, escape correctly — and then emit the
target format and nothing else. This benchmark measures exactly that, on **2,025 frozen cases** across
**nine directions**, with every model run **twice**: once with plain instructions, once with a worked example.

📊 **[Leaderboard →](https://hadestructhor.github.io/format-bench/)**

---

## Results

58 models, best of both prompt modes. `task` = the correct value appears in the reply · `strict` = the whole
reply is exactly that value · `Δ` = what the worked example changed.

| Model | Provider | Size | task (plain) | task (ex) | strict (ex) | Δ |
|---|---|---|---:|---:|---:|---:|
| llama-4-maverick-17b-128e | nvidia | 400B | 62 | **79** | 79 | +17 |
| nemotron-3-ultra | opencode | 550B | 74 | 73 | 73 | −1 |
| deepseek-v4-flash | nvidia | 284B | 69 | 73 | 73 | +4 |
| gpt-oss-20b | nvidia | 21B | 68 | 72 | 72 | +4 |
| nemotron-3-nano-omni-30b-a3b | nvidia | 33B | 67 | 72 | 72 | +5 |
| gpt-oss-120b | nvidia | 117B | 68 | 71 | 71 | +3 |
| seed-oss-36b-instruct | nvidia | 36.2B | 62 | 70 | 70 | +8 |
| glm-5.2 | tokenrouter | 744B | 70 | 70 | 70 | +0 |
| mistral-medium-3.5-128b | nvidia | 128B | 59 | 69 | 69 | +10 |
| nemotron-3-super-120b-a12b | kilo | 120.6B | 65 | 69 | 69 | +4 |

**Nobody is close to solved.** The best model gets 79/100; no case in the set is solved by every model, and
173 of 2,025 (8.5%) are solved by none. There is real headroom here.

**A worked example is not reliably useful.** Across 58 models the mean Δ is −0.4 points: 28 models improved,
23 got worse, 7 were unchanged. "Just show it an example" is folk wisdom this dataset does not support.

**Size helps, but weakly.** A 21B model (gpt-oss-20b, 72) beats a 744B one (glm-5.2, 70). What separates
models is instruction adherence under compound constraints, not parameter count.

---

## Quickstart

```bash
git clone https://github.com/hadestructhor/format-bench
cd format-bench
bun install
```

Prove the harness works before trusting any number it gives you:

```bash
bun bench.ts gold        # scores the dataset's own reference answers — must print 2025/2025
```

## Evaluating your own model

The only thing format-bench needs is an **OpenAI-compatible `/chat/completions` endpoint**. vLLM, SGLang,
llama.cpp, Ollama, or a hosted API — all the same to it. No adapter class, no repo edits.

```bash
# plain mode
bun bench.ts run \
  --base-url http://localhost:8000/v1 \
  --api-key sk-your-key \
  -m your-model-name \
  --save-responses

# explained mode (same model, one worked example prepended)
bun bench.ts run \
  --base-url http://localhost:8000/v1 \
  --api-key sk-your-key \
  -m your-model-name \
  --explain --save-responses
```

Results land in `runs/<provider>/<model>/convert-{plain,ex}.json`.

<details>
<summary><b>All flags</b></summary>

| Flag | Default | Meaning |
|---|---|---|
| `--base-url <url>` | — | OpenAI-compatible endpoint. The main path for external models. |
| `--api-key <key>` | `$FORMAT_BENCH_API_KEY` | Sent as `Authorization: Bearer`. |
| `--provider <id>` | — | Use a preconfigured provider instead (see `providers.ts`). |
| `--local` | — | Shortcut for a local llama-server on `:8091`. |
| `-m, --model <id>` | — | Passed straight through as the API `model` field. **Required.** |
| `--explain` | off | Prepend one worked example of the same direction from the train split. |
| `--save-responses` | **off** | Write every full reply to `convert-<mode>.responses.jsonl`. |
| `--max-tokens <n>` | `32768` | Output ceiling. A reply cut off here is an **error**, never a wrong answer. |
| `--temperature <t>` | `0` | Sampling temperature. |
| `--thinking <level>` | — | `reasoning_effort` (low/medium/high); recorded as its own row. |
| `--concurrency <n>` | `4` | Parallel in-flight requests. |
| `--repeat <n>` | `1` | Run each case N times and average. |
| `--limit <n>` | — | Smoke test. Writes no run file and never touches a real resume checkpoint. |

</details>

### Saving responses

`--save-responses` is **off by default**. Turn it on and every reply is written in full — untruncated — to
`runs/<provider>/<model>/convert-<mode>.responses.jsonl`:

```json
{"id":"test-00001","response":"{\"name\":\"Miso Ramen\",…}","finish_reason":"stop","latency_ms":412}
```

This is the file you want when you're improving a model rather than just ranking it: it lets you read exactly
what your model emitted on every case it failed. It is off by default because it is large and most leaderboard
runs don't need it.

### Interruptions are safe

Every scored case is appended to `convert-<mode>.partial.jsonl` as it completes. Re-run the identical command
and it picks up where it stopped. Cases that **errored** are deliberately not checkpointed, so they get retried
rather than frozen as failures. If more than 20% of cases error, the run refuses to write a result file at all —
a rate-limited provider produces no score rather than a fake one.

---

## How scoring works

Each reply is graded on two independent axes:

- **task** — the correct value appears somewhere in the reply. Prose and code fences are tolerated.
  *Did the conversion work?*
- **strict** — the entire trimmed reply parses as the target format and equals the expected value.
  *Can it follow "reply with only the value"?*

Comparison is structural, not textual: object keys are order-insensitive, arrays are ordered, and types are
strict. `{"rating": "5"}` is **wrong** when the answer is `{"rating": 5}` — preserving types is the job.

A YAML answer that is really JSON is not strict-YAML, even though JSON is valid YAML: the task said produce
YAML, and `{"a": 1}` is not idiomatic YAML.

## The dataset

`benches/convert/test.jsonl` — 2,025 cases, frozen, committed. `train.jsonl` — 625 cases for the worked
example, sharing no inputs with the test set.

A Hugging Face mirror can be published with `HF_TOKEN=hf_… bash scripts/publish-hf.sh`; it uploads the same
files byte-for-byte, so the sha256 recorded in every run file still matches.

| Axis | Values |
|---|---|
| **Directions** (9) | text→json · text→yaml · text→csv · json→yaml · json→csv · yaml→json · yaml→csv · csv→json · csv→yaml |
| **Levels** (5) | L1 flat record · L2 a few fields · L3 list of tags · L4 list of records · L5 nested groups |
| **Domains** (8) | recipe · product · basket · profile · event · sensor · media · transaction |
| **Constraints** (7) | `type` `unit` `enum` `range` `count` `wrap` `escape` |
| **Tiers** (5) | x0, x1, x2, x3, xall — 405 cases each |

Constraints are orthogonal instructions layered onto the conversion. Their measured cost, averaged over all
models against the no-constraint baseline of 56:

| Constraint | Score | Cost | What it asks |
|---|---:|---:|---|
| `count` | 25 | −31 | keep only the first N items |
| `enum` | 26 | −30 | normalise category text to canonical form |
| `range` | 28 | −28 | clamp numbers to a valid range |
| `escape` | 30 | −27 | preserve special characters, escaped for the target |
| `unit` | 30 | −26 | strip unit suffixes (`30min`→30, `$5`→5) |
| `wrap` | 31 | −26 | wrap the result under one top-level key |
| `type` | 31 | −25 | text-written numbers/booleans → real numbers/booleans |

### Case format

```json
{
  "id": "test-00001", "split": "test", "domain": "recipe",
  "from": "text", "to": "json", "level": 1,
  "challenges": [], "tier": "x0", "difficulty": "easy",
  "instructions": "Convert the following field notes into JSON.\n- Keep every field…",
  "input": "Field notes on a recipe:\nname: Miso Ramen\nprepMinutes: 20…",
  "expected": { "name": "Miso Ramen", "prepMinutes": 20 },
  "output": "{\"name\":\"Miso Ramen\",\"prepMinutes\":20}"
}
```

`expected` is the parsed value for JSON/YAML targets and the canonical CSV string for CSV targets. `output` is
the reference answer — `bun bench.ts gold` scores it to prove the harness and the data agree.

Regenerate deterministically with `bun scripts/gen-convert.ts` (it self-checks every case before writing).

---

## Limitations

Stated plainly, because a benchmark that hides these is worth less than one that doesn't.

**1. The `enum` constraint is partly unguessable in v1.0.** It asks for category text in "canonical lowercase
form", giving `IN STOCK → in_stock` as an example — but expects `Pre-order → preorder` (dropping the underscore
the example implies) and `clear → cleared` (a different word, not a case change). All three never-solved *easy*
cases are enum cases. On those, the benchmark measures vocabulary guessing rather than instruction-following.

The dataset is frozen for v1.0 so published scores stay comparable, so the site and `board.json` also carry a
**`noEnum` score** with those cases removed — on average 8.6 points higher. v1.1 will list the allowed
vocabulary in the instruction: a prompt-only change that leaves every expected answer byte-identical.

**2. Levels are comparable within a direction, not across.** L1–L3 include the CSV directions while L4–L5 are
nested-only, so the level axis is confounded with direction difficulty. Read the level curve one direction at
a time.

**3. Two runs are withheld.** An earlier harness capped output at 2,048 tokens. Reasoning models spent that
budget thinking and were cut off before writing the answer — which scored as a wrong answer rather than an
infrastructure failure. Those runs are excluded from the board rather than shown;
`bun scripts/detect-truncated.ts` is the detector. The harness now treats a truncated reply as a retryable
error and never as a zero.

**4. Single sample by default.** `--repeat 1` and `temperature 0`. No confidence intervals are published.

---

## Submitting results

```
results/<YYYYMMDD>_<org>_<model>/
  convert-plain.json
  convert-ex.json
  convert-plain.responses.jsonl   (recommended)
  convert-ex.responses.jsonl      (recommended)
  README.md                       (how the model was served)
```

Validate before opening a PR:

```bash
bun bench.ts validate-submission results/20260724_acme_my-model
```

It checks the layout, that both modes cover all 2,025 cases, and — the one that matters — that
`run.dataset_sha256` matches this repo's `test.jsonl`. A score computed against a different dataset is not
comparable to anything on the board.

## Repository layout

| Path | What |
|---|---|
| `bench.ts` | CLI: `run` · `gold` · `list` · `validate-submission` |
| `run.ts` | Orchestration, resume checkpoints, the capped-run guard |
| `call.ts` | The single model-calling primitive (OpenAI-compatible, rate-gated, retrying) |
| `score.ts` | `scoreConvert` + the self-check (`bun score.ts`) |
| `benches/convert/` | The frozen dataset |
| `scripts/gen-convert.ts` | Deterministic dataset generator |
| `scripts/build-data.ts` | `runs/` → `docs/data/*.json` for the site |
| `docs/` | The published leaderboard (GitHub Pages) |

## Citation

```bibtex
@software{alyacoub2026formatbench,
  author  = {Al Yacoub, Angelo},
  title   = {format-bench: a benchmark for data-format conversion},
  year    = {2026},
  version = {1.0.0},
  url     = {https://github.com/hadestructhor/format-bench}
}
```

## License

Apache-2.0. See [LICENSE](LICENSE).
