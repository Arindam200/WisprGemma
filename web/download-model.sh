#!/usr/bin/env bash
# Downloads the q4f16 Gemma 4 E2B weights once (parallel, resumable) and
# serves them on localhost:8975. The app auto-detects this server and loads
# from disk instead of pulling 3.4 GB from Hugging Face per origin.
set -euo pipefail
cd "$(dirname "$0")"

REPO="onnx-community/gemma-4-E2B-it-ONNX"
DIR="models/$REPO"

if ! command -v hf >/dev/null 2>&1 && ! command -v huggingface-cli >/dev/null 2>&1; then
  echo "Installing huggingface_hub CLI..."
  pip install -q -U "huggingface_hub[cli]"
fi
HF_CLI=$(command -v hf || command -v huggingface-cli)

echo "Downloading q4f16 weights + configs to $DIR ..."
"$HF_CLI" download "$REPO" \
  --include "*.json" "*.txt" "*.model" "onnx/*q4f16*" \
  --local-dir "$DIR"

echo
echo "Serving models/ on http://localhost:8975 (leave this running)"
npx serve models --cors -l 8975
