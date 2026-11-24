# Reviewer access (≤2 minutes)

## 1. Live literature demo
Open https://chive-shrouded-gag.ngrok-free.dev/chat.html  
Ask: *What is buprenorphine used for in opioid use disorder?*  
Expect PMID footnotes + educational disclaimer when retrieval succeeds.

Health: https://chive-shrouded-gag.ngrok-free.dev/api/status → `"ready": true`

## 2. Screencast
https://www.youtube.com/watch?v=WwFCYDoYzm8 (≤2.5 min)

## 3. Offline numbers
```bash
python3 evaluation/verify_results.py
```
Checks the published 33/35 vs 3/35 no-frame contrast and packet pooled mean 4.26.

## 4. Source
- Website: `website/`
- Meeting bot: `meeting-bot/`
- Paper PDF: `ECHO_AI_Demo_Paper_SUBMIT.pdf`

## 5. Speech-recall ablation outputs
See `evaluation/speech_recall_ablation/README.md` and `runs/speech_summary.json`.
CPU-readable JSONL; reproducing model calls needs two replay bots (instructions in that README).

## 6. Offline no-frame recorded replay
Open `evaluation/recorded_replay/index.html` or run `python evaluation/recorded_replay/verify_paired_replay.py`.

## Citation faithfulness (automatic)

See `evaluation/citation_faithfulness/` (also under `reviewer_package/`). ALCE citation precision/recall on archived PubMed answers: **strict 0.19/0.23**, soft 0.72/0.73 (60/114 scores are 0.5; same-family 4B judge; not clinician validation). Offline: `python evaluation/verify_results.py`.
