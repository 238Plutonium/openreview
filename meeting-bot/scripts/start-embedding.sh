#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_FILE="$ROOT_DIR/embedding.log"

read_env() {
  local name="$1"
  local fallback="${2:-}"
  if [[ -n "${!name:-}" ]]; then
    printf '%s\n' "${!name}"
    return
  fi
  if [[ -f "$ROOT_DIR/.env" ]]; then
    local value
    value="$(awk -v key="$name" '
      BEGIN { FS = "=" }
      $1 == key {
        sub(/^[^=]*=/, "")
        gsub(/^[ \t]+|[ \t]+$/, "")
        gsub(/^"|"$/, "")
        gsub(/^'\''|'\''$/, "")
        print
        exit
      }
    ' "$ROOT_DIR/.env")"
    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return
    fi
  fi
  printf '%s\n' "$fallback"
}

ENV_DIR="$(
  read_env EMBEDDING_CONDA_ENV_DIR \
    "$(read_env VLM_CONDA_ENV_DIR "/scratch1/bbz5169/conda/envs/ms-swift-grpo")"
)"

if [[ ! -x "$ENV_DIR/bin/vllm" ]]; then
  echo "Missing $ENV_DIR/bin/vllm; set EMBEDDING_CONDA_ENV_DIR to a vLLM environment." >&2
  exit 1
fi

base_url="$(read_env EMBEDDING_BASE_URL "http://127.0.0.1:8002/v1")"
host="$(printf '%s' "$base_url" | sed -E 's#https?://([^:/]+).*#\1#')"
port="$(printf '%s' "$base_url" | sed -nE 's#https?://[^:/]+:([0-9]+).*#\1#p')"
port="${port:-8002}"
PID_FILE="$ROOT_DIR/.embedding.${port}.pid"
LEGACY_PID_FILE="$ROOT_DIR/.embedding.pid"
pid_files=("$PID_FILE")
if [[ "$port" == "8002" ]]; then
  pid_files+=("$LEGACY_PID_FILE")
fi
for pid_file in "${pid_files[@]}"; do
  if [[ -f "$pid_file" ]]; then
    old_pid="$(cat "$pid_file")"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Embedding service is already running on port $port with PID $old_pid"
      exit 0
    fi
  fi
done
model="$(read_env EMBEDDING_MODEL "BAAI/bge-m3")"
gpu="$(read_env EMBEDDING_GPU "4")"
max_model_len="$(read_env EMBEDDING_MAX_MODEL_LEN "8192")"
gpu_memory_utilization="$(read_env EMBEDDING_GPU_MEMORY_UTILIZATION "0.85")"
extra_args="$(read_env EMBEDDING_EXTRA_ARGS "")"

cmd=(
  "$ENV_DIR/bin/vllm"
  serve "$model"
  --host "$host"
  --port "$port"
  --served-model-name "$model"
  --task embed
  --trust-remote-code
  --max-model-len "$max_model_len"
  --gpu-memory-utilization "$gpu_memory_utilization"
)

if [[ -n "$extra_args" ]]; then
  read -r -a parsed_extra_args <<< "$extra_args"
  cmd+=("${parsed_extra_args[@]}")
fi

cd "$ROOT_DIR"
setsid env \
  CUDA_VISIBLE_DEVICES="$gpu" \
  CUDA_HOME="$ENV_DIR" \
  PATH="$ENV_DIR/bin:$PATH" \
  LD_LIBRARY_PATH="$ENV_DIR/lib64:$ENV_DIR/lib:$ENV_DIR/targets/x86_64-linux/lib:${LD_LIBRARY_PATH:-}" \
  HF_HOME="${HF_HOME:-/scratch1/qxl5189/hf-cache}" \
  TOKENIZERS_PARALLELISM="${TOKENIZERS_PARALLELISM:-false}" \
  "${cmd[@]}" >> "$LOG_FILE" 2>&1 < /dev/null &
pid="$!"
echo "$pid" > "$PID_FILE"
if [[ "$port" == "8002" ]]; then
  echo "$pid" > "$LEGACY_PID_FILE"
fi

echo "Embedding service starting on http://$host:$port/v1 with PID $pid"
echo "Model: $model"
echo "Conda env: $ENV_DIR"
echo "GPU: $gpu"
echo "Log: $LOG_FILE"
