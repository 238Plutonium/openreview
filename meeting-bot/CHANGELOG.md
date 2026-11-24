# Changelog

All notable changes to the ECHO Zoom bot are documented in this file.

## [Unreleased] — `feat/demo-feedback-v2`

Branch tip: demo-feedback follow-ups from the 2026-09-10 ECHO AI session.  
Compare: https://github.com/238Plutonium/echo-ai-naacl-submission/compare/main...feat/demo-feedback-v2

### Added (latest)

- **Concise Zoom answers** (`ANSWER_STYLE=concise`): shorter formatter prompts + hard char caps (450 / 600 / 900) for default / clinical-RAG / literature replies
- **Post-session summaries outside chat**: generate minutes on bot leave as well as RTMS close; `GET /meeting-minutes/summary.md` downloads `summary.md`; never send summaries into Zoom chat
- Event `meeting-minutes-ready` with `downloadPath`

### Prior (`feat/vlm-multimodal-oauth-persist`)

- **Web nested replies** (Binglin): text `@ECHO` questions get a true nested Reply under the source message; voice answers stay in public Everyone chat
- Playwright thread composer: click the message **Reply** control and type in the indented `chat-item-container--reply` box (not the Everyone “Type message here ...” composer)
- **ECHO logo as Zoom camera**: Chromium fake video capture from `public/echo-logo.y4m` so the bot joins with the brand mark on its video tile (`ZOOM_SHOW_LOGO_VIDEO=true`)
- `ZoomWebChatReplyTarget` / `replyToMessage` plumbing through `zoomWebBot` → `server` → `meetingAi`
- Synced deploy trees: `new_bot_inmeeting/`, `web_bot_deploy/`
- Planned: multi-turn follow-ups as further nested replies under the original question

- **Playwright Zoom Web App bot** (`src/zoomWebBot.ts`) — joins via `app.zoom.us/wc/join` instead of Meeting SDK iframe
- **OAuth ZAK endpoints** (`src/zoomOAuth.ts`, `/oauth/zak`) for PSU-hosted Zoom join on Linux
- **PSU Linux ZAK guide** — [`docs/PSU_LINUX_ZAK.md`](docs/PSU_LINUX_ZAK.md)
- **Standalone deploy tree** — [`new_bot_inmeeting/`](new_bot_inmeeting/) + synced [`web_bot_deploy/`](web_bot_deploy/) (OAuth ZAK + Zoom Web bot)
- **Prominent README** — badges and quick-start table (code-only repo; papers kept offline)

### Added

- **Speech vs visual question routing**
  - “What did he/I say?” → spoken ASR transcript only (screen frames withheld)
  - “What does my slide say?” / “read the screen” → screen frames kept
- **Typo-tolerant intent matching** for chat typos (`jus tsay`, `juis tsaid`, `juswt now`)
- **Clinical Zoom answer mode** (educational clinician tone, no section labels)
  - Fixed footer: *Educational summary for ECHO discussion; not clinical advice or a medical record.*
  - Hedging rules: not a guideline, not patient-specific orders
- **Evidence grounding**
  - Auto PubMed for ordinary clinical questions (`PUBMED_RETRIEVAL_ENABLED=true`)
  - Private ECHO transcript RAG (`3310` chunks) for prior-session questions
  - With `PRIVATE_RAG_ALWAYS_ON=true`, clinical questions retrieve **both** PubMed + private transcripts (`intent=both`)
  - PubMed timeout/failure → **private transcript RAG fallback** (still citable)
  - If concept extraction is empty, PubMed can recover from **sanitized keywords in the user's question**
- **Readable citation footers** for `[ECHO:…]` / `[PMID:…]` / `[Case:…]` as numbered lines (title / time or date when available; no `Source:` header)
- **OAuth token persistence** (`OAUTH_STATE_PATH`) so restarts do not require re-auth
- **Multimodal VLM** path (Qwen2.5-VL) with single-frame retry on multi-image HTTP 400
- **Safe launcher** `scripts/run-node.sh` (headless defaults; clears stale shell env so `.env` timeouts/top-K apply)

### Changed

