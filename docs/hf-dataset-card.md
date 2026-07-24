---
license: apache-2.0
task_categories:
  - text2text-generation
language:
  - en
tags:
  - benchmark
  - structured-output
  - json
  - yaml
  - csv
  - data-transformation
pretty_name: format-bench
size_categories:
  - 1K<n<10K
configs:
  - config_name: default
    data_files:
      - split: test
        path: data/test.jsonl
      - split: train
        path: data/train.jsonl
---

# format-bench

**Can a model rewrite your data into another format without breaking it?**

2,025 frozen test cases covering nine conversion directions between text, JSON, YAML and CSV. Each case
gives the model data in one format and asks for it in another, under a set of stated transformation rules.

- 📊 **Leaderboard:** https://hadestructhor.github.io/format-bench/
- 💻 **Harness:** https://github.com/hadestructhor/format-bench
- `test.jsonl` sha256: `__TEST_SHA__`

The files here are **byte-identical** to `benches/convert/{test,train}.jsonl` in the GitHub repo — the same
sha256 the harness records in every run file. Scores are only comparable when that hash matches.

## Splits

| split | rows | purpose |
|---|--:|---|
| `test` | 2025 | the benchmark |
| `train` | 625 | worked-example pool for the "explained" prompt mode; also a fine-tuning set |

The splits share no input strings — the generator enforces disjointness before writing.

## Fields

| field | type | meaning |
|---|---|---|
| `id` | string | stable case id, e.g. `test-00001` |
| `from` / `to` | string | source and target format (`text`/`json`/`yaml`/`csv` → `json`/`yaml`/`csv`) |
| `level` | int | structural depth 1–5 (CSV directions stop at 3) |
| `domain` | string | one of 8 subject domains |
| `challenges` | list[string] | constraints in force: `type` `unit` `enum` `range` `count` `wrap` `escape` |
| `tier` / `nChallenges` | string / int | challenge tier (`x0`…`xall`) and its count |
| `difficulty` | string | `easy` / `moderate` / `hard` / `extreme`, derived from level + constraint count |
| `instructions` | string | the transformation rules shown to the model |
| `input` | string | the data to convert |
| `expected` | object **or** string | the reference value — see the note below |
| `output` | string | the reference answer as text; scores `task` and `strict` by construction |

> **`expected` is polymorphic.** For `to: "json"` and `to: "yaml"` it is a parsed object or array. For
> `to: "csv"` it is the canonical CSV **string**. This is deliberate — CSV has no native object form — but it
> means a strict typed schema will reject the file. Load it as JSON Lines:

```python
import json

rows = [json.loads(l) for l in open("data/test.jsonl")]
print(len(rows))                                  # 2025
print(rows[0]["from"], "->", rows[0]["to"])       # text -> json
```

`datasets.load_dataset` will also work, but Arrow coerces `expected` to a string for the CSV rows; if you
need the parsed value, use the plain JSON Lines read above.

## Grading

Two axes per case:

- **task** — the correct value appears anywhere in the reply (prose and code fences tolerated).
- **strict** — the whole trimmed reply parses as the target format and equals `expected`.

Comparison is structural: object keys are order-insensitive, arrays are ordered, and types are strict —
`"22"` is not `22`.

## Known limitation

The `enum` constraint has a small number of unguessable targets in v1.0 (`Pre-order → preorder`,
`clear → cleared`), so on those cases it measures vocabulary guessing rather than instruction-following. The
dataset is frozen so published scores stay comparable; the leaderboard also reports an enum-excluded score.
See the repo README for the full list of limitations.

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
