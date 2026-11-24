# Meeting-bot deployment quick start

Portable steps to run the ECHO-AI meeting assistant on a GPU host. Commands assume the working directory is the `meeting-bot/` checkout.

Runtime settings come from `.env` (start from `.env.example`). Prefer editing `.env` over one-off `export` overrides unless you intentionally need a single-process override.

## 1. Feature flags

Core live-meeting assistant:

```env
RTMS_ENABLED=true
AI_ENABLED=true
ASR_ENABLED=true
VOICE_INVOCATION_ENABLED=true

# Voice endpointing uses audio energy; RTMS may keep sending silent packets.
ASR_SPEECH_RMS_THRESHOLD=200
ASR_SPEECH_PREROLL_MS=250
ASR_IDLE_FLUSH_MS=900

# Keep short live-meeting answers out of long reasoning modes.
VLM_ENABLE_THINKING=false
ANSWER_LLM_ENABLE_THINKING=false
```

Optional post-meeting features (off by default):

```env
CASE_WORKSPACE_ENABLED=false
CASE_OUTPUT_ENABLED=false
RETRIEVAL_ENABLED=false
```

To enable retrieval and case outputs:

```env
CASE_WORKSPACE_ENABLED=true
CASE_OUTPUT_ENABLED=true
RETRIEVAL_ENABLED=true
HISTORICAL_CASE_RETRIEVAL_ENABLED=true
PUBMED_RETRIEVAL_ENABLED=true
PUBMED_EMAIL=your-contact@example.com
```

Typical multi-GPU layout (adjust device IDs in `.env` to match the host):

```text
GPU A: faster-whisper ASR
GPU B: vision–language model (Qwen2.5-VL or configured VLM)
GPU C: answer formatter (Qwen3-4B-Instruct-2507)
GPU D: optional BGE-M3 embedding (needed only for historical-case retrieval)
```

PubMed-only retrieval does not require the embedding service.

## 2. Build

After pulling or editing TypeScript sources:

```bash
npm install
npm run build
```

If the checkout vendors Node under `.conda-node/bin`, prepend that directory to `PATH`. `npm start` runs `node dist/server.js` and does not recompile `src/`.

## 3. Preflight

Confirm interpreters, GPUs, and free ports for the services you enable (commonly 3000 for the bot; 7001 ASR; 8000 VLM; 8001 answer LLM; 8002 embedding; 3001 case workspace):

```bash
nvidia-smi
for port in 3000 3001 7001 8000 8001 8002; do
  ss -ltn | grep -q ":$port " && echo "port $port is already in use"
done
npm test   # optional
```

## 4. Start local AI services

```bash
bash scripts/start-ai-services.sh
```

The script starts ASR, VLM, and the answer LLM in parallel; starts BGE-M3 only when both `RETRIEVAL_ENABLED` and `HISTORICAL_CASE_RETRIEVAL_ENABLED` are true; waits for health checks; and rolls back services it started if startup fails. Useful flags: `--dry-run`, `--with-embedding`, `--without-embedding`, `--no-wait`. Default readiness timeout is 300 seconds (`AI_SERVICES_START_TIMEOUT_SECONDS` overrides).

## 5. Warm-up

Cold first requests are substantially slower. Warm ASR, VLM, and the answer formatter before joining a meeting (example endpoints; change ports/model IDs to match `.env`):

```bash
# ASR: POST 1s of silence to http://127.0.0.1:7001/transcribe
# VLM / answer LLM: small chat.completions calls to :8000 and :8001
```

On a representative lab host after warm-up, complete AI calls were about 4 seconds versus about 16 seconds cold.

## 6. HTTPS tunnel for Zoom

```bash
bash scripts/start-ngrok.sh
cat .ngrok-url
```

Register the webhook and OAuth callback URLs in the Zoom Marketplace:

```bash
echo "$(cat .ngrok-url)/zoom/webhooks"
echo "$(cat .ngrok-url)/oauth/callback"
```

Subscribe the RTMS app to `meeting.rtms_started`, `meeting.rtms_stopped`, and `meeting.rtms_interrupted`. Update `ZOOM_OAUTH_REDIRECT_URL` if the tunnel URL changes.

## 7. Start the Node backend

Playwright Chromium may need the Node lib directory on `LD_LIBRARY_PATH` when using a conda-packaged runtime:

```bash
LD_LIBRARY_PATH=${PWD}/.conda-node/lib:${LD_LIBRARY_PATH:-} \
PATH=${PWD}/.conda-node/bin:$PATH \
BROWSER_HEADLESS=true \
BROWSER_CHANNEL=chromium \
npm start
```

With `AUTO_JOIN=true`, the bot joins the configured meeting after startup. To join manually, start with `AUTO_JOIN=false` and then:

```bash
curl -X POST http://127.0.0.1:3000/join
```

## 8. Health checks

```bash
curl -fsS http://127.0.0.1:7001/health
curl -fsS http://127.0.0.1:8000/v1/models
curl -fsS http://127.0.0.1:8001/v1/models
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/ai/health
curl -fsS http://127.0.0.1:3000/rtms/health
```

Optional: embedding `:8002`, case workspace `:3001`. If `/ai/health` reports a false component, inspect the corresponding `asr.log`, `vlm.log`, `answer-llm.log`, `embedding.log`, or `ngrok.log`.

## 9. Local ask without Zoom chat

```bash
curl -fsS -X POST http://127.0.0.1:3000/ai/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Reply exactly: ECHO pipeline OK","streamId":"local-test"}'
```

## 10. In-meeting use

- Chat: `@ECHO AI Assistant What is the main recommendation?`
- Voice: `Hello ECHO AI, what is this slide about?`

Wake detection tolerates common ASR variants while requiring a wake phrase at the start of the utterance. PubMed retrieval triggers on literature-oriented terms (`PubMed`, `guideline`, `systematic review`, …). Cited PMIDs are restricted to the retrieval record before delivery.

```bash
curl -N http://127.0.0.1:3000/events
curl 'http://127.0.0.1:3000/ai/screens?limit=10'
curl 'http://127.0.0.1:3000/ai/memory'
```

## 11. Optional post-meeting APIs

Requires `CASE_WORKSPACE_ENABLED=true` (port 3001 by default): list cases, backfill from an RTMS stream id, fetch outputs, and request retrievals. See the case-workspace routes in `src/` for the exact JSON schemas.

## Stop

```bash
curl -X POST http://127.0.0.1:3000/leave   # optional
# Ctrl+C the Node process, then:
bash scripts/stop-ai-services.sh
bash scripts/stop-ngrok.sh
```

Confirm ports and GPUs are released with `ss` / `nvidia-smi`.
