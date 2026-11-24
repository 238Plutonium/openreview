# ECHO AI Assistant Server Quick Start

All commands below assume:

```bash
cd /scratch1/ECHO_project
```

Runtime settings are read from `.env`. Do not repeat model/GPU settings with
temporary `export` commands unless you intentionally want to override `.env`
for one process.

## 1. Choose the features in `.env`

The core live-meeting assistant requires:

```env
RTMS_ENABLED=true
AI_ENABLED=true
ASR_ENABLED=true
VOICE_INVOCATION_ENABLED=true

# Voice endpointing uses audio energy because RTMS continues sending silent
# audio packets. The idle timer is extended only by packets above this RMS.
ASR_SPEECH_RMS_THRESHOLD=200
ASR_SPEECH_PREROLL_MS=250
ASR_IDLE_FLUSH_MS=900

# Keep short live-meeting answers out of Qwen's long reasoning mode.
VLM_ENABLE_THINKING=false
ANSWER_LLM_ENABLE_THINKING=false
```

Optional post-meeting features are disabled by default:

```env
# Immutable post-meeting case workspace and localhost API on port 3001.
CASE_WORKSPACE_ENABLED=false

# JSON, HTML, and PDF reports. Requires CASE_WORKSPACE_ENABLED=true.
CASE_OUTPUT_ENABLED=false

# Historical-case and PubMed retrieval.
RETRIEVAL_ENABLED=false
```

To use all new features:

```env
CASE_WORKSPACE_ENABLED=true
CASE_OUTPUT_ENABLED=true
RETRIEVAL_ENABLED=true
HISTORICAL_CASE_RETRIEVAL_ENABLED=true
PUBMED_RETRIEVAL_ENABLED=true
PUBMED_EMAIL=bbz5169@psu.edu
```

GPU allocation currently configured in `.env`:

```text
GPU 1: faster-whisper ASR
GPU 2: Qwen/Qwen3.5-4B VLM
GPU 3: Qwen/Qwen3-4B-Instruct-2507 answer formatter and rolling summary
GPU 4: optional BGE-M3 embedding
```

Embedding is only required for historical-case retrieval. PubMed-only
retrieval does not require the embedding service.

## 2. Build the Node application

Run this after pulling or modifying source code and before `npm start`:

```bash
PATH=$PWD/.conda-node/bin:$PATH npm run build
```

`npm start` runs `node dist/server.js`; it does not compile `src/`
automatically. If `npm run build` has already succeeded and the source code has
not changed, you do not need to rebuild.

## 3. Preflight

Check that required environments, GPUs, and ports are available:

```bash
test -x .conda-node/bin/node
test -x .conda-ai/bin/python
test -x .conda-ngrok/bin/python
test -x .conda-ai/bin/vllm || test -x .conda-ai/bin/python

nvidia-smi

for port in 3000 3001 7001 8000 8001 8002; do
  ss -ltn | grep -q ":$port " && echo "port $port is already in use"
done
```

Optionally run the automated tests before a meeting:

```bash
PATH=$PWD/.conda-node/bin:$PATH npm test
```

## 4. Start local AI services

Start all services selected by `.env` with one command:

```bash
bash scripts/start-ai-services.sh
```

The unified script:

- starts ASR, VLM, and Answer LLM in parallel;
- starts BGE-M3 automatically only when both `RETRIEVAL_ENABLED=true` and
  `HISTORICAL_CASE_RETRIEVAL_ENABLED=true`;
- waits for every selected service to pass its health check;
- rolls back services newly started by the command if startup fails;
- safely succeeds when a selected service is already running.

With the current PubMed-only configuration, embedding is intentionally
skipped. To start all four services regardless of feature configuration:

```bash
bash scripts/start-ai-services.sh --with-embedding
```

Useful options:

```bash
# Show what the current configuration would start.
bash scripts/start-ai-services.sh --dry-run

# Explicitly skip embedding.
bash scripts/start-ai-services.sh --without-embedding

# Launch processes without waiting for readiness.
bash scripts/start-ai-services.sh --no-wait
```

The default readiness timeout is 300 seconds. Override it for one run with
`AI_SERVICES_START_TIMEOUT_SECONDS=600`. VLM startup can take roughly 30–60
seconds.

## 5. Warm up ASR and both language models

The first cold request is substantially slower. Run warm-up before the bot
joins a meeting.

Warm ASR with one second of silence:

```bash
PATH=$PWD/.conda-node/bin:$PATH node --input-type=module <<'JS'
const audioBase64 = Buffer.alloc(16000 * 2).toString("base64");
const response = await fetch("http://127.0.0.1:7001/transcribe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    audioBase64,
    sampleRate: 16000,
    channels: 1,
    sampleWidthBytes: 2,
    durationSeconds: 1
  })
});
if (!response.ok) throw new Error(await response.text());
console.log(await response.text());
JS
```

Warm the VLM:

```bash
curl -fsS http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"Qwen/Qwen3.5-4B",
    "messages":[{"role":"user","content":"Reply exactly: warmup complete"}],
    "temperature":0,
    "max_tokens":16
  }'
```

Warm the answer formatter:

```bash
curl -fsS http://127.0.0.1:8001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"Qwen/Qwen3-4B-Instruct-2507",
    "messages":[{"role":"user","content":"Reply exactly: warmup complete"}],
    "temperature":0,
    "max_tokens":16
  }'
```

Measured on this server:

