# Generator baselines

## Primary (paper Table 5)
- Human 3-rater means and paper Qwen3-4B judge on archived ECHO-AI answers (`medtutor_style_human_llm_judge.json`).

## Open CPU bake-off (completed)
Same M=13 questions; text-only generation (no slide images). Local judge: Qwen2.5-1.5B-Instruct.

| Generator | Overall | n |
|---|---:|---:|
| ECHO-AI archived | 3.49 | 13 |
| Qwen2.5-1.5B-Instruct | 3.82 | 13 |
| SmolLM2-1.7B-Instruct | 4.12 | 13 |
| **Gemma-2-2B-IT (Q4_K_M GGUF)** | **3.72** | 13 |

Artifacts: `open_model_generations.jsonl`, `open_model_judgments.jsonl`, `open_baseline_summary.json`, `run_open_baselines.py`, `run_gemma_gguf.py`.

## API bake-off (awaiting secrets)
Script ready: `run_api_baselines.py` (reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).
HF gated official Gemma weights need `HF_TOKEN` (GGUF path already covers Gemma without it).

## MOUD specialist panel (awaiting humans)
Template: `specialist_panel_scores.csv`. Rubric: `../RUBRIC.md`. Packet: `../packet_qa.csv`.
