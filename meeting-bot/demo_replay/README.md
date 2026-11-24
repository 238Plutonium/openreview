# Synthetic media replay (reviewer path)

Runs the same ask pipeline on **recorded deskshare frames + transcript text** without a live Zoom RTMS webhook.

## One command

```bash
# In meeting-bot (meeting package), with GPU AI services already up:
#   1) DEMO_REPLAY_ENABLED=true in .env
#   2) npm start   (or restart after flipping the flag)
npm run demo:replay
```

Dry-run (fixtures + endpoint presence only, no LLM calls):

```bash
npm run demo:replay -- --dry-run
```

## What it does

1. `POST /demo/replay/reset` — new/clear stream id  
2. `POST /demo/replay/frame` — inject `fixtures/slide.jpg`  
3. `POST /demo/replay/transcript` — inject synthetic facilitator turns  
4. `POST /demo/replay/ask` — slide / speech / literature questions (meeting-like; private index allowed)

## Requirements

- Node server on `ECHO_BASE_URL` (default `http://127.0.0.1:3000`)
- `DEMO_REPLAY_ENABLED=true`
- For real answers (not dry-run): Whisper/VLM/answer LLM (and PubMed path for literature) as in a normal lab deploy

Always-on artifacts that need **no** lab machine: YouTube screencast + MediaSpace recording linked in the paper.
