# Context routing vs competing methods

## End-to-end delivery policy (archived lab runs)

| Setting | ECHO routing | Competing method | Metric |
|---------|--------------|------------------|--------|
| Speech vs slide conflict (30 cases × 3) | Withhold frame on speech focus | Always attach conflicting slide | Spoken token 1.00 vs 0.62; slide-only 0.00 vs 0.38 |
| Visual ask, zero frames (n=35) | No-frame fixed abstention | Draft anyway (guard off) | Abstain 33/35 vs 3/35 |

## Focus router accuracy (offline; n=78)

| Method | Accuracy |
|--------|----------|
| **ECHO rule router** | **0.936** |
| Always speech | 0.385 |
| Always visual | 0.487 |
| Always general | 0.128 |
| LLM router (Qwen3-4B) | 0.962 |

Gold mix: {'speech': 30, 'visual': 38, 'general': 10}

## Retrieval-intent router accuracy (offline; n=32)

| Method | Accuracy |
|--------|----------|
| **ECHO rule router** | **0.688** |
| Always literature | 0.250 |
| Always historical | 0.125 |
| Always none | 0.625 |

Gold mix: {'literature': 8, 'none': 20, 'historical-cases': 4}
