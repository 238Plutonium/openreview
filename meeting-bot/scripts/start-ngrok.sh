#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$ROOT_DIR/.conda-ngrok/bin/python"
PID_FILE="$ROOT_DIR/.ngrok.pid"
URL_FILE="$ROOT_DIR/.ngrok-url"
LOG_FILE="$ROOT_DIR/ngrok.log"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Missing $PYTHON_BIN. Run: bash scripts/setup-ngrok-conda.sh" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
    echo "ngrok is already running with PID $existing_pid"
    if [[ -f "$URL_FILE" ]]; then
      echo "URL: $(tr -d '[:space:]' < "$URL_FILE")"
    fi
    exit 0
  fi
fi

rm -f "$URL_FILE"
if command -v setsid >/dev/null 2>&1; then
  nohup setsid "$PYTHON_BIN" "$ROOT_DIR/scripts/ngrok_service.py" > "$LOG_FILE" 2>&1 < /dev/null &
else
  nohup "$PYTHON_BIN" "$ROOT_DIR/scripts/ngrok_service.py" > "$LOG_FILE" 2>&1 < /dev/null &
fi
echo "$!" > "$PID_FILE"

for _ in $(seq 1 30); do
  if [[ -s "$URL_FILE" ]]; then
    public_url="$(tr -d '[:space:]' < "$URL_FILE")"
    webhook_path="${RTMS_WEBHOOK_PATH:-}"
    if [[ -z "$webhook_path" && -f "$ROOT_DIR/.env" ]]; then
      webhook_path="$(
        awk -F= '/^RTMS_WEBHOOK_PATH=/ { print $2; exit }' "$ROOT_DIR/.env" |
          tr -d '[:space:]'
      )"
    fi
    webhook_path="${webhook_path:-/zoom/webhooks}"
    [[ "$webhook_path" == /* ]] || webhook_path="/$webhook_path"
    echo "ngrok tunnel started: $public_url"
    echo "Zoom webhook URL: ${public_url}${webhook_path}"
    echo "Logs: $LOG_FILE"
    exit 0
  fi
  sleep 1
done

echo "ngrok did not report a URL within 30 seconds. Check $LOG_FILE" >&2
exit 1
