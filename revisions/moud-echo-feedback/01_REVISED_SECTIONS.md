# Drop-in revised sections for `ECHODemo.pdf`

Paste/adapt into the manuscript source when available. Numbers below are **already in the paper or eval package** unless marked *[protocol / pending]*.  
Writing goal: short sentences, one idea per paragraph, fewer stacked metric clauses.

---

## Abstract (revised)

During Project ECHO (Extension for Community Healthcare Outcomes) tele-mentoring, hub specialists and community clinicians meet over Zoom to discuss cases and short teaching talks. Our deployment focuses on **Medication for Opioid Use Disorder (MOUD)** education: participants often need the current slide, a recent remark, a prior MOUD session, or a PubMed article without stopping the discussion.

We present **ECHO-AI**, a Zoom Real-Time Media Streams (RTMS) assistant that joins the meeting (with host approval) and answers by public mention, private chat, or voice. It routes each question to shared-screen frames, speech transcript, PubMed, or a private index of **98 prior ECHO sessions** (3,310 de-identified transcript chunks), drafts with a vision–language model, and formats replies with an LLM. Delivery controls withhold slides for speech recall, abstain when a visual question has no frame, and cite only PMIDs present in the retrieval record.

We evaluate the live path with deployment logs (419 project-team queries; mean answer latency 6.0 s), paired safeguard tests, facilitator usability (n=4; mean 4.13/5), and a 13-item answer packet scored by three human raters (equal-weight mean 4.26/5). An automatic citation audit finds partial or full support for most claim–citation pairs against PubMed abstracts, with only moderate agreement with human item means (Spearman ρ≈0.34)—consistent with MedTutor’s caution that LLM judges are not a substitute for experts (Jang et al., 2025). MIT-licensed code, replay artifacts, and a screencast are released. **Frontier generator comparisons and learner outcome measures are specified as follow-on evaluation** rather than claimed results in this version.

---

## §1 Introduction — insert after opening ECHO paragraph

**Suggested replacement for the hepatitis-C-only framing (keep the HCV cite, then localize):**

Project ECHO connects hub specialists and frontline clinicians at spoke sites in recurring, case-based videoconferences (Arora et al., 2010, 2011a). In the original hepatitis C program, treatment outcomes at primary-care sites matched specialty clinics (Arora et al., 2011b). At Penn State, one active line of ECHO teaching is **MOUD**: primary-care and community clinicians discuss de-identified patient cases with addiction specialists, review brief evidence-based talks, and practice how to offer medications for opioid use disorder in local settings.

That teaching hour is multimodal and time-pressured. Participants may need to clarify a shared slide (for example, DSM criteria for opioid use disorder), recall what a facilitator just said about buprenorphine, recover a point from an earlier MOUD cohort recording, or pull a recent paper—without leaving Zoom. Existing meeting assistants mainly support transcription or transcript chat. Offline medical education systems such as MedTutor build modules from finished reports (Jang et al., 2025). Neither setting places multimodal, citation-constrained assistance *inside* the live MOUD ECHO call.

ECHO-AI is built for that setting…

*(Keep existing contributions, but change (ii) to mention human ratings + planned expert/frontier/education-outcome evaluation.)*

---

## New §3.x (or expand §3.3): Data and medical domain

**ECHO program and disease focus.**  
This demonstration is grounded in Penn State Project ECHO tele-education for **opioid use disorder (OUD)** and **Medication for Opioid Use Disorder (MOUD)**. Session topics in our logs and evaluation packet include MOUD and HIV prevention, pain management in patients with substance use disorders, stigma and language around OUD, and related teaching slides. The system is educational tele-mentoring support, not a prescribing tool.

**ECHO data source.**  
The private retrieval index contains **3,310 chunks** drawn from **98 prior institutional ECHO session recordings** (video → ASR transcript → overlapping text chunks). Before indexing, an automatic pass redacts phone numbers, dates, street addresses, self-identified names, and organization-like spans; this pass is a safeguard, not a manual privacy certification. Chunks are searchable only on the Zoom path under institutional credentials; the public web demo cannot query the index. PubMed retrieval uses sanitized medical concepts plus a Humans[Mesh] filter and never sends raw meeting audio or transcript text to PubMed.

