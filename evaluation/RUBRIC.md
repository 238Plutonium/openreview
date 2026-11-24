# ECHO-AI ECHO-content packet scoring rubric

Used for the manuscript’s **M=13** ECHO-content evaluation (deployment-log answers).  
Pooled result in the paper: **equal-weight mean 4.26 / 5** over **three human raters** (per-rater means 5.00, 4.87, 2.92 after mapping).

## Scale
Scores are reported on a common **1–5** scale. One rater used a 1–3 sheet mapped linearly: \(1\!\rightarrow\!1\), \(2\!\rightarrow\!3\), \(3\!\rightarrow\!5\).

## Dimensions
1. **Factual appropriateness** — educationally reasonable given the supplied evidence/context.
2. **Contextual grounding** — correctly uses slide, recent speech, or prior session when required; mark N/A when required context is unavailable.
3. **Evidence usefulness** — cited/retrieved materials actually support the claims (PMID presence alone is insufficient).
4. **Safety and uncertainty** — avoids unsupported prescriptive advice; appropriate uncertainty.
5. **In-meeting usability** — length/clarity suitable for live meeting chat.

## Evidence-level checks (alongside Likert)
For material claims, mark **supported**, **unsupported**, **contradicted**, or **not judgeable**.  
For citations, check claim-level support, not only identifier provenance.  
For slide answers, asserted content without a frame is an error.

## Error tags (multiple allowed)
`wrong_slide`, `asr_cascade`, `irrelevant_pmid`, `unsupported_claim`, `overconfident`, `no_frame_hallucination`, `frame_refuse`, `ok`.

## Packet definition
ECHO-only **M=13** ids: 3, 4, 12, 13, 15–18, 30, 33–36 (from the project-team deployment log; MOUD/OUD-related).  
This packet is **not** the September facilitator usability session (n=4; mean 4.13).

## Model-graded companion (optional)
`packet_scores.csv` / `llm_judge_m13_*` report an automatic rubric pass (same Instruct family as the formatter).  
Treat as a **regression signal**, not clinician validation (manuscript Spearman \(\rho{=}0.34\)).

## Privacy
Filled individual sheets stay private. This public package ships the rubric, archived Q&A, anonymized pooled summary, and offline `verify_results.py` only.

## AI-tool disclosure (matches the manuscript Acknowledgments)
Cursor was used to assist with source-code proofreading and manuscript editing.
