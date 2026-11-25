# Response to co-author feedback (vs. `ECHODemo.pdf`)

Source paper: https://github.com/238Plutonium/echo-ai-naacl-submission/blob/main/ECHODemo.pdf  
Reference eval style: MedTutor (ACL Anthology `2025.emnlp-demos.24v2.pdf`)  
Constraint: **no git commits**; drafts only in this folder.

## Feedback → current paper gap → proposed action

| Feedback | In `ECHODemo.pdf` now | Action in drafts |
|---|---|---|
| Discuss ECHO program, data source, disease | Generic ECHO + hepatitis C history; “98 sessions” buried in §3.3; ASERT mentioned once late | New domain paragraph in Intro + dedicated **Data and domain** subsection naming **MOUD / OUD** |
| How many videos / what disease | No video count narrative; no disease name beyond “diabetes” failure example | State: institutional index from **98 recorded MOUD-focused ECHO sessions** → **3,310** de-identified transcript chunks; demo/packet content is **OUD / MOUD / pain-in-SUD** |
| Mention **MOUD** | **Zero** occurrences of “MOUD” | Use MOUD throughout abstract, intro, data, eval examples, ethics |
| (1) Compare frontier models GPT/Claude/Qwen/Gemma | Only local Qwen2.5-VL / Qwen3; router LLM baseline is Qwen3-4B | Add **honest protocol + table shell** for generator baselines; **do not invent scores**. Report existing Qwen stack results as the current system |
| (2) Human evaluation from experts (MedTutor-style) | 4 facilitator usability ratings + 3 raters on 13-item packet (identities private); not framed as domain-expert clinical education review | Restructure eval like MedTutor: upstream/downstream; human Likert table; LLM-as-judge (existing ρ≈0.34); clarify rater roles; mark **MOUD-expert expansion** as needed |
| (3) Education outcomes | Title says tele-education; no learner outcome measure | Add **education-outcome protocol** (knowledge / confidence / intent-to-use); no fabricated pre/post numbers |
| Writing less AI-like | Eval is dense, metric-first, hard to skim | Rewrite eval in plain academic prose: one claim per paragraph, numbers after the claim |
| IRB / patient privacy; ask Laura | Ethics has disclaimer + de-id, **no IRB** language | Draft Ethics with privacy controls + **IRB status TBD**; separate Laura question list—**do not invent approval IDs** |

## What we can ship in text now (no new experiments)

- Domain / MOUD / data characterization from existing system facts and packet content  
- Clearer human-eval presentation of **already measured** numbers (4.13, 4.26, ρ≈0.34)  
- MedTutor-aligned section structure and planned frontier / education-outcome protocols  
- Ethics privacy + IRB placeholder pending Laura  

## What still needs humans / compute (not invented here)

1. Frontier generator baselines on the fixed packet (API or local runs)  
2. ≥3 independent **MOUD / addiction-medicine educators** scoring the packet (MedTutor-style)  
3. Education-outcome pilot (even small n) if claiming “education” impact  
4. **Laura Felix**: IRB determination language, retention policy wording, what can be said about patient cases in live ECHO  

## Files in this folder

- `01_REVISED_SECTIONS.md` — drop-in prose for Abstract / Intro / Data / Eval / Ethics / Limitations  
- `02_QUESTIONS_FOR_LAURA.md` — short list to send Laura before finalizing Ethics  
- `03_EVAL_PROTOCOL_FRONTIER_AND_EDU.md` — runnable protocol so scores can be filled later without rewriting the paper skeleton  
