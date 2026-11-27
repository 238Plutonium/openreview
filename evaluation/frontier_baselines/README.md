# Generator baselines

**Criterion: answer quality, not latency.** Scores use factual / grounding / evidence / safety / usability (1–5). Any `latency_s` fields in JSONL are operational logs only.

## Primary (paper MedTutor-style table)
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

## MedTutor-aligned Llama-3.3-70B (API still required)
Same M=13 packet and open-bake-off rubric. Runner: `run_llama33_baseline.py`. Judge: local Qwen2.5-1.5B GGUF.

Groq free/dev no longer serves `llama-3.3-70b-versatile` (retired 2026-08-16). OVHcloud anonymous was tried (`LLAMA33_USE_OVH_ANON=1`) but this Cloud Agent IP hit a **1-request/year** anonymous cap (`Retry-After` ~36 days) after a single call — not usable for M=13.

Paid keys (first match wins): `GROQ_API_KEY` (Enterprise Llama-3.3 only), `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, or `LLAMA33_API_KEY` + `LLAMA33_BASE_URL`.

| Generator | Overall | n | Status |
|---|---:|---:|---|
| meta-llama/Llama-3.3-70B-Instruct | — | 0 | **needs paid Llama-3.3 API** |
| ECHO-AI_archived (same judge) | 3.49 | 13 | already in open bake-off |

## Other Llama (local fallback): Llama-3.2-3B-Instruct GGUF
When Llama-3.3-70B API access is unavailable, run the same M=13 packet locally:

```bash
python evaluation/frontier_baselines/run_llama32_gguf.py
```

**Not** MedTutor’s Llama-3.3-70B comparator — labeled separately in summary/CSV.

| Generator | Overall | n | Status |
|---|---:|---:|---|
| Llama-3.2-3B-Instruct (Q4_K_M GGUF) | **4.31** | 13 | local CPU bake-off complete |
| ECHO-AI_archived (same judge) | 3.49 | 13 | already in open bake-off |

This is a **same-packet automatic bake-off**, not a copy of MedTutor Table 2 human scores (3.44 / 3.65). Do not invent human scores or paste those Table 2 numbers into ECHO results.

## API bake-off (proprietary = Gemini only for now)
`run_api_baselines.py` reads `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GOOGLE_API_KEY`.

| Generator | Overall | n | Status |
|---|---:|---:|---|
| Gemini-3.1-Flash-Lite | 4.86 | 13 | generated and judged by Qwen2.5-1.5B-Instruct |
| GPT | — | 0 | skipped for now (quota) |
| Claude | — | 0 | skipped for now (credit) |

Artifacts: `api_model_generations.jsonl`, `api_model_judgments.jsonl`. The Gemini default is `gemini-3.1-flash-lite` because `gemini-2.0-flash` and `gemini-2.5-flash` are closed to this key and `gemini-3.8-flash` returned repeated 503s. This judge is the open-bake-off judge, not the paper's Qwen3-4B Table 4 judge. HF gated official Gemma weights still need `HF_TOKEN` (the GGUF path already covers Gemma without it).

## Fair re-judge (all providers, Qwen3-4B family)
Re-scores every open + API generator with paper-family `Qwen3-4B-Instruct-2507` GGUF and a grounding-aware Likert rubric:

```bash
python evaluation/frontier_baselines/run_qwen3_fair_rejudge.py
```

| Generator | Overall | grounding | evidence | n |
|---|---:|---:|---:|---:|
| Gemini-3.1-Flash-Lite | 4.66 | 4.31 | 4.23 | 13 |
| Llama-3.2-3B-Instruct GGUF | 4.18 | 3.62 | 3.46 | 13 |
| ECHO-AI_archived | 3.89 | 3.23 | 3.08 | 13 |
| Qwen2.5-1.5B-Instruct | 3.82 | 3.00 | 3.00 | 13 |
| Gemma-2-2B-IT GGUF | 3.80 | 3.08 | 3.08 | 13 |
| SmolLM2-1.7B-Instruct | 3.69 | 2.92 | 3.00 | 13 |

Artifacts: `qwen3_fair_judgments.jsonl`, `qwen3_fair_summary.json`, `qwen3_fair_scores.csv`. Soft Likert still favors fluent models; paper humans remain Echo **4.26**.

## Session grounding integrity (Echo wins)
Session-dependent subset only (qa 15, 16, 30, 33–35). Same Qwen3-4B classifier labels each answer `grounded` / `hedged` / `fabricated` (scores 1.0 / 0.7 / 0.0):

```bash
python evaluation/frontier_baselines/run_grounding_integrity_test.py
```

| Generator | Integrity mean | grounded | hedged | fabricated | n |
|---|---:|---:|---:|---:|---:|
| **ECHO-AI_archived** | **0.85** | **3** | 3 | **0** | 6 |
| Gemini-3.1-Flash-Lite | 0.75 | 1 | 5 | 0 | 6 |
| SmolLM2-1.7B-Instruct | 0.70 | 0 | 6 | 0 | 6 |
| Qwen2.5-1.5B-Instruct | 0.70 | 0 | 6 | 0 | 6 |
| Gemma-2-2B-IT GGUF | 0.70 | 0 | 6 | 0 | 6 |
| Llama-3.2-3B-Instruct GGUF | 0.70 | 0 | 6 | 0 | 6 |

Artifacts: `grounding_integrity_labels.jsonl`, `grounding_integrity_summary.json`, `grounding_integrity_scores.csv`.

### Cross-family sensitivity (Llama-3.2 judge)
Same protocol with **Meta Llama-3.2-3B** as judge (not Qwen formatter family):

```bash
python evaluation/frontier_baselines/run_grounding_integrity_llama_judge.py
```

| Generator | Integrity mean | grounded | hedged | fabricated | n |
|---|---:|---:|---:|---:|---:|
| ECHO-AI_archived | 1.00 | 6 | 0 | 0 | 6 |
| gemini-3.1-flash-lite | 1.00 | 6 | 0 | 0 | 6 |
| SmolLM2-1.7B-Instruct | 1.00 | 6 | 0 | 0 | 6 |
| Gemma-2-2B-IT GGUF | 1.00 | 6 | 0 | 0 | 6 |
| Llama-3.2-3B-Instruct GGUF | 0.95 | 5 | 1 | 0 | 6 |
| Qwen2.5-1.5B-Instruct | 0.83 | 5 | 0 | 1 | 6 |

This 3B Llama judge is **too lenient** (near-ceiling scores) and does **not** reproduce the Qwen3 ranking. Treat as sensitivity, not a replacement primary judge. Prefer humans for quality claims; keep disclosing that the paper’s automatic packet/citation judges share the Qwen3 formatter family.

Artifacts: `grounding_integrity_llama_judge_*`.

## MOUD specialist panel (awaiting humans)
Template: `specialist_panel_scores.csv`. Rubric: `../RUBRIC.md`. Packet: `../packet_qa.csv`.

## Llama autograder on heldout (40 questions) — completed
Judge: Llama-3.2-3B-Instruct GGUF (local). Answers: archived ECHO from `evaluation/heldout_qa_set.csv` (n=40).

| Slice | Overall | n |
|---|---:|---:|
| All heldout | **4.17** | 40 |
| literature | 4.70 | 12 |
| other | 4.73 | 3 |
| prior_session | 4.40 | 1 |
| slide | 3.89 | 16 |
| summary | 3.67 | 8 |

Artifacts: `run_llama_autograder_heldout.py`, `llama_autograder_heldout_judgments.jsonl`, `llama_autograder_heldout_summary.json`, `llama_autograder_heldout_scores.csv`.
Not Llama-3.3-70B (still needs `GROQ_API_KEY` as a Cloud Agent environment secret).

## Heldout-40 multimodel (Llama CUDA judge)
Same 40 heldout questions as `heldout_qa_set.csv`. Generators see question text only;
ECHO answers are archived. Judge: Llama-3.2-3B-Instruct (HF/CUDA).
**Llama is judge-only** — not listed as a generator (avoids same-model self-grade).

```bash
CUDA_VISIBLE_DEVICES=0,1,2,5,6,7 python evaluation/frontier_baselines/run_heldout_multimodel_llama_judge.py
```

| Generator | Overall | n |
|---|---:|---:|
| ECHO-AI_heldout_archived | **4.04** | 40 |
| HuggingFaceTB/SmolLM2-1.7B-Instruct | **4.03** | 40 |
| google/gemma-2-2b-it (unsloth HF) | **3.92** | 40 |
| Qwen/Qwen2.5-1.5B-Instruct | **3.85** | 40 |

Artifacts: `run_heldout_multimodel_llama_judge.py`, `heldout_multimodel_generations.jsonl`,
`heldout_multimodel_llama_judgments.jsonl`, `heldout_multimodel_llama_summary.json`,
`heldout_multimodel_llama_scores.csv`.
