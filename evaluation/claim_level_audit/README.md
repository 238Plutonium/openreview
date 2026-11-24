# Claim-level citation audit (author-side)

Audits whether cited PubMed abstracts appear to support the attached claim text for archived answers.

**Not independent clinician validation.** Method: extract claim units carrying `[PMID:…]`, fetch abstracts via NCBI E-utilities (`curl`), label each claim–PMID pair `supported` / `unsupported` / `unclear` using a conservative lexical-overlap heuristic plus veterinary/species mismatch detection.

## Files
- `claim_unit_labels.csv` — per claim–PMID
- `claim_answer_labels.csv` — pooled per answer
- `claim_audit_summary.json` — counts
- `abstract_cache.json` — fetched title+abstract text

## Headline counts
See `claim_audit_summary.json`.
