#!/usr/bin/env bash
# Publish the frozen dataset to Hugging Face as a mirror of benches/convert/{test,train}.jsonl.
#
# The files are uploaded BYTE-IDENTICAL to the ones in this repo, on purpose: every run file records the
# sha256 of test.jsonl, and a mirror that differs — even by a field rename or a re-encode — silently makes
# scores incomparable. (This is the exact trap IFStruct fell into: its HF copy renames `seed`→`doc_id` and
# JSON-encodes two fields, so its own loader cannot read its own mirror.)
#
# Needs a token with WRITE access to repos:
#   https://huggingface.co/settings/tokens → New token → Write  (a fine-grained token needs repos.write)
#
# Usage: HF_TOKEN=hf_... bash scripts/publish-hf.sh [namespace]
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

NS="${1:-hadestructhor}"
REPO="$NS/format-bench"
: "${HF_TOKEN:?set HF_TOKEN to a token with repos.write}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/data"
cp benches/convert/test.jsonl benches/convert/train.jsonl "$STAGE/data/"

SHA=$(sha256sum benches/convert/test.jsonl | cut -d' ' -f1)
sed "s/__TEST_SHA__/$SHA/" docs/hf-dataset-card.md > "$STAGE/README.md"

hf auth login --token "$HF_TOKEN" >/dev/null
hf repo create "$REPO" --repo-type dataset -y || echo "(repo already exists — updating)"
hf upload "$REPO" "$STAGE" . --repo-type dataset \
  --commit-message "format-bench $(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0) — 2025 test / 625 train"

echo
echo "✓ https://huggingface.co/datasets/$REPO"
echo "  test.jsonl sha256 $SHA"
echo
echo "Verify the mirror round-trips before trusting it:"
echo "  curl -sL https://huggingface.co/datasets/$REPO/resolve/main/data/test.jsonl | sha256sum"
echo "  ...must print the sha above."
