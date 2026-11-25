# Reviewer access

Paths through the public release, from live demo to offline packages. Numbers below match the manuscript and `evaluation/verify_results.py`.

## Live literature demo

1. Open https://chive-shrouded-gag.ngrok-free.dev/chat.html
2. Ask: *What is buprenorphine used for in opioid use disorder?*
3. Expect PMID footnotes and the educational disclaimer when retrieval succeeds.

Health check: https://chive-shrouded-gag.ngrok-free.dev/api/status should report `"ready": true`.

## Video

- Screencast (2:09): https://www.youtube.com/watch?v=WwFCYDoYzm8
- Full September 2026 recording: https://psu.mediaspace.kaltura.com/media/t/1_0syzr0gf

## Manuscript and source

| Item | Location |
| --- | --- |
| PDF | `ECHO_AI_Demo_Paper_SUBMIT.pdf` |
| Meeting bot | `meeting-bot/` |
| PubMed website | `website/` |

## Offline verification

```bash
python3 evaluation/verify_results.py
```

Confirms the published no-frame contrast (guard on 33/35 abstentions vs guard off 3/35) and the human answer-packet equal-rater mean 4.26/5.

## Evaluation packages

| Package | Entry point | Headline result |
| --- | --- | --- |
| No-frame recorded replay | `evaluation/recorded_replay/index.html` or `python evaluation/recorded_replay/verify_paired_replay.py` | Guard on 33/35 vs off 3/35 |
| Speech-recall ablation | `evaluation/speech_recall_ablation/README.md`, `runs/speech_summary.json` | Withheld spoken 90/90; included spoken 56/90 (lexical) |
| Routing comparison | `evaluation/routing_comparison/` (`python3 run_routing_baselines.py` or `--skip-llm`) | Rule ≪ LLM latency; category-derived gold |
| Citation faithfulness | `evaluation/citation_faithfulness/` | Citation precision 0.19 / 0.72; recall 0.23 / 0.73 (attr=1 / ≥0.5) |
| Claim-level audit | `evaluation/claim_level_audit/` | 14/132 supported (lexical; bibliography excluded) |

Speech-recall reproduction of model calls needs two replay bots; the JSONL summary is readable on CPU alone. Routing gold labels are category-derived (`gold_*.jsonl`), not independently annotated.

## Where the CFP questions appear in the paper

| CFP question | Section |
| --- | --- |
| Problem and importance | §1 |
| Novelty and audience | §1 |
| How it works | §3, Figure 1; Appendix A |
| Comparison to existing systems | Table 1; §2 |
| License | §3.5 (MIT code; upstream model licenses) |
| Evaluation | §5; Appendices A–C |

Demo and video URLs are also listed in §1 and Appendix B.
