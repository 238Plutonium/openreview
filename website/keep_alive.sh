#!/usr/bin/env bash
# Keep ECHO public website + ngrok up. Does not restart GPU/vLLM (heavy).
set -u
WEB_DIR="/home/ugrads/qxl5189/echo-ai-website"
BOT_DIR="/home/ugrads/qxl5189/echo_merge_nested"
LOG="$WEB_DIR/keep_alive.log"
DOMAIN="chive-shrouded-gag.ngrok-free.dev"
PORT=8080

log() { echo "[$(date '+%F %T')] $*" >>"$LOG"; }

ensure_website() {
  if curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/status" | grep -q 200; then
    return 0
  fi
  log "website down — restarting"
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
  sleep 0.5
  cd "$WEB_DIR" || return 1
  nohup env PORT="$PORT" ECHO_API_BASE=http://127.0.0.1:3000 python3 -u server.py >>website.log 2>&1 </dev/null &
  echo $! >"$WEB_DIR/.website.pid"
  sleep 1.5
  if curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/status" | grep -q 200; then
    log "website back (pid $(cat "$WEB_DIR/.website.pid"))"
  else
    log "website restart FAILED"
  fi
}

ensure_ngrok() {
  local code
  code=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" || echo 000)
  if [[ "$code" == "200" ]]; then
    return 0
  fi
  log "ngrok/public down (http $code) — restarting tunnel"
  pkill -x ngrok >/dev/null 2>&1 || true
  sleep 1
  # shellcheck disable=SC1091
  set -a
  # token only from bot .env
  # shellcheck disable=SC1090
  source <(grep -E '^NGROK_AUTHTOKEN=' "$BOT_DIR/.env")
  set +a
  cd "$BOT_DIR" || return 1
  nohup /usr/local/bin/ngrok http "$PORT" --url="https://${DOMAIN}" --log=stdout >>ngrok.log 2>&1 </dev/null &
  echo $! >"$BOT_DIR/.ngrok.pid"
  sleep 4
  code=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" || echo 000)
  log "ngrok restart result http=$code pid=$(cat "$BOT_DIR/.ngrok.pid" 2>/dev/null)"
}

log "keep_alive started pid=$$"
while true; do
  ensure_website
  ensure_ngrok
  # bot health note only
  if ! curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/health" | grep -q 200; then
    log "WARN bot :3000 not healthy (not auto-restarted)"
  fi
  sleep 60
done