```text
ASR first request:       about 5.8 seconds
ASR warmed request:      about 0.2 seconds
First complete AI call:  about 16 seconds
Warmed complete AI call: about 3.9 seconds
```

## 6. Start ngrok and verify the Zoom app URLs

```bash
bash scripts/start-ngrok.sh
cat .ngrok-url
```

For a random/free ngrok domain, the URL may change after restart. Confirm these
values in the Zoom Marketplace before starting the meeting:

```bash
echo "$(cat .ngrok-url)/zoom/webhooks"
echo "$(cat .ngrok-url)/oauth/callback"
```

- The RTMS app webhook URL must use the first URL.
- The OAuth Redirect URL must use the second URL.
- If the OAuth URL changed, update `ZOOM_OAUTH_REDIRECT_URL` in `.env` too.
- The RTMS app must subscribe to `meeting.rtms_started`,
  `meeting.rtms_stopped`, and `meeting.rtms_interrupted`.

## 7. Start the Node backend

The `LD_LIBRARY_PATH` entry is required by Playwright Chromium on this server
and is also needed for structured PDF output.

Do not start Node until the enabled AI services have passed their readiness
checks and warm-up. With `AUTO_JOIN=true`, starting Node can immediately begin
joining the configured Zoom meeting.

```bash
LD_LIBRARY_PATH=$PWD/.conda-node/lib:${LD_LIBRARY_PATH:-} \
PATH=$PWD/.conda-node/bin:$PATH \
BROWSER_HEADLESS=true \
BROWSER_CHANNEL=chromium \
npm start
```

`AUTO_JOIN=true` in `.env` makes the bot join shortly after Node starts. Because
the AI services are already warmed, the first participant request will not pay
the cold-start penalty.

To start without joining automatically:

```bash
LD_LIBRARY_PATH=$PWD/.conda-node/lib:${LD_LIBRARY_PATH:-} \
PATH=$PWD/.conda-node/bin:$PATH \
AUTO_JOIN=false \
BROWSER_HEADLESS=true \
BROWSER_CHANNEL=chromium \
npm start
```

Then join manually:

```bash
curl -X POST http://127.0.0.1:3000/join
```

## 8. Health checks

Core services:

```bash
curl -fsS http://127.0.0.1:7001/health
curl -fsS http://127.0.0.1:8000/v1/models
curl -fsS http://127.0.0.1:8001/v1/models
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/ai/health
curl -fsS http://127.0.0.1:3000/rtms/health
```

Optional services:

```bash
# Historical retrieval
curl -fsS http://127.0.0.1:8002/v1/models

# Case workspace, retrieval API, and structured-output health
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:3001/retrieval/health
```

The main `/ai/health` response should show `ok: true` for ASR, VLM, and Answer
LLM. If one is false, inspect:

```bash
tail -n 100 asr.log
tail -n 100 vlm.log
tail -n 100 answer-llm.log
tail -n 100 embedding.log
tail -n 100 ngrok.log
```

## 9. Local test without Zoom chat

```bash
curl -fsS -X POST http://127.0.0.1:3000/ai/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"Reply exactly: ECHO pipeline OK","streamId":"local-test"}'
```

Expected answer:

```text
ECHO pipeline OK
```

## 10. Use in a meeting

Chat invocation:

```text
@ECHO AI Assistant What is the main recommendation?
```

Voice invocation:

```text
Hello ECHO AI, what is this slide about?
```

The wake phrase can be followed by the question in the same utterance, or the
same participant can ask the question within 12 seconds. Voice answers are sent
publicly to the Zoom meeting chat. Wake detection tolerates common ASR variants
such as `Hi Echo Assistant`, `Hi, I'm Echo AI Assistant`, `Hi Echo`, and
`Hello Iko`, while still requiring the wake phrase at the beginning.

PubMed retrieval is triggered by terms such as `literature`, `evidence`,
`research`, `PubMed`, `medpub`, `papers`, `articles`, `guideline`, and
`systematic review`. Literature answers use only PMIDs returned by the immutable
retrieval record; invented Case/PMID citations are removed before Zoom delivery.

Inspect events and captured context:

```bash
curl -N http://127.0.0.1:3000/events
curl 'http://127.0.0.1:3000/ai/screens?limit=10'
curl 'http://127.0.0.1:3000/ai/memory'
```

## 11. Optional post-meeting APIs

These endpoints require `CASE_WORKSPACE_ENABLED=true`.

```bash
curl http://127.0.0.1:3001/cases

curl -X POST http://127.0.0.1:3001/cases/backfill \
  -H 'Content-Type: application/json' \
  -d '{"streamId":"<rtms-stream-id>"}'

curl http://127.0.0.1:3001/cases/<caseId>/outputs

curl -X POST http://127.0.0.1:3001/cases/<caseId>/retrievals \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## Stop

If Node is running in the foreground, press `Ctrl+C` in its terminal. You can
also make the bot leave before shutdown:

```bash
curl -X POST http://127.0.0.1:3000/leave
```

Stop all local services:

```bash
bash scripts/stop-ai-services.sh
bash scripts/stop-ngrok.sh
```

The unified stop script always checks all four AI services, including
embedding, so processes are not left behind after `.env` feature changes.

Verify that ports and GPUs were released:

```bash
for port in 3000 3001 7001 8000 8001 8002; do
  ss -ltn | grep -q ":$port " && echo "port $port is still in use"
done

nvidia-smi
```
