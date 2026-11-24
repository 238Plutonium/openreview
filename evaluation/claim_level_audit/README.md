# Claim-level citation screening (corrected)

## Correction
The first public CSV treated **bibliography lines** (e.g. `[6]: PMID … | Vitamin K and vascular calcification`) as claims. **111 such rows** were excluded. Those “supported” labels did **not** validate answer treatment claims.

## Method (current)
1. Split reply **body** from reference list.
2. Score only **assertions** in the body that cite a resolvable PMID (inline or footnote→PMID map).
3. Attach orphan `[n]` lines to the preceding sentence.
4. Label each assertion–PMID pair with a lexical/mismatch heuristic.

## Interpretation
This is **lexical assertion--PMID screen (not ALCE soft rates; not clinician validation)**, not validated answer-support evidence. Do not cite withdrawn 14/10/6 counts.

## Counts
```json
{
  "n_answers": 30,
  "n_assertion_pmid_checks": 132,
  "n_bibliography_lines_excluded": 124,
  "unit_label_counts": {
    "unsupported": 64,
    "unclear": 54,
    "supported": 14
  },
  "answer_screen_counts": {
    "has_unsupported_citation": 29,
    "mixed_or_unclear": 1
  }
}
```
