# Context routing vs competing methods

## Portability

```bash
# from the public repo
cd evaluation/routing_comparison
python3 run_routing_baselines.py          # uses sibling files under evaluation/
python3 run_routing_baselines.py --skip-llm   # no GPU/vLLM required for rule/always-* + archived E2E
```

`EVAL_ROOT` defaults to the parent of this folder (`evaluation/` or `eval/`). Optional:
`ECHO_VLLM_URL` (default `http://127.0.0.1:8001/v1`).

## Gold-label caveat

Labels are **category-derived** (speech ablation → speech; no-frame paired → visual;
packet/heldout `question_type` → focus/intent) plus synthetic intent probes.
They are **not** independently double-annotated. See `gold_*.jsonl` `gold_provenance`.

## End-to-end delivery policy (archived lab runs)

| Setting | ECHO routing | Competing method |
|---------|--------------|------------------|
| Speech vs slide conflict (30×3) | Withhold frame: spoken 1.00, slide-only 0.00 | Always attach slide: spoken 0.62, slide-only 0.38 |
| Visual ask, zero frames (n=35) | Guard on: abstain 33/35 | Guard off: 3/35 |

## Focus router (n=78)

| Method | Accuracy | Mean latency |
|--------|----------|--------------|
| **ECHO rule** | **0.936** | **0.028 ms** |
| Always speech | 0.385 | — |
| Always visual | 0.487 | — |
| Always general | 0.128 | — |
| LLM focus (Qwen3-4B) | 0.962 | 49.8 ms |

Rule vs LLM focus speedup: **1784×** (rule 0.028 ms vs LLM 49.8 ms mean).

## Retrieval-intent router (n=32)

| Method | Accuracy | Mean latency |
|--------|----------|--------------|
| **ECHO rule** | **0.688** | **0.221 ms** |
| Always literature | 0.250 | — |
| Always historical | 0.125 | — |
| Always none | 0.625 | — |
| LLM intent (Qwen3-4B) | 0.469 | 68.7 ms |

Rule vs LLM intent speedup: **310×**.
