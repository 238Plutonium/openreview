#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.vlm.pid"
LOG_FILE="$ROOT_DIR/vlm.log"

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
  read_env VLM_CONDA_ENV_DIR \
    "/scratch1/bbz5169/conda/envs/ms-swift-grpo"
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

start_model() {
  local model="$1"
  local host="$2"
  local port="$3"
  local served_model_name="$4"
  local gpu="$5"
  local limit_mm_per_prompt="$6"

  local -a cmd=(
    "$ENV_DIR/bin/vllm"
    serve "$model"
    --host "$host"
    --port "$port"
    --served-model-name "$served_model_name"
  )

  if [[ -n "$limit_mm_per_prompt" ]]; then
    cmd+=(--limit-mm-per-prompt "$limit_mm_per_prompt")
  fi

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

  setsid env \
    CUDA_VISIBLE_DEVICES="$gpu" \
    CUDA_HOME="$ENV_DIR" \
    PATH="$ENV_DIR/bin:$PATH" \
    LD_LIBRARY_PATH="$ENV_DIR/lib64:$ENV_DIR/lib:$ENV_DIR/targets/x86_64-linux/lib:${LD_LIBRARY_PATH:-}" \
    HF_HOME="${HF_HOME:-/scratch1/qxl5189/hf-cache}" \
    VLLM_CONFIGURE_LOGGING="${VLLM_CONFIGURE_LOGGING:-0}" \
    TOKENIZERS_PARALLELISM="${TOKENIZERS_PARALLELISM:-false}" \
    "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
  echo "$!"
}

if [[ ! -x "$ENV_DIR/bin/vllm" ]]; then
  echo "Missing $ENV_DIR/bin/vllm. Run: bash scripts/setup-vlm-conda.sh" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE")"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "VLM service is already running with PID $old_pid"
    exit 0
  fi
fi

llm_url="$(read_env VLM_BASE_URL "$(read_env LLM_BASE_URL "http://127.0.0.1:8000/v1")")"
host="$(read_env VLLM_HOST "$(url_part "$llm_url" host "127.0.0.1")")"
port="$(read_env VLLM_PORT "$(url_part "$llm_url" port "8000")")"
model="$(read_env VLM_MODEL "$(read_env LLM_MODEL "Qwen/Qwen3.5-4B")")"
fallback_model="$(read_env VLM_FALLBACK_MODEL "Qwen/Qwen3-VL-4B-Instruct")"
gpu="$(read_env VLM_GPU "$(read_env LLM_GPU "2")")"
served_model_name="$(read_env VLM_SERVED_MODEL_NAME "$(read_env VLLM_SERVED_MODEL_NAME "$model")")"
dtype="$(read_env VLM_DTYPE "$(read_env VLLM_DTYPE "")")"
max_model_len="$(read_env VLM_MAX_MODEL_LEN "$(read_env VLLM_MAX_MODEL_LEN "32768")")"
gpu_memory_utilization="$(read_env VLM_GPU_MEMORY_UTILIZATION "$(read_env VLLM_GPU_MEMORY_UTILIZATION "")")"
extra_args="$(read_env VLM_EXTRA_ARGS "$(read_env VLLM_EXTRA_ARGS "")")"
trust_remote_code="$(read_env VLM_TRUST_REMOTE_CODE "true")"
image_limit="$(read_env VLM_LIMIT_MM_PER_PROMPT_IMAGE "$(read_env AI_SCREEN_SHARE_MAX_IMAGES "3")")"
limit_mm_per_prompt="$(read_env VLM_LIMIT_MM_PER_PROMPT "{\"image\":$image_limit,\"video\":0}")"
auto_fallback="$(read_env VLM_AUTO_FALLBACK "true")"

mkdir -p "$(dirname "$LOG_FILE")"
cd "$ROOT_DIR"

pid="$(start_model "$model" "$host" "$port" "$served_model_name" "$gpu" "$limit_mm_per_prompt")"
sleep 15

if ! kill -0 "$pid" 2>/dev/null; then
  echo "VLM model $model exited during startup; check $LOG_FILE" >&2
  if [[ "$auto_fallback" == "true" && "$fallback_model" != "$model" ]]; then
    echo "Trying fallback VLM model: $fallback_model" >&2
    served_model_name="$fallback_model"
    pid="$(start_model "$fallback_model" "$host" "$port" "$served_model_name" "$gpu" "$limit_mm_per_prompt")"
    sleep 15
  fi
fi

if ! kill -0 "$pid" 2>/dev/null; then
  echo "VLM service failed to start; check $LOG_FILE" >&2
  exit 1
fi

echo "$pid" > "$PID_FILE"
echo "VLM service starting on http://$host:$port/v1 with PID $pid"
echo "Model: $served_model_name"
echo "GPU: $gpu"
echo "Log: $LOG_FILE"
