#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${VLM_CONDA_ENV_DIR:-$ROOT_DIR/.conda-vlm}"

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
  "$CONDA_BIN" create -y -p "$ENV_DIR" -c conda-forge python=3.12 pip
fi

"$ENV_DIR/bin/python" -m pip install --upgrade pip uv
"$ENV_DIR/bin/python" -m pip install --upgrade \
  "openai>=1.0" \
  "pillow>=10" \
  "requests>=2"

if [[ -n "${VLM_VLLM_INSTALL_COMMAND:-}" ]]; then
  echo "Running custom VLM_VLLM_INSTALL_COMMAND inside $ENV_DIR"
  (
    source "$ENV_DIR/bin/activate"
    bash -lc "$VLM_VLLM_INSTALL_COMMAND"
  )
else
  echo "Installing vLLM with uv torch backend auto detection"
  if ! "$ENV_DIR/bin/uv" pip install --python "$ENV_DIR/bin/python" -U vllm --torch-backend=auto; then
    cat >&2 <<'MSG'
Failed to install a newer vLLM wheel for this machine.

This server currently reports CUDA 12.4. If the latest prebuilt vLLM wheel
requires a newer CUDA runtime than the driver can run, either:
  1. set VLM_VLLM_INSTALL_COMMAND to a known-good install command for this host,
  2. build vLLM from source against this CUDA/toolchain, or
  3. use the fallback Qwen/Qwen3-VL-4B-Instruct in an existing compatible env.
MSG
    exit 1
  fi
fi

if ! "$ENV_DIR/bin/python" - <<'PY'
import vllm
print(f"vLLM import OK: {vllm.__version__}")
PY
then
  echo "vLLM import failed in $ENV_DIR; check CUDA/PyTorch compatibility." >&2
  exit 1
fi

echo "VLM conda environment ready at $ENV_DIR"