- Prompts distinguish speech / visual / casual meeting / clinical intents
- Colloquial questions are answered from context instead of “please clarify”
- Clinical / literature answer budgets raised (live defaults: RAG **2800** chars / **700** tokens; literature **3500** / **900**)
- Embedding start script uses vLLM 0.8 `--task embed` (not `--runner pooling`)

### Fixed

- Quoting slide text as spoken words for “what did he say?”
- “What does my slide say?” wrongly treated as speech because of the word `say`
- Mid-word truncation (`underlyi...`) from the old 1200-char RAG cap; trim now prefers sentence boundaries
- Private RAG pointed at missing `/scratch2/.../private_db`; now `/scratch1/ECHO_project/data/private_db`
- Embedding service restored on `:8002` (BGE-M3) so private RAG can search

### Current live ops (this host)

| Capability | Status |
|---|---|
| PubMed retrieval | On / available |
| Private transcript RAG | On / available (`3310` chunks, `ALWAYS_ON=true`) |
| BGE-M3 embeddings `:8002` | Up |
| VLM `:8010` + answer LLM `:8001` | Up |
| Structured historical **cases** | Off / empty (no case-workspace corpus yet) |

### Fixed (latest)

- Demo follow-ups: ECHO avatar asset + branded bot page; soft-quoted Zoom replies under questions; voice wake enabled; PSU Zoom ZAK scope docs

- Clinical answers left unsourced after PubMed timeouts now **fall back to prior ECHO transcript RAG** and can cite those chunks
- Retrieval timeouts raised (`SOURCE` 35s / `TOTAL` 45s); PubMed budget reserves time for the fallback
- Clinical prompts prefer **at most 3** strongest citations; private RAG top-K default lowered to **3**
- Explicit `PubMed` / `public medical sources` asks no longer degrade into answers that cite only private Zoom/ECHO transcript chunks
- Dementia/public-source requests can still build a PubMed query when concept extraction returns no safe medical terms
- Unique screen-share detection now crops Zoom / PowerPoint Online chrome and flags interior slide-text changes that the old 32×18 full-frame threshold treated as duplicates
- Visual questions with **0 RTMS frames** no longer call the VLM (stops the “machine learning applications” hallucination)
- Unique JPEGs sent to the VLM are **uncropped**; PowerPoint `Slide N of M` page-label-only answers are stripped or refused
- `who are you?` uses a template instead of stuffing the transcript into Qwen2.5-VL
- `read the page` is treated as a visual/slide question
- Qwen2.5-VL `--max-model-len` default raised from 8192 to **16384**; transcript still clipped (2500 chars with image / 4500 text-only)

### Known follow-ups

- Structured historical case retrieval needs a populated `CASE_WORKSPACE_DATA_DIR` before it can be useful (different from private transcript RAG)
- PubMed NCBI latency can still fail; fallback covers grounding but is not a literature review
- After Node restart, stop/start screen share is required before slide Q&A; VLM `--max-model-len` 32k is possible later if GPU 4 is empty and character clips are raised

### How to verify

1. Share a slide → `what did he say just now` (transcript only) vs `what does my slide say` (screen)
2. Casual → `I've just entered. where're we getting at`
3. Clinical → buprenorphine / craving question → educational answer + disclaimer; expect PubMed and/or ECHO transcript sources
4. If PubMed is slow/down → still expect ECHO transcript citations rather than an unsourced tip list
5. Explicit `PubMed` / `public medical sources` ask → either PMIDs or a clear PubMed failure, but not Zoom/ECHO substitute citations
6. Prior sessions → `From previous videos, …` → private RAG chunks + disclaimer
7. Confirm no `Bottom line` / `Evidence` / `Caveats` / `Source:` labels
8. After a Node restart, stop/start screen share; `what's on the slide` with 0 frames should say it cannot see the share (not invent a topic)
9. If a PowerPoint Online window is shared, a page-label-only Zoom reply should be replaced with slide body or an honest “only caught the page label” message

Full review brief: [`docs/PR_REVIEW.md`](docs/PR_REVIEW.md)  
Live slide debug: [`docs/LIVE_SLIDE_QA_REPORT.md`](docs/LIVE_SLIDE_QA_REPORT.md)  
Demo follow-ups: [`docs/DEMO_FOLLOWUPS.md`](docs/DEMO_FOLLOWUPS.md)
