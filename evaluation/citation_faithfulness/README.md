# ALCE/MedCite-style citation faithfulness (machine eval)

Automatic attribution of ECHO-AI literature answers against PubMed abstracts, following [ALCE](https://github.com/princeton-nlp/ALCE) **citation precision** / **citation recall**.

## Named metrics

| Name (ALCE) | Definition |
|-------------|------------|
| **Citation precision** | Fraction of (statement, PMID) instances whose abstract supports the statement |
| **Citation recall** | Fraction of statements with ≥1 supporting cited PMID |

**Strict** = attr 1. **Soft** = attr ≥ 0.5. Report **strict first**. Soft is mostly middle labels (60/114 are 0.5).

## Method

1. Extract answer-body assertions with resolvable PMIDs (bibliography excluded).
2. Fetch title+abstract via NCBI E-utilities (`abstract_cache.json`).
3. Local judge `Qwen/Qwen3-4B-Instruct-2507` (temp 0; **same family** as the reply formatter) → {0, 0.5, 1}.
4. Aggregate precision over citation instances; recall over statements.

## Reproduce

Requires lab vLLM at `http://127.0.0.1:8001` to re-judge. Offline rate check (no GPU):

```bash
python3 evaluation/verify_results.py   # public layout
# or from this repo:
python3 eval/verify_results.py
```

## Headline results (2026-11-24)

| ALCE metric | Strict (1) | Soft (≥0.5) |
|-------------|------------|-------------|
| Citation precision | **0.19** | 0.72 |
| Citation recall | **0.23** | 0.73 |

28 answers · 86 statements · 114 citation instances · 60 scores are 0.5 · 0 parse failures.

**Veterinary PMID 29314873** (AAHA dogs/cats) appears in 8 historical diabetes citation instances and receives 3 strict=1 judgments on human-diabetes claims—judge leniency across species. Excluding it ≈ strict precision 0.18. Not used as a positive appendix example.

Lexical claim audit (14/132 supported) tracks the **strict** end; do not compare it to soft 0.72.

Not clinician validation.
