#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${AI_CONDA_ENV_DIR:-$ROOT_DIR/.conda-ai}"
PID_FILE="$ROOT_DIR/.asr.pid"
LOG_FILE="$ROOT_DIR/asr.log"

read_env() {
  local name="$1"
  local fallback="${2:-}"

  if [[ -n "${!name:-}" ]]; then
    printf '%s\n' "${!name}"
    return 0
  fi

  if [[ -f "$ROOT_DIR/.env" ]]; then
    local value
    value="$(
      awk -v key="$name" '
        BEGIN { FS = "=" }
        $1 == key {
          sub(/^[^=]*=/, "")
          gsub(/^[ \t]+|[ \t]+$/, "")
          gsub(/^"|"$/, "")
          gsub(/^'\''|'\''$/, "")
          print
          exit
        }
      ' "$ROOT_DIR/.env"
    )"

    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi

  printf '%s\n' "$fallback"
}

port_from_url() {
  local url="$1"
  local fallback="$2"
  "$ENV_DIR/bin/python" - "$url" "$fallback" <<'PY'
import sys
from urllib.parse import urlparse

url = sys.argv[1]
fallback = int(sys.argv[2])
parsed = urlparse(url)
print(parsed.port or fallback)
PY
}

if [[ ! -x "$ENV_DIR/bin/python" ]]; then
  echo "Missing $ENV_DIR/bin/python. Run: bash scripts/setup-ai-conda.sh" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "ASR service is already running with PID $old_pid"
    exit 0
  fi
fi

asr_url="$(read_env ASR_SERVICE_URL "http://127.0.0.1:7001")"
export ASR_HOST="$(read_env ASR_HOST "127.0.0.1")"
export ASR_PORT="$(read_env ASR_PORT "$(port_from_url "$asr_url" 7001)")"
export ASR_MODEL="$(read_env ASR_MODEL "large-v3")"
export ASR_DEVICE="$(read_env ASR_DEVICE "cuda")"
export ASR_COMPUTE_TYPE="$(read_env ASR_COMPUTE_TYPE "float16")"
export ASR_LANGUAGE="$(read_env ASR_LANGUAGE "")"
export ASR_BEAM_SIZE="$(read_env ASR_BEAM_SIZE "1")"
export ASR_VAD_FILTER="$(read_env ASR_VAD_FILTER "false")"
export ASR_NO_SPEECH_THRESHOLD="$(read_env ASR_NO_SPEECH_THRESHOLD "0.6")"
  export ASR_INITIAL_PROMPT="$(
  read_env ASR_INITIAL_PROMPT \
    "Clinical ECHO education meeting. Doctors discuss patient cases, treatment options, and slides."
)"

gpu="$(read_env ASR_GPU "1")"
export CUDA_VISIBLE_DEVICES="$gpu"

# Keep Hugging Face caches on scratch — home quota / HF xet downloads break large-v3.
export HF_HOME="$(read_env HF_HOME "/scratch1/qxl5189/huggingface")"
export HUGGINGFACE_HUB_CACHE="$(read_env HUGGINGFACE_HUB_CACHE "$HF_HOME/hub")"
export HF_HUB_DISABLE_XET="$(read_env HF_HUB_DISABLE_XET "1")"
mkdir -p "$HUGGINGFACE_HUB_CACHE"

mkdir -p "$(dirname "$LOG_FILE")"
cd "$ROOT_DIR"
setsid env \
  CUDA_VISIBLE_DEVICES="$CUDA_VISIBLE_DEVICES" \
  HF_HOME="$HF_HOME" \
  HUGGINGFACE_HUB_CACHE="$HUGGINGFACE_HUB_CACHE" \
  HF_HUB_DISABLE_XET="$HF_HUB_DISABLE_XET" \
  ASR_HOST="$ASR_HOST" \
  ASR_PORT="$ASR_PORT" \
  ASR_MODEL="$ASR_MODEL" \
  ASR_DEVICE="$ASR_DEVICE" \
  ASR_COMPUTE_TYPE="$ASR_COMPUTE_TYPE" \
  ASR_LANGUAGE="$ASR_LANGUAGE" \
  ASR_BEAM_SIZE="$ASR_BEAM_SIZE" \
  ASR_VAD_FILTER="$ASR_VAD_FILTER" \
  ASR_NO_SPEECH_THRESHOLD="$ASR_NO_SPEECH_THRESHOLD" \
  ASR_INITIAL_PROMPT="$ASR_INITIAL_PROMPT" \
  "$ENV_DIR/bin/python" "$ROOT_DIR/scripts/asr_service.py" >> "$LOG_FILE" 2>&1 < /dev/null &
pid="$!"
echo "$pid" > "$PID_FILE"

echo "ASR service starting on http://$ASR_HOST:$ASR_PORT with PID $pid"
echo "Log: $LOG_FILE"
