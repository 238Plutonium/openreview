# Evaluation protocols to answer the remaining feedback

Fill results into `01_REVISED_SECTIONS.md` §5.6–5.7 when available. Do **not** invent numbers.

## A. Frontier / open generator baselines (MedTutor-style)

**Goal.** Compare answer quality of the current ECHO-AI generator stack against stronger open and closed models on the **same MOUD packet**, with human + LLM judges (cf. Jang et al., 2025, Tables 1–2).

**Fixed inputs**
- Items: `evaluation/packet_qa.csv` (M=13) or an expanded held-out set (target M≥20).  
- For each item, freeze: question text, attached frame IDs (or none), transcript/summary snippet, retrieval evidence list (PubMed abstracts / ECHO chunks) as used historically.  
- Do **not** re-retrieve when comparing generators (isolates generation).

**Systems**
1. Current: Qwen2.5-VL-3B draft → Qwen3-4B format (archived answers already exist).  
2. Open text/VL alternatives available locally or via open APIs (document exact IDs: e.g., larger Qwen, Gemma).  
3. GPT-family (state model + date).  
4. Claude-family (state model + date).  

If a closed model cannot take images, run a **text-only** condition and mark vision items N/A for that system.

**Judges**
- Humans: same 1–5 rubric as `evaluation/RUBRIC.md`; ideally ≥3 MOUD educators.  
- LLM-as-judge: keep Qwen3-4B prompt for continuity; optionally add one frontier judge; report correlation with humans (expect moderate, as now ρ≈0.34).

**Report table (template)**

| Generator | Judge | Factual | Grounding | Evidence | Safety | Usability | Overall |
|---|---|---|---|---|---|---|---|
| ECHO-AI (Qwen VL+3) | Human | | | | | | |
| … | Human | | | | | | |
| ECHO-AI | LLM-judge | | | | | | |
| … | LLM-judge | | | | | | |

**Honesty rules**
- No cherry-picked items.  
- Report failure tags (irrelevant PMID, unsupported claim, etc.).  
- Separate identifier provenance from claim support.

## B. Education outcomes (title alignment)

**Goal.** Show whether ECHO-AI helps *learning / teaching process*, not only answer polish.

**Minimal pilot (demo-track feasible)**
- Setting: one MOUD ECHO session with ECHO-AI available.  
- n: as many spoke participants as consent (even n≈10–20 is publishable as pilot).  
- Pre (5 min): 3–5 knowledge items + 2 confidence Likert items on session topics.  
- During: optional bot use logged (count of asks by type).  
- Post: same knowledge/confidence items + usefulness / non-disruption Likert.  

**Primary descriptive outcomes**
- Pre→post knowledge score change (mean±SD).  
- Confidence change.  
- % who used the bot; mean usefulness; non-disruption.  

**Non-claims**
- Not clinical patient outcomes.  
- Not superiority vs. ECHO without the bot unless a controlled comparison exists.

## C. Human experts (raise to MedTutor bar)

**Now:** 3 raters × 13 items; facilitator usability n=4.  
**Target:** K≥3 **MOUD/addiction teaching experts**; M≥20; publish IAA; keep LLM-judge as secondary.

Materials ready in repo: `evaluation/` packet + `RUBRIC.md`. Hide prior grades during rating.
