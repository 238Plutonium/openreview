# ECHO-AI — NAACL 2027 System Demonstration (public snapshot)

MIT-licensed reviewer snapshot of the ECHO-AI meeting assistant and PubMed-only website.

## Try first (no install)

| Resource | Link |
|---|---|
| Live literature chat | https://chive-shrouded-gag.ngrok-free.dev/chat.html |
| Status | https://chive-shrouded-gag.ngrok-free.dev/api/status |
| Screencast (≤2.5 min) | https://www.youtube.com/watch?v=WwFCYDoYzm8 |
| Full demo recording | https://psu.mediaspace.kaltura.com/media/t/1_0syzr0gf |
| Manuscript PDF | [ECHO_AI_Demo_Paper_SUBMIT.pdf](ECHO_AI_Demo_Paper_SUBMIT.pdf) |

Public page = **PubMed only** (no Zoom frames, no prior-session index).

See [REVIEWER_ACCESS.md](REVIEWER_ACCESS.md) for a 2-minute path.

## Repository layout

| Path | Contents |
|---|---|
| `meeting-bot/` | Zoom RTMS assistant source (`src/`, tests, `demo_replay/`) |
| `website/` | PubMed-only literature demo |
| `evaluation/` | Ablation + packet artifacts + `verify_results.py` |

**Excluded by design:** `.env` credentials, institutional transcript index, PHI/session media, private-db builders.

## Install (optional local reproduction)

### Website (literature path)

```bash
cd website
python3 -u server.py   # PORT=8080, ECHO_API_BASE=http://127.0.0.1:3000
```

Requires a running meeting-bot with AI services for `/api/ask`.

### Meeting-bot (lab GPUs)

```bash
cd meeting-bot
cp .env.example .env   # fill Zoom/GPU endpoints; never commit .env
npm install
# start Whisper / VLM / answer LLM per scripts/start-*.sh
npm start
```

Sensitive admin/meeting-data routes require **loopback** or header `x-echo-admin-token` (`ECHO_ADMIN_API_TOKEN`).  
`/ai/ask` remains available for the public literature path (`allowPrivateIndex: false`).

### Synthetic multimodal replay (no live Zoom)

```bash
cd meeting-bot
# DEMO_REPLAY_ENABLED=true in .env, then restart npm start
npm run demo:replay -- --ask "@ECHO AI Assistant what is on this slide?"
```

See `meeting-bot/demo_replay/README.md`.

### Offline evaluation check

```bash
python3 evaluation/verify_results.py
```


## Speech-recall ablation (new)

Paired synthetic speech-vs-slide stress test with recorded outputs:

- Package: [`evaluation/speech_recall_ablation/`](evaluation/speech_recall_ablation/)
- Results: `evaluation/speech_recall_ablation/runs/speech_run_acceptance.jsonl` (180/180)
- Summary: `evaluation/speech_recall_ablation/runs/speech_summary.json`

Lexical probes only (not human attribution). Withheld frames: spoken 90/90, slide-only 0/90; included control: spoken 56/90, slide-only 34/90.

## Claim-level citation screening (corrected)

[`evaluation/claim_level_audit/`](evaluation/claim_level_audit/) — **bibliography rows excluded**. The earlier 14/10/6 tallies scored reference-list lines as claims and are **withdrawn**. Current files are preliminary automated assertion screening only, not validated answer-support counts.


## Acknowledgments

Cursor was used to proofread selected portions of the source code.

## License

MIT for original source in this repository ([LICENSE](LICENSE)). Model weights, Zoom components, and other dependencies keep their own terms.

Educational use only — not clinical advice.
