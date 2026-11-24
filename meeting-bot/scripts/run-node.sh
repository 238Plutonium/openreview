#!/usr/bin/env bash
set -euo pipefail
# Shared checkout: the tree is group-writable by e5-cse-nlp, but a default
# umask of 022 makes every file this process writes unwritable to the group.
umask 002
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$ROOT/.conda-node/bin:$PATH"
cd "$ROOT"
# dotenv does not override existing process env. Drop stale shell exports so
# .env (timeouts, topK, paths) is authoritative after restarts.
unset RETRIEVAL_SOURCE_TIMEOUT_MS RETRIEVAL_TOTAL_TIMEOUT_MS \
  PRIVATE_RAG_EMBEDDING_K PRIVATE_RAG_DB_DIR PRIVATE_RAG_BM25_K \
  PRIVATE_RAG_ALWAYS_ON HISTORICAL_CASE_RETRIEVAL_ENABLED \
  AI_SCREEN_SHARE_MAX_IMAGES \
  VOICE_INVOCATION_ENABLED MEETING_MINUTES_ENABLED CHAT_QA_ENABLED BOT_NAME \
  ZOOM_MEETING_NUMBER ZOOM_MEETING_PASSWORD LINUX_CHAT_URL
# Single web bot mode (Linux nested-reply bot on :3020 is not running):
# - voice + @chat Q&A answered by this process
# - replies post via Zoom web chat (not LINUX_CHAT_URL)
export AUTO_JOIN=false
export BROWSER_HEADLESS=true
export PRIVATE_RAG_ALWAYS_ON=true
export CHAT_QA_ENABLED=true
export VOICE_INVOCATION_ENABLED=true
export BOT_NAME="ECHO AI Assistant"
# Empty so sendBotChat uses webBot.sendChat instead of dead :3020
export LINUX_CHAT_URL=""
exec node dist/server.js
