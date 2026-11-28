# Human evaluation protocol — ECHO-AI (M=13 MOUD packet)

MedTutor-style clinician grading of **archived ECHO-AI answers**.  
Primary claim = human Likert scores; automatic judges are companions only.

## Packet (ECHO / MOUD only)

| File | Role |
|---|---|
| `human_eval_sheet.html` | Browser grading sheet (open locally) |
| `human_eval_sheet.csv` | Same items for spreadsheet entry |
| `ratings_template.csv` | Paste independent rater scores here |
| `context/` | Session screenshots / notes attached per item |
| `../RUBRIC.md` | Dimension definitions + error tags |
| `../packet_qa.csv` | Source Q/A (ids 3,4,12,13,15–18,30,33–36) |

**Excluded from this sheet:** off-domain heldout probes (dementia, diabetes, leukemia, dental, CS demo slides, etc.). Those are **not** the paper’s ECHO-content human packet.

**M = 13** fixed ids: `3, 4, 12, 13, 15, 16, 17, 18, 30, 33, 34, 35, 36`.

## What raters see

For each item:
1. Self-contained question (+ original chat text)
2. **Setting / context availability** note (whether slides or transcript excerpts are attached)
3. **Context panel** when available (screenshare frames and/or short meeting notes)
4. Bot answer (ECHO archived)
5. Score boxes: factual · grounding · evidence · safety · usability (1–5 or **N/A**)
6. Optional error tags + notes

You do **not** need Zoom. Use only the attached context.

## Scoring rules (short)

1. **1 = poor … 5 = strong** on each axis (see `../RUBRIC.md`).
2. If the question needs a slide/meeting and **no usable context is attached**, mark **grounding = N/A** (do not invent a grounding score). Still score honesty: inventing slide/meeting detail → low factual/grounding and tag `no_frame_hallucination`.
3. If context **is** attached, grounding must be checked against it (wrong slide content → `wrong_slide`).
4. PMIDs alone ≠ good evidence; the cited material must support the claim.
5. Do not discuss scores with other raters until all have finished.
6. Author/prior scores must stay hidden during independent rating.

## Worked examples (how to annotate)

### Example A — literature with useful citations (aim high evidence)
- Question asks for MOUD/pain/SUD education with literature.
- Answer hedges appropriately and citations support the claims.
- Typical: factual 4–5, grounding 4–5 (or N/A if no session needed), evidence 4–5, safety 4–5, usability 4–5; tags `ok`.

### Example B — slide question + frames attached (check pixels)
- Question: “what’s on my slide about pain treatment in SUD?”
- Context panel shows screenshare frames.
- If the answer matches visible slide text → high grounding.
- If it invents bullets not on the frames → grounding 1–2, tag `wrong_slide` / `unsupported_claim`.

### Example C — slide/summary ask but weak/missing context
- Setting says frames/transcript incomplete.
- Bot invents a detailed slide/meeting narrative → do **not** give high grounding; use **N/A** for grounding if you cannot verify, and tag `no_frame_hallucination` if it asserts unverifiable detail.
- Bot says it cannot see the slide/meeting → factual/safety/usability can still be mid–high; grounding N/A or low only if it then contradicts itself.

### Example D — irrelevant or mismatched citations
- Answer dumps PMIDs that do not support the claims → evidence 1–2, tag `irrelevant_pmid`.

## Target raters and reporting

- Aim for **K ≥ 3 independent** clinicians/facilitators familiar with MOUD ECHO (author scores do not count toward K).
- Report per-dimension mean/SD excluding N/A; report N/A rates; report IAA (e.g. Krippendorff’s α) after all ratings exist.
- Separately report error-tag rates (`wrong_slide`, `no_frame_hallucination`, `irrelevant_pmid`, …).

## Rebuild the sheet

```bash
python3 evaluation/human_eval/build_human_eval_sheet.py
```

Requires local access to `/scratch1/ECHO_project/data/rtms/` for copying context frames (already run once into `context/`).
