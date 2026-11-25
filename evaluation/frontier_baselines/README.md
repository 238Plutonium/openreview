# Generator baselines

## Primary (paper Table 5)
- Human 3-rater means and paper Qwen3-4B judge on archived ECHO-AI answers (`medtutor_style_human_llm_judge.json`).

## Open CPU bake-off (completed)
Same M=13 questions; text-only generation (no slide images).
| Generator | Judge | Overall | n |
|---|---|---:|---:|
| ECHO-AI archived | Qwen2.5-1.5B (local) | 3.49 | 13 |
| Qwen2.5-1.5B-Instruct | same | 3.82 | 13 |
| SmolLM2-1.7B-Instruct | same | 4.12 | 13 |

Artifacts: `open_model_generations.jsonl`, `open_model_judgments.jsonl`, `open_baseline_summary.json`, `run_open_baselines.py`.

**Caveats:** Local 1.5B judge ≠ paper Qwen3-4B judge; small open models ≠ GPT/Claude/Gemini; Gemma gated without HF_TOKEN. Do not treat SmolLM > ECHO-AI under this judge as a clinical quality claim.

## Still pending API secrets
GPT / Claude / Gemini / gated Gemma rows in `generator_baseline_scores.csv`.
