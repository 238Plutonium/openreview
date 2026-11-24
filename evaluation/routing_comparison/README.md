# Context routing versus competing methods

Compares ECHO-AI’s rule-based focus and retrieval-intent routers, plus delivery policies for speech recall and zero-frame visual asks, against simple always-* baselines and optional LLM classifiers.

## How to run

```bash
cd evaluation/routing_comparison
python3 run_routing_baselines.py
python3 run_routing_baselines.py --skip-llm   # rule/always-* + archived E2E only
```

`EVAL_ROOT` defaults to the parent of this folder (`evaluation/` or `eval/`). Optional: `ECHO_VLLM_URL` (default `http://127.0.0.1:8001/v1`).

## Label provenance

Gold labels are category-derived from existing experiment sets and synthetic intent probes: speech-ablation items → speech; no-frame paired items → visual; packet/held-out `question_type` → focus/intent. They are not independently double-annotated. See `gold_provenance` in `gold_*.jsonl`.

## End-to-end delivery policy (archived lab runs)

| Setting | ECHO routing | Competing method |
| --- | --- | --- |
| Speech vs slide conflict (30×3) | Withhold frame: spoken 1.00, slide-only 0.00 | Always attach slide: spoken 0.62, slide-only 0.38 |
| Visual ask, zero frames (n=35) | Guard on: abstain 33/35 | Guard off: 3/35 |

## Focus router (n=78)

| Method | Accuracy | Mean latency |
| --- | --- | --- |
| ECHO rule | 0.936 | 0.028 ms |
| Always speech | 0.385 | — |
| Always visual | 0.487 | — |
| Always general | 0.128 | — |
| LLM focus (Qwen3-4B) | 0.962 | 49.8 ms |

Rule vs LLM focus: about 1780× lower mean latency (0.028 ms vs 49.8 ms).

## Retrieval-intent router (n=32)

| Method | Accuracy | Mean latency |
| --- | --- | --- |
| ECHO rule | 0.688 | 0.221 ms |
| Always literature | 0.250 | — |
| Always historical | 0.125 | — |
| Always none | 0.625 | — |
| LLM intent (Qwen3-4B) | 0.469 | 68.7 ms |

Rule vs LLM intent: about 310× lower mean latency. On this label set the rule also out-accuracies the LLM intent classifier.
