# Human evaluation protocol — ECHO-AI (text context, M≤25)

Polite expert review of **archived ECHO-AI answers** from Penn State Project ECHO (MOUD) sessions.

**Who we are.** The ECHO-AI research team at Penn State, working with Penn State Project ECHO.

**Purpose.** Gather independent clinician/facilitator ratings of answer quality so we can improve an educational meeting assistant used in MOUD tele-mentoring. This is not a clinical trial and not a prescribing tool.

- Raters see the **question**, optional **meeting notes**, and **PubMed abstracts** when citations appear
- Raters score Likert dimensions in the annotation page
- **No Zoom slide screenshots** in the grading UI — score from the written materials only

## Why text-only context?

Slide/screen questions name the topic in the question itself. Raters judge whether the answer fits that wording and any meeting notes provided. Screenshots are not part of this survey.

## Packet

| File | Role |
|---|---|
| `human_eval_sheet.html` | Browser grading sheet |
| `human_eval_sheet.csv` | Spreadsheet twin |
| `ratings_template.csv` | Independent rater scores |
| `item_ids.csv` | Id / type / context index |
| `RUBRIC.md` | Full scoring rubric |
| `context/qa_*/case_pack.txt` | Question text pack |
| `context/qa_*/session_excerpt.txt` | Meeting summary/transcript excerpt (when available) |
| `context/qa_*/retrieved_evidence.txt` | Cited PMID abstracts (when available) |

**Composition (ceiling M=25):** curated ECHO packet + additional slide / session items. Off-domain or vague probes are excluded.

## What raters see (per item)

1. **Question** — self-contained prompt + short guidance  
2. **Meeting notes** — when available  
3. **Supporting literature** — PubMed title/abstract for cited PMIDs  
4. **Bot answer** — archived ECHO output  
5. Scores: Factual · Grounding · Evidence · Safety · Usability (1–5 or N/A)  
6. Optional tags + notes  

Questions are labeled **Question 1 … N** in order.

## Rubric

Full text: [`RUBRIC.md`](RUBRIC.md) (also at the top of the HTML sheet).

- Scale: **1 = Poor … 5 = Excellent** (plus **N/A**)
- Dimensions: Factual · Grounding · Evidence · Safety · Usability  
- Grounding = consistency with the question and notes (not screenshots)  
- Independent raters; author scores do not count toward K

## Target raters / reporting

- **K ≥ 3** independent clinicians/facilitators familiar with MOUD ECHO  
- Report mean/SD per dimension; IAA (e.g. Krippendorff’s α); error-tag rates  
- Optional stratify by `question_type`

## Public link

https://238plutonium.github.io/openreview/human-eval/

## Rebuild

```bash
python3 evaluation/human_eval/build_human_eval_sheet.py
```

Needs NCBI access to refresh PubMed abstracts (cached under `../citation_faithfulness/abstract_cache.json`) and optional `/scratch1/ECHO_project/data/rtms/minutes/` for session excerpts.
