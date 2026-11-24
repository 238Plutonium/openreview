#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: bash scripts/stop-ai-services.sh [--dry-run]

Stops all ECHO AI background services in reverse startup order:
embedding, answer LLM, VLM, and ASR. Disabled services are included so a
previously started process is not left behind after configuration changes.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

declare -a LABELS=("Embedding" "Answer LLM" "VLM" "ASR")
declare -a STOP_SCRIPTS=(
  "$ROOT_DIR/scripts/stop-embedding.sh"
  "$ROOT_DIR/scripts/stop-answer-llm.sh"
  "$ROOT_DIR/scripts/stop-vlm.sh"
  "$ROOT_DIR/scripts/stop-asr.sh"
)
declare -a PID_FILES=(
  "$ROOT_DIR/.embedding.pid"
  "$ROOT_DIR/.answer-llm.pid"
  "$ROOT_DIR/.vlm.pid"
  "$ROOT_DIR/.asr.pid"
)

if [[ "$DRY_RUN" == true ]]; then
  echo "AI services that would be stopped:"
  printf '  - %s\n' "${LABELS[@]}"
  exit 0
fi

status=0
for index in "${!LABELS[@]}"; do
  echo
  echo "Stopping ${LABELS[$index]}..."
  if ! bash "${STOP_SCRIPTS[$index]}"; then
    status=1
  fi

  pid_file="${PID_FILES[$index]}"
  if [[ -f "$pid_file" ]]; then
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "${LABELS[$index]} PID $pid is still running" >&2
      status=1
    fi
  fi
done

echo
if [[ "$status" -eq 0 ]]; then
  echo "All AI background services are stopped."
else
  echo "One or more AI services did not stop cleanly; inspect the messages above." >&2
fi
exit "$status"

