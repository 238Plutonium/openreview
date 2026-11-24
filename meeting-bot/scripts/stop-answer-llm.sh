#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.answer-llm.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "Answer LLM service is not running; $PID_FILE does not exist"
  exit 0
fi

pid="$(cat "$PID_FILE")"
if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Answer LLM service is not running"
  exit 0
fi

kill "$pid"
for _ in {1..40}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Answer LLM service stopped"
    exit 0
  fi
  sleep 0.5
done

echo "Answer LLM service PID $pid did not exit yet; check answer-llm.log"
