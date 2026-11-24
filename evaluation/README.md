# Evaluation package (public, sanitized)

Supports the manuscript tables for:

1. **Paired zero-frame ablation** (33/35 vs 3/35)
2. **ECHO-content packet** (M=13; pooled human mean 4.26)
3. **Model-graded check** (Spearman ρ≈0.34; not clinician ratings)

## Offline verify (no GPUs)

```bash
python3 evaluation/verify_results.py
```

## Files

| File | Role |
|---|---|
| `paired_zero_frame.csv` | Per-arm labels for 35 paired asks |
| `paired_zero_frame_summary.md` | Count summary matching the paper |
| `packet_qa.csv` | Archived M=13 questions/answers for inspection |
| `heldout_qa_set_echo_only.csv` | Same packet ids with metadata |
| `packet_scores.csv` | Per-item human vs model means |
| `packet_scores_summary.json` | Anonymized pooled/per-rater means |
| `llm_judge_m13.csv` / `llm_judge_m13_summary.json` | Model-graded pass artifacts |
| `RUBRIC.md` | Scoring rubric |
| `verify_results.py` | Stdlib verification |

**Not included:** filled individual rater sheets with personal identifiers, institutional transcript indexes, credentials.

| `recorded_replay/` | GPU-free no-frame paired outputs (`paired_runs_n35.jsonl`, `paired_cases.json`) + HTML verifier |
