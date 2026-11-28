# Human evaluation protocol — ECHO-AI (MedTutor-style text context, M≤25)

Clinician grading of **archived ECHO-AI answers**, aligned with MedTutor (Jang et al., 2025):

- Raters see a **text case pack** + **retrieved evidence (PubMed title/abstract)** + optional **session text excerpt**
- Raters score Likert dimensions in an annotation UI
- **No Zoom slide screenshots** in the grading UI (MedTutor uses text case reports, not live slides)

## Why not slides-as-images?

MedTutor’s radiologists graded against **clinical case report text** and retrieved textbook/literature snippets—not live screenshare pixels.  
ECHO slide/screen questions are handled the same way: the **slide topic is written into the self-contained question** (the “case”), and grounding is judged against that case text (+ session excerpt when available).

## Packet

| File | Role |
|---|---|
| `human_eval_sheet.html` | Browser grading sheet |
| `human_eval_sheet.csv` | Spreadsheet twin |
| `ratings_template.csv` | Independent rater scores |
| `item_ids.csv` | Id / type / context index |
| `context/qa_*/case_pack.txt` | Text case pack |
| `context/qa_*/session_excerpt.txt` | Meeting summary/transcript excerpt (when available) |
| `context/qa_*/retrieved_evidence.txt` | Cited PMID abstracts (when available) |
| `../RUBRIC.md` | Dimension definitions |

**Composition (ceiling M=25, 宁缺毋滥):** curated packet (n=13) + quality RTMS extras. Off-domain / vague items excluded.

## What raters see (per item)

1. **Case pack** — self-contained question + setting (MedTutor “case report” analog)  
2. **Session text excerpt** — short meeting summary/transcript when available  
3. **Retrieved evidence** — PubMed title/abstract for cited PMIDs  
4. **System output** — archived ECHO answer  
5. Scores: factual · grounding · evidence · safety · usability (1–5)  
6. Optional error tags + notes

## Scoring (short)

1. **1 = poor … 5 = strong** (see `../RUBRIC.md`).
2. **Grounding** = consistency with the case pack / session excerpt (not pixel matching).
3. **Evidence** = cited material (abstracts) must support the claims; PMID lists alone ≠ good evidence.
4. Inventing meeting/slide specifics absent from the case/excerpt → low grounding; tag `hallucinated_session` / `weak_case_grounding`.
5. Independent raters; author scores do not count toward K.

## Worked examples

See the HTML “Annotation examples” panel (literature+abstracts; slide-topic-in-case-text; summary/prior; citation dump).

## Target raters / reporting

- **K ≥ 3** independent clinicians/facilitators familiar with MOUD ECHO  
- Report mean/SD per dimension; IAA (e.g. Krippendorff’s α); error-tag rates  
- Optional stratify by `source` / `question_type`

## Public link

https://238plutonium.github.io/openreview/human-eval/

## Rebuild

```bash
python3 evaluation/human_eval/build_human_eval_sheet.py
```

Needs NCBI access to refresh PubMed abstracts (cached under `../citation_faithfulness/abstract_cache.json`) and optional `/scratch1/ECHO_project/data/rtms/minutes/` for session excerpts.
