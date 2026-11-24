#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_TIMEOUT_SECONDS="${AI_SERVICES_START_TIMEOUT_SECONDS:-300}"
POLL_SECONDS="${AI_SERVICES_POLL_SECONDS:-2}"
EMBEDDING_MODE="auto"
WAIT_FOR_READY=true
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: bash scripts/start-ai-services.sh [options]

Starts the ECHO background AI services and waits until they are ready.

Options:
  --with-embedding     Start embedding even when historical retrieval is disabled.
  --without-embedding  Do not start embedding.
  --no-wait            Return after the individual start scripts finish.
  --dry-run            Print the selected services without starting them.
  -h, --help           Show this help.

By default, embedding starts only when both RETRIEVAL_ENABLED=true and
HISTORICAL_CASE_RETRIEVAL_ENABLED=true. ASR and the answer LLM follow their
corresponding feature flags; the VLM starts whenever AI_ENABLED=true.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-embedding)
      EMBEDDING_MODE="force"
      ;;
    --without-embedding)
      EMBEDDING_MODE="skip"
      ;;
    --no-wait)
      WAIT_FOR_READY=false
      ;;
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

read_env() {
  local name="$1"
  local fallback="${2:-}"

  if [[ -n "${!name:-}" ]]; then
    printf '%s\n' "${!name}"
    return
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
      return
    fi
  fi

  printf '%s\n' "$fallback"
}

is_true() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

pid_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

models_url() {
  printf '%s/models\n' "${1%/}"
}

declare -a LABELS=()
declare -a START_SCRIPTS=()
declare -a STOP_SCRIPTS=()
declare -a PID_FILES=()
declare -a READY_URLS=()
declare -a LOG_FILES=()
declare -a STARTED_BEFORE=()
declare -a JOB_PIDS=()

add_service() {
  LABELS+=("$1")
  START_SCRIPTS+=("$2")
  STOP_SCRIPTS+=("$3")
  PID_FILES+=("$4")
  READY_URLS+=("$5")
  LOG_FILES+=("$6")
}

ai_enabled="$(read_env AI_ENABLED "false")"
asr_enabled="$(read_env ASR_ENABLED "false")"
answer_enabled="$(read_env ANSWER_LLM_ENABLED "true")"
retrieval_enabled="$(read_env RETRIEVAL_ENABLED "false")"
historical_enabled="$(read_env HISTORICAL_CASE_RETRIEVAL_ENABLED "true")"

asr_url="${ASR_SERVICE_URL:-$(read_env ASR_SERVICE_URL "http://127.0.0.1:7001")}"
vlm_base_url="$(
  read_env VLM_BASE_URL "$(read_env LLM_BASE_URL "http://127.0.0.1:8000/v1")"
)"
answer_base_url="$(read_env ANSWER_LLM_BASE_URL "http://127.0.0.1:8001/v1")"
embedding_base_url="$(read_env EMBEDDING_BASE_URL "http://127.0.0.1:8002/v1")"

if is_true "$ai_enabled" && is_true "$asr_enabled"; then
  add_service \
    "ASR" \
    "$ROOT_DIR/scripts/start-asr.sh" \
    "$ROOT_DIR/scripts/stop-asr.sh" \
    "$ROOT_DIR/.asr.pid" \
    "${asr_url%/}/health" \
    "$ROOT_DIR/asr.log"
else
  echo "Skipping ASR (requires AI_ENABLED=true and ASR_ENABLED=true)"
fi

if is_true "$ai_enabled"; then
  add_service \
    "VLM" \
    "$ROOT_DIR/scripts/start-vlm.sh" \
    "$ROOT_DIR/scripts/stop-vlm.sh" \
    "$ROOT_DIR/.vlm.pid" \
    "$(models_url "$vlm_base_url")" \
    "$ROOT_DIR/vlm.log"
else
  echo "Skipping VLM (AI_ENABLED=false)"
fi

if is_true "$ai_enabled" && is_true "$answer_enabled"; then
  add_service \
    "Answer LLM" \
    "$ROOT_DIR/scripts/start-answer-llm.sh" \
    "$ROOT_DIR/scripts/stop-answer-llm.sh" \
    "$ROOT_DIR/.answer-llm.pid" \
    "$(models_url "$answer_base_url")" \
    "$ROOT_DIR/answer-llm.log"
