#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.ngrok.pid"
URL_FILE="$ROOT_DIR/.ngrok-url"

if [[ ! -f "$PID_FILE" ]]; then
  echo "ngrok is not running"
  rm -f "$URL_FILE"
  exit 0
fi

pid="$(tr -d '[:space:]' < "$PID_FILE")"
if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
  kill "$pid"
  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

rm -f "$PID_FILE" "$URL_FILE"
echo "ngrok stopped"
