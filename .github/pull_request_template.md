<!-- Submitting results? Fill this in. Changing code? Delete it and describe the change. -->

## Model

- **Name:**
- **Organisation:**
- **Parameters:** (total / active if MoE)
- **Weights:** public / private / API-only
- **Link:**

## How it was served

- **Engine:** (vLLM x.y / SGLang / llama.cpp / hosted API / …)
- **Quantisation:** (none / Q4_K_M / FP8 / …)
- **Hardware:**

## Scores

| mode | task | strict |
|---|---:|---:|
| plain | | |
| explained | | |

## Checklist

- [ ] `bun bench.ts validate-submission results/<dir>` passes
- [ ] Both modes cover all 2,025 cases
- [ ] `run.dataset_sha256` matches this repo's `benches/convert/test.jsonl`
- [ ] Run files are the harness's own output, not edited by hand
- [ ] `--save-responses` output included (so failures can be audited)