**Live and simulated use.**  
We ran a simulated MOUD-themed teaching session for facilitator feedback (September 2026) and additionally used the system in the October 27, 2026 Penn State ASERT Project ECHO session. Usability scores below come from the September form only.

---

## §5 Evaluation (rewritten spine; MedTutor-aligned)

### Opening (replace current dense opener)

We evaluate ECHO-AI along three lines, following the spirit of MedTutor’s multi-faceted demo evaluation (Jang et al., 2025) but adapted to *live meeting* assistance:

1. **Operational behavior** of the deployed Zoom path (latency, frame attachment, citation provenance).  
2. **Controlled comparisons** of routing and delivery policies against competing methods.  
3. **Human judgment** of answer quality and usability, plus an automatic citation check.

We report measured results first. Protocols for frontier-model generator baselines and learner education outcomes are stated explicitly where scores are not yet available.

### 5.1 Deployment behavior
*(Keep Table 2 numbers; rewrite prose.)*

The development log contains **419** answers (**289** distinct strings) written while building the bot across **55** RTMS streams. Slide-like questions (text contains “slide” or “screen”) had at least one deskshare frame attached in **86/122** cases (70.5%). Near-duplicate filtering kept **290** unique frames and dropped **19,078** near-copies (unique-frame rate 0.015). Mean end-to-end answer latency was **6.0 s** (median 4.1 s; n=213).

When a retrieval record was stored (n=52), routing was literature 33 / both 14 / prior-session 5. **All 27** PMID-bearing answers used identifiers that appear in that call’s evidence list. This checks *provenance*, not that the paper supports the claim. Eight historical diabetes answers still cite a veterinary PMID; that failure motivated the Humans[Mesh] filter on new retrieval.

### 5.2 Routing versus competing methods
*(Keep Table 3; slightly plainer prose—existing content is fine.)*

### 5.3 Human evaluation of answer quality
*(Elevate and clarify; MedTutor-style.)*

**Setting.** Three human raters scored a fixed **13-question** packet drawn from MOUD/OUD-related development questions (literature, slide, summary, and prior-session items such as pain-in-SUD and prior MOUD session recall). Scores use a 1–5 rubric: factual appropriateness, contextual grounding, evidence usefulness, safety/hedging, and in-meeting usability (Appendix). One sheet used a 1–3 scale and was linearly mapped to 1–5.

**Results.** The equal-weight mean of rater means is **4.26/5** (per-rater 5.00, 4.87, 2.92). Evidence usefulness is the weakest dimension (**3.78/5**); at least one rater flagged **9/13** answers (often irrelevant or weakly supportive PMIDs). These ratings assess archived educational answers; they are **not** a clinical accuracy trial and are smaller than MedTutor’s radiologist study (Jang et al., 2025).

**LLM-as-a-judge (existing).** A same-family Qwen3-4B judge scored the same 13 items (mean 4.26). Item-level Spearman correlation with human means is **ρ≈0.34**—moderate alignment, again echoing MedTutor’s finding that automatic judges tend to track relative quality imperfectly and can inflate absolute scores. We therefore treat LLM judges as a scaling aid, not a replacement for expert review.

**Expert expansion *[protocol]*.** To strengthen human evaluation toward MedTutor’s standard, we will recruit **K≥3 MOUD / addiction-medicine educators or ECHO facilitators with clinical teaching roles** to rate an expanded held-out packet (target M≥20) under the same rubric, reporting means and inter-rater agreement (e.g., Krippendorff’s α). Until that study is complete, we do not present the current packet as specialist clinical validation.

### 5.4 Facilitator usability
*(Keep 4.13 table; note September vs October ASERT.)*

### 5.5 Citation support audit
*(Keep Table 4; keep the attr≥0.5 honesty.)*

### 5.6 Generator baselines against frontier models *[protocol — no scores yet]*

