# ALCE/MedCite-style citation faithfulness (machine eval)

Automatic attribution of ECHO-AI literature answers against PubMed abstracts, following [ALCE](https://github.com/princeton-nlp/ALCE) citation precision/recall (and MedCite-style 0 / 0.5 / 1 scores).

## Named metrics

| Name (ALCE) | Definition here |
|-------------|-----------------|
| **Citation precision** | Fraction of citation instances (statement, PMID) whose abstract supports the statement |
| **Citation recall** | Fraction of statements with ≥1 supporting cited PMID |

**Strict** = attr score 1. **Soft** = attr ≥ 0.5 (partial support). Report **strict first**.

## Method

1. Extract answer-body assertions with resolvable PMIDs (bibliography excluded).
2. Fetch title+abstract via NCBI E-utilities (`abstract_cache.json`).
3. Local judge `Qwen/Qwen3-4B-Instruct-2507` (temp 0; **same family** as the reply formatter) → {0, 0.5, 1}.
4. Aggregate precision over citation instances; recall over statements.

## Reproduce

Requires lab vLLM at `http://127.0.0.1:8001`.

```bash
python3 eval/citation_faithfulness/run_alce_style.py
```

## Headline results (2026-11-24)

| ALCE metric | Strict (1) | Soft (≥0.5) |
|-------------|------------|-------------|
| Citation precision | **0.19** | 0.72 |
| Citation recall | **0.23** | 0.73 |

28 answers · 86 statements · 114 citation instances · 0 parse failures.

Same-family 4B judge is **not** clinician validation. Soft–strict gap is mostly partial (0.5) labels. Lexical claim audit (14/132 supported) is closer to the strict end and is not the soft rate.

Artifacts: `citation_attr_units.csv`, `citation_attr_per_pmid.csv`, `citation_attr_summary.json`.