else
  echo "Skipping Answer LLM (requires AI_ENABLED=true and ANSWER_LLM_ENABLED=true)"
fi

start_embedding=false
case "$EMBEDDING_MODE" in
  force)
    start_embedding=true
    ;;
  skip)
    start_embedding=false
    ;;
  auto)
    if is_true "$retrieval_enabled" && is_true "$historical_enabled"; then
      start_embedding=true
    fi
    ;;
esac

if [[ "$start_embedding" == true ]]; then
  add_service \
    "Embedding" \
    "$ROOT_DIR/scripts/start-embedding.sh" \
    "$ROOT_DIR/scripts/stop-embedding.sh" \
    "$ROOT_DIR/.embedding.pid" \
    "$(models_url "$embedding_base_url")" \
    "$ROOT_DIR/embedding.log"
else
  echo "Skipping Embedding (historical retrieval is disabled; use --with-embedding to force)"
fi

if [[ ${#LABELS[@]} -eq 0 ]]; then
  echo "No AI services are enabled in .env"
  exit 0
fi

echo
echo "Selected AI services:"
for index in "${!LABELS[@]}"; do
  printf '  - %s (%s)\n' "${LABELS[$index]}" "${READY_URLS[$index]}"
done

if [[ "$DRY_RUN" == true ]]; then
  exit 0
fi

rollback_new_services() {
  echo
  echo "Stopping services started by this command..."
  local index
  for ((index=${#LABELS[@]} - 1; index >= 0; index--)); do
    if [[ "${STARTED_BEFORE[$index]:-false}" == false ]]; then
      bash "${STOP_SCRIPTS[$index]}" || true
    fi
  done
}

interrupted=false
on_interrupt() {
  interrupted=true
  rollback_new_services
  exit 130
}
trap on_interrupt INT TERM

echo
echo "Starting services in parallel..."
for index in "${!LABELS[@]}"; do
  if pid_running "${PID_FILES[$index]}"; then
    STARTED_BEFORE[$index]=true
  else
    STARTED_BEFORE[$index]=false
  fi
  bash "${START_SCRIPTS[$index]}" &
  JOB_PIDS[$index]=$!
done

launch_failed=false
for index in "${!LABELS[@]}"; do
  if wait "${JOB_PIDS[$index]}"; then
    :
  else
    echo "${LABELS[$index]} start script failed; inspect ${LOG_FILES[$index]}" >&2
    launch_failed=true
  fi
done

if [[ "$launch_failed" == true ]]; then
  rollback_new_services
  exit 1
fi

if [[ "$WAIT_FOR_READY" == false ]]; then
  echo
  echo "Start scripts completed. Readiness checks were skipped."
  exit 0
fi

wait_for_service() {
  local label="$1"
  local url="$2"
  local pid_file="$3"
  local log_file="$4"
  local deadline=$((SECONDS + START_TIMEOUT_SECONDS))

  printf 'Waiting for %s' "$label"
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 3 -o /dev/null "$url" 2>/dev/null; then
      echo " ready"
      return 0
    fi
    if [[ -f "$pid_file" ]] && ! pid_running "$pid_file"; then
      echo " failed"
      echo "$label exited before becoming ready; inspect $log_file" >&2
      return 1
    fi
    printf '.'
    sleep "$POLL_SECONDS"
  done

  echo " timed out"
  echo "$label was not ready after ${START_TIMEOUT_SECONDS}s; inspect $log_file" >&2
  return 1
}

echo
ready_failed=false
for index in "${!LABELS[@]}"; do
  if ! wait_for_service \
    "${LABELS[$index]}" \
    "${READY_URLS[$index]}" \
    "${PID_FILES[$index]}" \
    "${LOG_FILES[$index]}"; then
    ready_failed=true
  fi
done

if [[ "$ready_failed" == true ]]; then
  echo
  for index in "${!LABELS[@]}"; do
    echo "Last lines from ${LOG_FILES[$index]}:"
    tail -n 20 "${LOG_FILES[$index]}" 2>/dev/null || true
  done
  rollback_new_services
  exit 1
fi

trap - INT TERM
echo
echo "All selected AI services are ready."

