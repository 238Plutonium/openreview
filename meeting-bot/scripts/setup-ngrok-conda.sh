#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="$ROOT_DIR/.conda-ngrok"

if [[ -n "${CONDA_EXE:-}" && -x "$CONDA_EXE" ]]; then
  CONDA_BIN="$CONDA_EXE"
elif command -v conda >/dev/null 2>&1; then
  CONDA_BIN="$(command -v conda)"
else
  echo "conda was not found. Load conda first or set CONDA_EXE=/path/to/conda." >&2
  exit 1
fi

"$CONDA_BIN" create -y -p "$ENV_DIR" -c conda-forge python=3.12 pyngrok

echo "Created ngrok conda environment at $ENV_DIR"
echo "Start the tunnel with: bash scripts/start-ngrok.sh"
