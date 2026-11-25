# Generator baselines (frontier / open)

## Measured now
- **ECHO-AI stack** (Qwen2.5-VL-3B draft + Qwen3-4B format): human packet mean 4.26/5; LLM-judge mean 4.26/5; ρ≈0.34 (`medtutor_style_human_llm_judge.json`).
- Routing LLM vs rule comparison already in `../routing_comparison/` (not a generator bake-off).

## Pending (needs API / GPU access)
Frozen-packet generation against GPT / Claude / Gemini / Gemma on the same evidence packets as `../packet_qa.csv`, then the same 1–5 rubric + LLM-as-judge.

Do **not** invent scores. Fill `generator_baseline_scores.csv` when runs complete.

## Template columns
`generator,judge,factual,grounding,evidence,safety,usability,overall,n_items,notes`
