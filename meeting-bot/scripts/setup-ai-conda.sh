#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="$ROOT_DIR/.conda-ai"

find_conda() {
  if [[ -n "${CONDA_EXE:-}" && -x "$CONDA_EXE" ]]; then
    echo "$CONDA_EXE"
    return 0
  fi

  if command -v conda >/dev/null 2>&1; then
    command -v conda
    return 0
  fi

  for candidate in \
    /scratch1/"$USER"/conda/bin/conda \
    /scratch2/"$USER"/conda/bin/conda \
    "$HOME"/miniconda3/bin/conda \
    "$HOME"/anaconda3/bin/conda; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

CONDA_BIN="$(find_conda || true)"
if [[ -z "$CONDA_BIN" ]]; then
  echo "Could not find conda. Set CONDA_EXE or add conda to PATH." >&2
  exit 1
fi

if [[ ! -x "$ENV_DIR/bin/python" ]]; then
  "$CONDA_BIN" create -y -p "$ENV_DIR" -c conda-forge python=3.11 pip ffmpeg
fi

"$ENV_DIR/bin/python" -m pip install --upgrade pip
"$ENV_DIR/bin/python" -m pip install \
  "fastapi>=0.115" \
  "uvicorn[standard]>=0.30" \
  "faster-whisper>=1.1.0" \
  "numpy<2.3" \
  "openai>=1.0" \
  "vllm==0.8.5.post1" \
  "transformers==4.57.6" \
  "huggingface-hub<1.0,>=0.34.0"

"$ENV_DIR/bin/python" -m pip uninstall -y \
  flashinfer-python \
  flashinfer-cubin \
  torch-c-dlpack-ext \
  apache-tvm-ffi \
  humming-kernels \
  tilelang \
  quack-kernels \
  tokenspeed-mla \
  tokenspeed-triton \
  >/dev/null 2>&1 || true

echo "AI conda environment ready at $ENV_DIR"
