# Submitted results

One directory per evaluated model, named `<YYYYMMDD>_<org>_<model>`.

```
results/20260724_acme_widget-7b/
  convert-plain.json              required
  convert-ex.json                 required
  convert-plain.responses.jsonl   recommended
  convert-ex.responses.jsonl      recommended
  README.md                       recommended — how the model was served
```

Both run files come straight out of the harness; you should never hand-write one:

```bash
bun bench.ts run --base-url <your-endpoint> -m <model> --save-responses
bun bench.ts run --base-url <your-endpoint> -m <model> --explain --save-responses
cp -r runs/<provider>/<model> results/20260724_acme_widget-7b
```

Then validate before opening a PR:

```bash
bun bench.ts validate-submission results/20260724_acme_widget-7b
```

The check that matters is `run.dataset_sha256` — it must match this repo's `benches/convert/test.jsonl`.
A score computed against a modified dataset is not comparable to anything else on the board, so the
validator refuses it.

Your `README.md` should say how the model was served: inference engine and version, quantisation,
hardware, and whether it was an API or a local deployment. Two runs of "the same model" on different
serving stacks can differ by several points, and the leaderboard is more useful when that's on record.
