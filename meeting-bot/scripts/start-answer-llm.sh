#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.answer-llm.pid"
LOG_FILE="$ROOT_DIR/answer-llm.log"

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

ENV_DIR="$(
  read_env ANSWER_LLM_CONDA_ENV_DIR \
    "$(read_env VLM_CONDA_ENV_DIR "/scratch1/bbz5169/conda/envs/ms-swift-grpo")"
)"

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
  echo "Missing $ENV_DIR/bin/vllm. Set ANSWER_LLM_CONDA_ENV_DIR or run setup for a vLLM env." >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "Answer LLM service is already running with PID $old_pid"
    exit 0
  fi
fi

answer_url="$(read_env ANSWER_LLM_BASE_URL "http://127.0.0.1:8001/v1")"
host="$(read_env ANSWER_LLM_HOST "$(url_part "$answer_url" host "127.0.0.1")")"
port="$(read_env ANSWER_LLM_PORT "$(url_part "$answer_url" port "8001")")"
model="$(read_env ANSWER_LLM_MODEL "Qwen/Qwen3-4B-Instruct-2507")"
gpu="$(read_env ANSWER_LLM_GPU "3")"
served_model_name="$(read_env ANSWER_LLM_SERVED_MODEL_NAME "$model")"
dtype="$(read_env ANSWER_LLM_DTYPE "$(read_env VLLM_DTYPE "")")"
max_model_len="$(read_env ANSWER_LLM_MAX_MODEL_LEN "$(read_env VLLM_MAX_MODEL_LEN "32768")")"
gpu_memory_utilization="$(read_env ANSWER_LLM_GPU_MEMORY_UTILIZATION "$(read_env VLLM_GPU_MEMORY_UTILIZATION "")")"
extra_args="$(read_env ANSWER_LLM_EXTRA_ARGS "")"
trust_remote_code="$(read_env ANSWER_LLM_TRUST_REMOTE_CODE "true")"

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

if [[ "$trust_remote_code" == "true" ]]; then
  cmd+=(--trust-remote-code)
fi

if [[ -n "$extra_args" ]]; then
  read -r -a parsed_extra_args <<< "$extra_args"
  cmd+=("${parsed_extra_args[@]}")
fi

mkdir -p "$(dirname "$LOG_FILE")"
cd "$ROOT_DIR"
setsid env \
  CUDA_VISIBLE_DEVICES="$gpu" \
  CUDA_HOME="$ENV_DIR" \
  PATH="$ENV_DIR/bin:$PATH" \
  LD_LIBRARY_PATH="$ENV_DIR/lib64:$ENV_DIR/lib:$ENV_DIR/targets/x86_64-linux/lib:${LD_LIBRARY_PATH:-}" \
  HF_HOME="${HF_HOME:-/scratch1/qxl5189/hf-cache}" \
  VLLM_CONFIGURE_LOGGING="${VLLM_CONFIGURE_LOGGING:-0}" \
  TOKENIZERS_PARALLELISM="${TOKENIZERS_PARALLELISM:-false}" \
  "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
pid="$!"
echo "$pid" > "$PID_FILE"

echo "Answer LLM service starting on http://$host:$port/v1 with PID $pid"
echo "Model: $served_model_name"
echo "GPU: $gpu"
echo "Log: $LOG_FILE"