MedTutor compares generator models under human and LLM judges (Jang et al., 2025). Our current Zoom stack uses **Qwen2.5-VL-3B** (draft) and **Qwen3-4B** (format). We specify a **fixed-packet baseline study** (same 13 MOUD items, same evidence packet when retrieval is used) comparing:

| Generator setting | Role | Status |
|---|---|---|
| Qwen2.5-VL-3B + Qwen3-4B (current) | System default | Measured (packet above) |
| Stronger open VL/LLM (e.g., larger Qwen / Gemma) | Open baseline | *[pending]* |
| GPT-family API (text-only or vision as available) | Closed baseline | *[pending]* |
| Claude-family API | Closed baseline | *[pending]* |

Judging: the same human rubric (subset) + the same LLM-as-judge prompt family. We will report absolute scores and **rank agreement** with humans, not only automatic preference. API baselines will be literature/transcript-only when vision APIs are unavailable, and that limitation will be stated.

### 5.7 Education outcomes *[protocol — no scores yet]*

Because the title targets tele-education, system quality alone is not enough. We plan a small **ECHO-linked education pilot**:

- **Participants:** spoke clinicians or trainees attending a MOUD ECHO session that uses ECHO-AI.  
- **Measures (pre/post session):** (i) short knowledge items tied to that session’s teaching points; (ii) self-rated confidence answering MOUD/pain-in-SUD questions of the kinds the bot handles; (iii) perceived usefulness / non-disruption (reuse facilitator items).  
- **Analysis:** descriptive pre/post changes and qualitative comments; no claim of clinical outcome improvement without a dedicated study.

Until that pilot runs, we report **usability and answer quality**, not learning gains.

---

## Limitations (additions)

- Domain evaluation is concentrated on **MOUD / OUD tele-education** at one institution; other ECHO disease areas are untested.  
- Human answer ratings use three raters on 13 items; they are not yet a MedTutor-scale specialist panel.  
- No completed frontier-model generator bake-off and no measured learner knowledge gains in this version.  
- IRB determination wording for institutional session media must be finalized with the ECHO program office (see Ethics).

---

## Ethics Statement (revised; IRB TBD with Laura)

ECHO-AI is an **educational** aid for MOUD and related Project ECHO tele-mentoring. It is not intended to diagnose, prescribe, document in the legal medical record, or replace hub specialist judgment. Clinical or retrieval-backed replies append: “Educational summary for ECHO discussion; not clinical advice or a medical record.” The meeting host controls whether the bot is admitted.

**Patient privacy.** Live ECHO sessions may include discussion of **de-identified** clinical cases. ECHO-AI processes meeting audio and shared-screen frames only inside the approved Zoom session. PubMed queries are built from sanitized medical concepts and never forward raw utterances or slide images to external search. The prior-session index is built from institutional recordings after an automatic redaction pass (phones, dates, addresses, name-like and organization-like spans). Automatic redaction is **not** a guarantee of zero residual identifiers; index access is limited to the institutional Zoom path.

**IRB / oversight.** *[Pending confirmation from Laura Felix / program leadership—do not invent an approval number.]*  
Draft options to choose after Laura replies:

- **If determined not human-subjects research / QI education demo:**  
  “This system demonstration and facilitator feedback were reviewed with the Project ECHO program office. No patients were enrolled for research purposes; identifiable patient information is not reported. Use of de-identified session recordings for the retrieval index follows institutional educational-data practices under [protocol / determination reference from Laura].”

- **If IRB approved / exempt:**  
  “Handling of session media and evaluation activities was conducted under Penn State IRB [ID / exemption # from Laura], with attention to patient privacy in case-based teaching.”

- **If still in process:**  
  “Formal IRB determination for broader research use of session media is in process with the Project ECHO program office; this paper reports only a system demonstration with volunteer staff feedback and de-identified aggregate metrics.”

No identifiable patient data appear in this paper. Facilitator feedback and the September 2026 recording come from a scheduled demonstration with volunteer Project ECHO / ICDS participants; patient case text is not reproduced.

---

## Acknowledgments (small addition)

… We thank **Laura Felix** for guidance on ECHO program practice, session data handling, and IRB/privacy wording. …
