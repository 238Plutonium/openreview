# ALCE/MedCite-style citation faithfulness (machine eval)

Automatic statement-level attribution of ECHO-AI literature answers against PubMed abstracts, in the spirit of [ALCE](https://github.com/princeton-nlp/ALCE) and [MedCite](https://aclanthology.org/2025.findings-acl.967/).

## Method

1. Extract **answer-body assertions** with resolvable PMIDs (footnote map; bibliography excluded).
2. Fetch title+abstract via NCBI E-utilities (`abstract_cache.json`).
3. Local LLM judge (`Qwen/Qwen3-4B-Instruct-2507`, temp 0) returns attr ∈ {0, 0.5, 1}.
4. **Joint recall** (concatenated cited abstracts per statement) and **per-citation precision** (each PMID judged alone; statement recall = ≥1 supporting cite).

## Reproduce

Requires the lab vLLM endpoint at `http://127.0.0.1:8001`.

```bash
python3 eval/citation_faithfulness/run_alce_style.py
```

Outputs: `citation_attr_units.csv`, `citation_attr_per_pmid.csv`, `citation_attr_summary.json`.

## Headline results (2026-11-24 run)

| Metric | Soft (attr≥0.5) | Strict (attr=1) |
|--------|-----------------|-----------------|
| Joint statement recall (concat evidence) | 0.79 | 0.19 |
| Per-citation precision | 0.72 | 0.19 |
| Statement recall (≥1 supporting cite) | 0.73 | 0.23 |

28 answers · 86 assertions · 114 citation instances · 0 parse failures.

**Not** clinician validation. Demonstrates that PMID provenance ≠ claim support.
