#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export HF_HOME=/scratch1/qxl5189/hf-cache
export HUGGINGFACE_HUB_CACHE=/scratch1/qxl5189/hf-cache/hub
export TRANSFORMERS_CACHE=/scratch1/qxl5189/hf-cache/hub
export CUDA_VISIBLE_DEVICES="${VLM_GPU:-4}"
export PATH="$ROOT/.conda-ai/bin:$PATH"
LOG="$ROOT/vlm-qwen25vl.log"
PID_FILE="$ROOT/.vlm25.pid"
MAX_MODEL_LEN="${VLM_MAX_MODEL_LEN:-16384}"
GPU_MEMORY_UTILIZATION="${VLM_GPU_MEMORY_UTILIZATION:-0.70}"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running PID $(cat "$PID_FILE")"
  exit 0
fi

cd "$ROOT"
nohup "$ROOT/.conda-ai/bin/vllm" serve Qwen/Qwen2.5-VL-3B-Instruct \
  --host 127.0.0.1 \
  --port 8010 \
  --served-model-name Qwen/Qwen2.5-VL-3B-Instruct \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  --trust-remote-code \
  --enforce-eager \
  --limit-mm-per-prompt '{"image":3,"video":0}' \
  >>"$LOG" 2>&1 &
echo $! >"$PID_FILE"
echo "Started PID $(cat "$PID_FILE") log=$LOG"
