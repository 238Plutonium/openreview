# ECHO-AI — NAACL 2027 System Demonstration

Public MIT snapshot of ECHO-AI: a Zoom RTMS meeting assistant that routes questions to shared slides, spoken transcript, PubMed, or prior-session material, with delivery controls when evidence is missing or mismatched.

## Quick start for reviewers

| Resource | Link |
| --- | --- |
| Live literature chat (PubMed only) | https://chive-shrouded-gag.ngrok-free.dev/chat.html |
| Service status | https://chive-shrouded-gag.ngrok-free.dev/api/status |
| Screencast (2:09) | https://www.youtube.com/watch?v=WwFCYDoYzm8 |
| Full demonstration recording | https://psu.mediaspace.kaltura.com/media/t/1_0syzr0gf |
| Manuscript | [ECHO_AI_Demo_Paper_SUBMIT.pdf](ECHO_AI_Demo_Paper_SUBMIT.pdf) |
| Access map | [REVIEWER_ACCESS.md](REVIEWER_ACCESS.md) |

The public website exposes PubMed retrieval only. Live Zoom frames and the institutional prior-session index are not available through that interface.

## What this repository contains

| Path | Contents |
| --- | --- |
| `meeting-bot/` | Zoom RTMS assistant (`src/`, tests, `demo_replay/`) |
| `website/` | PubMed-only literature demo |
| `evaluation/` | Ablation packages, citation audits, `verify_results.py` |

Credentials, institutional transcript indexes, PHI, and session media are excluded by design.

## Local installation

### Literature website

```bash
cd website
python3 -u server.py   # PORT=8080, ECHO_API_BASE=http://127.0.0.1:3000
```

Requires a running meeting-bot with AI services for `/api/ask`.

### Meeting bot

```bash
cd meeting-bot
cp .env.example .env   # Zoom/GPU endpoints; never commit .env
npm install
# start Whisper / VLM / answer LLM per scripts/start-*.sh
npm start
```

Admin and meeting-data routes require loopback or `x-echo-admin-token` (`ECHO_ADMIN_API_TOKEN`). `/ai/ask` remains available for the public literature path (`allowPrivateIndex: false`). Portable deployment steps: `meeting-bot/quick_start.md`. Web-client join: `meeting-bot/docs/WEB_APP_JOIN.md`.

### Synthetic multimodal replay (no live Zoom)

```bash
cd meeting-bot
# set DEMO_REPLAY_ENABLED=true in .env, then restart
npm run demo:replay -- --ask "@ECHO AI Assistant what is on this slide?"
```

See `meeting-bot/demo_replay/README.md`.

### Offline evaluation check

```bash
python3 evaluation/verify_results.py
```

## Evaluation packages

| Package | What it shows |
| --- | --- |
| [`evaluation/recorded_replay/`](evaluation/recorded_replay/) | Archived no-frame guard contrast (33/35 vs 3/35); open `index.html` or run the CPU verifier |
| [`evaluation/speech_recall_ablation/`](evaluation/speech_recall_ablation/) | Speech vs conflicting slide (withheld: spoken 90/90; included: spoken 56/90); lexical probes |
| [`evaluation/routing_comparison/`](evaluation/routing_comparison/) | Rule routers and delivery policies vs always-* / LLM baselines |
| [`evaluation/claim_level_audit/`](evaluation/claim_level_audit/) | Lexical assertion–PMID screen (14/132 supported; bibliography excluded) |
| [`evaluation/citation_faithfulness/`](evaluation/citation_faithfulness/) | ALCE-style soft citation precision 0.72; recall 0.23/0.73 (strict/soft) |

## Acknowledgments

Cursor was used to proofread selected portions of the source code.

## License

MIT for original source in this repository ([LICENSE](LICENSE)). Model weights, Zoom components, and other dependencies retain their own terms.

Educational use only — not clinical advice.
