#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${AI_CONDA_ENV_DIR:-$ROOT_DIR/.conda-ai}"
PID_FILE="$ROOT_DIR/.vllm.pid"
LOG_FILE="$ROOT_DIR/vllm.log"

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

url_part() {
  local url="$1"
  local part="$2"
  local fallback="$3"
  "$ENV_DIR/bin/python" - "$url" "$part" "$fallback" <<'PY'
import sys
from urllib.parse import urlparse

url, part, fallback = sys.argv[1], sys.argv[2], sys.argv[3]
parsed = urlparse(url)
if part == "host":
    print(parsed.hostname or fallback)
elif part == "port":
    print(parsed.port or fallback)
else:
    print(fallback)
PY
}

if [[ ! -x "$ENV_DIR/bin/vllm" ]]; then
  echo "Missing $ENV_DIR/bin/vllm. Run: bash scripts/setup-ai-conda.sh" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "vLLM service is already running with PID $old_pid"
    exit 0
  fi
fi

llm_url="$(read_env LLM_BASE_URL "http://127.0.0.1:8000/v1")"
host="$(read_env VLLM_HOST "$(url_part "$llm_url" host "127.0.0.1")")"
port="$(read_env VLLM_PORT "$(url_part "$llm_url" port "8000")")"
model="$(read_env LLM_MODEL "Qwen/Qwen3-4B-Instruct-2507")"
gpu="$(read_env LLM_GPU "0")"
served_model_name="$(read_env VLLM_SERVED_MODEL_NAME "$model")"
dtype="$(read_env VLLM_DTYPE "")"
max_model_len="$(read_env VLLM_MAX_MODEL_LEN "")"
gpu_memory_utilization="$(read_env VLLM_GPU_MEMORY_UTILIZATION "")"
extra_args="$(read_env VLLM_EXTRA_ARGS "")"

cmd=(
  "$ENV_DIR/bin/vllm"
  serve "$model"
  --host "$host"
  --port "$port"
  --served-model-name "$served_model_name"
)

if [[ -n "$dtype" ]]; then
  cmd+=(--dtype "$dtype")
fi

if [[ -n "$max_model_len" ]]; then
  cmd+=(--max-model-len "$max_model_len")
fi

if [[ -n "$gpu_memory_utilization" ]]; then
  cmd+=(--gpu-memory-utilization "$gpu_memory_utilization")
fi

if [[ -n "$extra_args" ]]; then
  read -r -a parsed_extra_args <<< "$extra_args"
  cmd+=("${parsed_extra_args[@]}")
fi

mkdir -p "$(dirname "$LOG_FILE")"
cd "$ROOT_DIR"
setsid env CUDA_VISIBLE_DEVICES="$gpu" "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
pid="$!"
echo "$pid" > "$PID_FILE"

echo "vLLM service starting on http://$host:$port/v1 with PID $pid"
echo "Model: $model"
echo "Log: $LOG_FILE"
