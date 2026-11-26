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

## MedTutor-aligned Llama-3.3-70B (blocked on API key)
Same M=13 packet and open-bake-off rubric. Runner: `run_llama33_baseline.py` (appends to `open_model_generations.jsonl` / `open_model_judgments.jsonl`, refreshes `open_baseline_summary.json` + `generator_baseline_scores.csv`). Judge: local Qwen2.5-1.5B GGUF (`Qwen/Qwen2.5-1.5B-Instruct-GGUF` / `qwen2.5-1.5b-instruct-q4_k_m.gguf`).

**Blocker:** no generation API key in this environment. Add **one** secret — prefer **`GROQ_API_KEY`** (model `llama-3.3-70b-versatile`). Then:

```bash
python evaluation/frontier_baselines/run_llama33_baseline.py
```

Alternatives (first match wins): `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, or `LLAMA33_API_KEY` + `LLAMA33_BASE_URL`.

| Generator | Overall | n | Status |
|---|---:|---:|---|
| meta-llama/Llama-3.3-70B-Instruct | — | 0 | **needs `GROQ_API_KEY`** (or another key above) |
| ECHO-AI_archived (same judge) | 3.49 | 13 | already in open bake-off |

This is a **same-packet automatic bake-off**, not a copy of MedTutor Table 2 human scores (3.44 / 3.65). Do not invent human scores or paste those Table 2 numbers into ECHO results.

## API bake-off (proprietary = Gemini only for now)
`run_api_baselines.py` reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`.

| Generator | Overall | n | Status |
|---|---:|---:|---|
| Gemini-3.1-Flash-Lite | 4.86 | 13 | generated and judged by Qwen2.5-1.5B-Instruct |
| GPT | — | 0 | skipped for now (quota) |
| Claude | — | 0 | skipped for now (credit) |

Artifacts: `api_model_generations.jsonl`, `api_model_judgments.jsonl`. The Gemini default is `gemini-3.1-flash-lite` because `gemini-2.0-flash` and `gemini-2.5-flash` are closed to this key and `gemini-3.8-flash` returned repeated 503s. This judge is the open-bake-off judge, not the paper's Qwen3-4B Table 5 judge. HF gated official Gemma weights still need `HF_TOKEN` (the GGUF path already covers Gemma without it).

## MOUD specialist panel (awaiting humans)
Template: `specialist_panel_scores.csv`. Rubric: `../RUBRIC.md`. Packet: `../packet_qa.csv`.
