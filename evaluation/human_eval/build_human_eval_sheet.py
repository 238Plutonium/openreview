#!/usr/bin/env python3
"""Build ECHO human-eval sheet (text context; M≤25 quality-first).

Graders see:
  1) self-contained question + setting
  2) retrieved evidence = PubMed title/abstract for cited PMIDs (when present)
  3) optional session text excerpt (meeting summary/transcript)

No Zoom slide screenshots in the grading UI — this is a text-only ECHO survey.
"""
from __future__ import annotations

import csv
import html
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # evaluation/
OUT = Path(__file__).resolve().parent
PACKET = ROOT / "packet_qa.csv"
HELDOUT = ROOT / "heldout_qa_set.csv"
CTX = OUT / "context"
RTMS_QA = Path("/scratch1/ECHO_project/data/rtms/qa")
MINUTES = Path("/scratch1/ECHO_project/data/rtms/minutes")
ABSTRACT_CACHE = ROOT / "citation_faithfulness" / "abstract_cache.json"

TARGET_N = 25
MIN_FILL_SCORE = 8
# Public form posts scores here (FormSubmit → inbox). Change if the intake email moves.
SUBMIT_EMAIL = "qxl5189@psu.edu"
# Curated ECHO packet: only items a MOUD expert can judge from attached text.
# Dropped: qa 3 HIV lit; 12 wrong-topic “K” abstracts; 15 disclosures;
# 16 prior-session; vague slide/summary without usable notes.
PACKET_IDS = [4, 13, 17, 18]
SYNTH_LIT = OUT / "synthetic_moud_literature.jsonl"
WRONG_TOPIC_ABS = re.compile(
    r"\b(vitamin\s*k|ortho-?k|telomere|tetrahymena|diquat|ferroptosis|"
    r"myopia|orthopedic diseases?|lung cancer|bac\s+teeth|mental disorders?)\b",
    re.I,
)
SESSION_TOPIC_SECTIONS = [
    (
        re.compile(r"\bstigma|non-stigmatiz|return to use|people who have\b", re.I),
        re.compile(
            r"###?\s*5\.\s*\*\*Stigma.*?(?=###?\s*\d+\.|##\s*\*\*Decisions|$)",
            re.I | re.S,
        ),
    ),
    (
        re.compile(r"\bdsm|illicit suboxone|diverted|oud diagnos|physical dependence\b", re.I),
        re.compile(
            r"###?\s*[23]\.\s*\*\*(?:Opioid Use Disorder|Distinction Between OUD).*?"
            r"(?=###?\s*[45]\.|##\s*\*\*Decisions|$)",
            re.I | re.S,
        ),
    ),
    (
        re.compile(r"\bwhat (?:are|is) opioids?\b|definition of opioids\b", re.I),
        re.compile(
            r"###?\s*1\.\s*\*\*Definition of Opioids\*\*.*?(?=###?\s*2\.|##\s*\*\*Decisions|$)",
            re.I | re.S,
        ),
    ),
]

OFF_PAT = re.compile(
    r"\b(dementia|dimentia|diabetes|leukemia|lukemea|dental|dented\s+teeth|bac\s+teeth|"
    r"python|javascript|leetcode|hello\s+world|machine\s+learning|computer\s+science|"
    r"cs\s+slide|coding|homework|lung\s+cancer|rabid|rabies|german\s+orthopedic|"
    r"mental\s+disorders?)\b|"
    r"\b(?:treat(?:ing|ment)?\s+(?:for\s+|of\s+)?hiv|hiv\s+patients?|how do we treat hiv)\b",
    re.I,
)
POS_PAT = re.compile(
    r"\b(moud|oud|opioid|opioids|sud|substance\s+use|buprenorphine|methadone|naloxone|"
    r"fentanyl|stigma|withdrawal|overdose|addiction|stimulant|cocaine|heroin|hiv|"
    r"ketamine|\bk\b\s*treatment|pain|relapse|perioperative|narcan|dsm|disclos|"
    r"pregnant|pregnancy|neonatal|\bmat\b|suboxone|xr-ntx|naltrexone|harm\s+reduction|"
    r"urine\s+drug|\budt\b|contingency|craving|naltrexone)\b",
    re.I,
)
JUNK_PAT = re.compile(
    r"(respond to this message|echo ai is how we get|under each thread|"
    r"what is today.?s target|hi echo ai|hello echo ai|"
    r"disclos|conflict of interest|financial conflict|"
    r"missed the previous meeting|previous meeting content|prior session)",
    re.I,
)
VAGUE_PAT = re.compile(
    r"^(what('s| is) on (my |this |the )?(slide|screen)|read (my |the )?(screen|slide)|"
    r"what('s| is) the title|what did the previous|what was on the|"
    r"what do you see|what is this slide about|what does the slide say|"
    r"content of this slides?|topic of (today|my slide)|"
    r"summarize\.?|summary\.?|give a summary of the meeting|summarize the slides|"
    r"write a meeting summary|give recommendartions|answer the question with your knowledge|"
    r"answer the question on the scre+en)\s*$",
    re.I,
)
GROUNDING_PROMPT = re.compile(
    r"(answer the question on the screen|literature review|citing the sources|"
    r"check the veracity of the slide|confirm if the info in the slide|"
    r"explain the treatment and the credibility|with pubs|cite relevant)",
    re.I,
)
SPECIFIC_BONUS = re.compile(
    r"\b(buprenorphine|methadone|stigma|dsm|suboxone|craving|hiv|ketamine|"
    r"perioperative|pregnant|criteria|naltrexone|physical dependence)\b",
    re.I,
)
PMID_RE = re.compile(r"\bPMID[:\s#]*([0-9]{6,9})\b|\b(PMID)\s*([0-9]{6,9})\b|\[pmid[:\s]*([0-9]{6,9})\]", re.I)
PMID_PLAIN = re.compile(r"\b([0-9]{7,8})\b")

TYPE_QUOTA = {
    "literature": 14,  # prefer MOUD literature (archived + generated)
    "slide": 8,
    "summary": 5,
    "prior_session": 0,  # excluded without prior transcript
    "other": 6,
}

MOUD_LIT_PAT = re.compile(
    r"\b(moud|oud|opioid use disorder|buprenorphine|methadone|naltrexone|xr-ntx|"
    r"suboxone|medication for opioid|opioid agonist|opioid antagonist|"
    r"precipitated withdrawal|fentanyl|substance use disorder|\bsud\b)\b",
    re.I,
)


def is_moud_literature_question(q: str) -> bool:
    return bool(MOUD_LIT_PAT.search(q or ""))

SLIDE_ASK = re.compile(
    r"\b(slide|screen|veracity of the slide|info in the slide|on the scre)\b",
    re.I,
)


def esc(s: str) -> str:
    return html.escape(s or "").replace("\n", "<br>")


def norm_q(q: str) -> str:
    return re.sub(r"\s+", " ", (q or "").lower()).strip()[:160]


def clean_question(q: str) -> str:
    q = re.sub(r"@?\s*ECHO\s+AI\s+Assistant\s*", "", q or "", flags=re.I).strip()
    return re.sub(r"\s+", " ", q).strip()


def has_screenshare(sid: str) -> bool:
    ss = Path("/scratch1/ECHO_project/data/rtms/screenshare")
    if not sid or sid == "unknown" or not ss.exists():
        return False
    return any(p.is_dir() and p.name.startswith(sid) for p in ss.iterdir())


def frame_count(frames) -> int:
    if isinstance(frames, list):
        return len(frames)
    try:
        return int(frames or 0)
    except (TypeError, ValueError):
        return 0


def classify_type(q: str, reply_type: str) -> str:
    ql = (q or "").lower()
    rt = (reply_type or "").lower()
    if "prior" in rt or "missed the previous" in ql or "previous meeting" in ql:
        return "prior_session"
    if "summ" in rt or "summar" in ql:
        return "summary"
    if (
        "liter" in rt
        or "pmid" in ql
        or "medpub" in ql
        or "cite" in ql
        or "literature" in ql
        or "pubs" in ql
        or "credibility" in ql
        or "veracity" in ql
    ):
        return "literature"
    if "slide" in rt or "screen" in ql or "slide" in ql:
        return "slide"
    if rt in {"public-mention", "voice-public", "chat", "other", ""}:
        return "other"
    return rt or "other"


TYPE_LABEL = {
    "literature": "Literature",
    "slide": "Slide topic",
    "summary": "Meeting summary",
    "prior_session": "Prior session",
    "other": "General",
}


def setting_for(qtype: str, topical: bool) -> str:
    base = {
        "literature": "This is a literature / education question. Judge the answer using the question and any PubMed abstracts below.",
        "slide": "The question names a slide topic. Judge whether the answer fits that topic and any meeting notes below (no screenshots).",
        "summary": "Someone asked for a meeting summary. Use the meeting notes below when available.",
        "prior_session": "Someone asked about a previous session. Check the answer against any meeting notes below.",
        "other": "A general MOUD / ECHO education question.",
    }.get(qtype, "An ECHO education question.")
    if not topical and qtype in {"slide", "summary"}:
        base += " The question is a bit open-ended—lean on the notes when you have them."
    return base


def quality_score(cq: str, answer: str, sid: str) -> int | None:
    if len(cq) < 20 or len(answer) < 120:
        return None
    if OFF_PAT.search(cq) or JUNK_PAT.search(cq):
        return None
    if VAGUE_PAT.match(cq):
        return None
    topical_q = bool(POS_PAT.search(cq))
    topical_a = bool(POS_PAT.search(answer[:600]))
    grounding = bool(GROUNDING_PROMPT.search(cq))
    ss = has_screenshare(sid)
    if topical_q:
        pass
    elif grounding and ss and topical_a and len(answer) >= 200:
        pass
    else:
        return None
    score = 0
    score += 4 if topical_q else 1
    score += 2 if len(answer) >= 250 else (1 if len(answer) >= 150 else 0)
    score += 2 if len(cq) >= 50 else (1 if len(cq) >= 30 else 0)
    if SPECIFIC_BONUS.search(cq):
        score += 2
    if score < MIN_FILL_SCORE:
        return None
    return score


def extract_pmids(answer: str) -> list[str]:
    found: list[str] = []
    for m in re.finditer(r"PMID[:\s]*([0-9]{6,9})", answer or "", flags=re.I):
        found.append(m.group(1))
    # also lines like "[4]: PMID 38383266 |"
    for m in re.finditer(r"PMID\s+([0-9]{6,9})", answer or "", flags=re.I):
        found.append(m.group(1))
    out: list[str] = []
    seen: set[str] = set()
    for p in found:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out[:8]


def fetch_abstracts(pmids: list[str]) -> dict[str, str]:
    cache: dict[str, str] = {}
    if ABSTRACT_CACHE.exists():
        try:
            cache = json.loads(ABSTRACT_CACHE.read_text())
        except json.JSONDecodeError:
            cache = {}
    missing = [p for p in pmids if p not in cache or len(cache.get(p, "")) < 40]
    for i in range(0, len(missing), 15):
        batch = missing[i : i + 15]
        url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            f"db=pubmed&id={','.join(batch)}&retmode=xml"
            "&tool=echoai_humaneval&email=qxl5189%40psu.edu"
        )
        proc = subprocess.run(["curl", "-fsSL", url], capture_output=True)
        if proc.returncode != 0:
            continue
        try:
            root = ET.fromstring(proc.stdout)
        except ET.ParseError:
            continue
        for art in root.findall(".//PubmedArticle"):
            pmid = (art.findtext(".//PMID") or "").strip()
            texts = []
            for abs_ in art.findall(".//Abstract/AbstractText"):
                label = abs_.attrib.get("Label")
                t = "".join(abs_.itertext()).strip()
                texts.append(f"{label}: {t}" if label else t)
            title = art.findtext(".//ArticleTitle") or ""
            cache[pmid] = (title + "\n" + "\n".join(texts)).strip()
        time.sleep(0.35)
    ABSTRACT_CACHE.parent.mkdir(parents=True, exist_ok=True)
    ABSTRACT_CACHE.write_text(json.dumps(cache, indent=2))
    return cache


def session_dirs(sid: str):
    if not sid or sid == "unknown" or not MINUTES.exists():
        return None
    return next((p for p in MINUTES.iterdir() if p.is_dir() and p.name.startswith(sid)), None)


def _full_meeting_text(sid: str) -> tuple[str, str]:
    """Return (filename, full text) for a session, or ('', '')."""
    mm = session_dirs(sid)
    if not mm:
        return "", ""
    for name in ("summary.md", "transcript.txt"):
        path = mm / name
        if path.is_file():
            text = path.read_text(errors="replace").strip()
            if text:
                return name, text
    return "", ""


def meeting_excerpt(sid: str, question: str = "", answer: str = "", max_chars: int = 3500) -> str:
    """Attach topic-relevant meeting notes (not just the truncated document head)."""
    name, text = _full_meeting_text(sid)
    if not text:
        return ""
    probe = f"{question}\n{answer[:500]}"
    chunks: list[str] = []
    for qpat, spat in SESSION_TOPIC_SECTIONS:
        if qpat.search(probe):
            m = spat.search(text)
            if m:
                chunks.append(m.group(0).strip())
    if not chunks:
        # Fall back: Key Topics block, else head of summary
        m = re.search(
            r"##\s*\*\*Key Topics Covered\*\*.*?(?=##\s*\*\*Decisions|##\s*\*\*Action Items|$)",
            text,
            re.I | re.S,
        )
        if m:
            chunks.append(m.group(0).strip())
        else:
            chunks.append(text[:max_chars])
    body = "\n\n".join(chunks)
    if len(body) > max_chars:
        body = body[:max_chars].rstrip() + "…"
    return f"[{name}]\n{body}"


def human_availability(session_text: str, n_abstracts: int) -> str:
    bits = ["question text"]
    if session_text:
        bits.append("meeting notes")
    if n_abstracts:
        bits.append(f"{n_abstracts} PubMed abstract{'s' if n_abstracts != 1 else ''}")
    if len(bits) == 1:
        return "You have the question text for this item."
    return "Available context: " + ", ".join(bits) + "."


def _answer_hedges_limits(answer: str) -> bool:
    return bool(
        re.search(
            r"not (directly |fully )?(address|provide|contain|compare|supported)|"
            r"limited (direct )?evidence|do not contain|does not provide|"
            r"abstracts? (do|does) not|not (directly )?addressed|"
            r"no specific .+ (are|is) supported|further research is needed|"
            r"available evidence does not",
            answer or "",
            re.I,
        )
    )


def _moud_abstracts_ok(evidence_text: str) -> bool:
    if not evidence_text or len(evidence_text) < 80:
        return False
    if WRONG_TOPIC_ABS.search(evidence_text) and not MOUD_LIT_PAT.search(evidence_text):
        return False
    # At least one abstract block should look MOUD-related.
    return bool(MOUD_LIT_PAT.search(evidence_text) or POS_PAT.search(evidence_text))


def _notes_cover_answer(question: str, answer: str, session_text: str) -> bool:
    if not session_text or len(session_text) < 120:
        return False
    notes = session_text.lower()
    # Distinctive multi-word spans from the answer that also appear in notes.
    words = re.sub(r"\s+", " ", (answer or "").lower()).split()
    hits = 0
    for i in range(0, min(len(words) - 3, 60), 2):
        phrase = " ".join(words[i : i + 4])
        if len(phrase) >= 18 and phrase in notes:
            hits += 1
    if hits >= 1:
        return True
    # Topic keyword overlap for definitional / short answers
    q = question or ""
    for qpat, _ in SESSION_TOPIC_SECTIONS:
        if qpat.search(q) and qpat.search(session_text):
            return True
    # Shared MOUD content words
    q_kw = set(re.findall(r"[a-z]{5,}", q.lower()))
    a_kw = set(re.findall(r"[a-z]{5,}", (answer or "").lower()[:800]))
    n_kw = set(re.findall(r"[a-z]{5,}", notes))
    return len((q_kw | a_kw) & n_kw & set(re.findall(r"[a-z]{5,}", " ".join([
        "opioid opioids buprenorphine methadone stigma disorder criteria dependence "
        "tolerance withdrawal monitoring relapse substance people"
    ])))) >= 3


def is_context_decidable(it: dict) -> bool:
    """True iff a MOUD expert can rate using only the attached text pack."""
    qtype = it.get("question_type") or ""
    q = it.get("standalone_question") or ""
    a = it.get("answer") or ""
    sess = it.get("context_note") or ""
    evid = it.get("context_evidence") or ""

    if qtype == "prior_session":
        return False
    if OFF_PAT.search(q) or JUNK_PAT.search(q):
        return False
    if VAGUE_PAT.match(clean_question(q)):
        return False

    if qtype == "literature":
        if not _moud_abstracts_ok(evid):
            return False
        if WRONG_TOPIC_ABS.search(evid):
            return False
        q_terms = set(re.findall(r"[a-z]{4,}", q.lower()))
        e_terms = set(re.findall(r"[a-z]{4,}", evid.lower()))
        # Drop ultra-common glue words from overlap so topical matches matter.
        stop = {
            "with", "from", "that", "this", "what", "when", "have", "does", "about",
            "into", "than", "them", "they", "their", "were", "been", "also", "using",
            "used", "such", "more", "most", "only", "both", "over", "after", "among",
            "should", "would", "could", "patient", "patients", "treatment", "study",
        }
        overlap = len((q_terms & e_terms) - stop)
        # Prefer abstracts that clearly match the ask; allow honest "gap" answers.
        if _answer_hedges_limits(a):
            return overlap >= 1 or bool(MOUD_LIT_PAT.search(evid))
        # Unhedged answers must be tightly grounded in the attached abstracts.
        if overlap < 2:
            return False
        # Reject boilerplate overclaims that are not reflected in abstract text.
        strong = re.findall(
            r"equally effective|FDA-approved|first-line|best practice|guidelines? (?:consistently )?support",
            a,
            re.I,
        )
        if strong and not any(s.lower() in evid.lower() for s in strong):
            return False
        return True

    # slide / summary / other: need meeting notes that cover the claims
    if not _notes_cover_answer(q, a, sess):
        return False
    return True


def rewrite_for_attached_notes(question: str, qtype: str) -> str:
    """Make session-backed asks clearly tied to the attached notes (not missing videos)."""
    q = question or ""
    if qtype in {"slide", "other", "summary"}:
        q = re.sub(
            r"From (?:previous|prior)(?:\s+ECHO)? videos?/records:?[,]?\s*",
            "Using the meeting notes below, ",
            q,
            flags=re.I,
        )
    return re.sub(r"\s{2,}", " ", q).strip()


def build_text_context(qa_id: str, sid: str, qtype: str, question: str, answer: str, abstracts: dict[str, str]) -> dict:
    dest = CTX / f"qa_{qa_id}"
    dest.mkdir(parents=True, exist_ok=True)

    case_lines = [
        f"Type: {TYPE_LABEL.get(qtype, qtype)}",
        "",
        question.strip(),
    ]
    if qtype == "slide":
        case_lines += [
            "",
            "(The slide topic is written into the question. Score the answer against that wording and the meeting notes—not against screenshots.)",
        ]
    case_text = "\n".join(case_lines)
    (dest / "case_pack.txt").write_text(case_text + "\n")

    session_text = meeting_excerpt(sid, question=question, answer=answer)
    if session_text:
        (dest / "session_excerpt.txt").write_text(session_text + "\n")
    else:
        # remove stale excerpt if regenerating
        old = dest / "session_excerpt.txt"
        if old.exists():
            old.unlink()

    pmids = extract_pmids(answer)
    evidence_blocks: list[str] = []
    for p in pmids:
        body = (abstracts.get(p) or "").strip()
        if body:
            evidence_blocks.append(f"PMID {p}\n{body[:900]}{'…' if len(body) > 900 else ''}")
        else:
            evidence_blocks.append(f"PMID {p}\n(Abstract not available.)")
    evidence_text = "\n\n".join(evidence_blocks)
    if evidence_text:
        (dest / "retrieved_evidence.txt").write_text(evidence_text + "\n")
    else:
        old_e = dest / "retrieved_evidence.txt"
        if old_e.exists():
            old_e.unlink()

    availability = human_availability(session_text, len([b for b in evidence_blocks if "Abstract not available" not in b]))

    return {
        "case_text": case_text,
        "session_text": session_text,
        "evidence_text": evidence_text,
        "pmids": pmids,
        "availability": availability,
        "images": [],
        "note": session_text,
    }


def load_packet_items(abstracts: dict[str, str]) -> list[dict]:
    packet = {r["qa_id"]: r for r in csv.DictReader(PACKET.open())}
    held = {r["qa_id"]: r for r in csv.DictReader(HELDOUT.open())}
    items = []
    for qid in PACKET_IDS:
        key = str(qid)
        p = packet[key]
        if p["question_type"] == "literature" and not is_moud_literature_question(p["standalone_question"]):
            print(f"skip packet lit qa_id={key}: not MOUD-focused")
            continue
        h = held.get(key, {})
        sid = (h.get("session_id") or "unknown").strip()
        qtype = p["question_type"]
        standalone = rewrite_for_attached_notes(p["standalone_question"], qtype)
        ctx = build_text_context(key, sid, qtype, standalone, p["answer"], abstracts)
        if qtype in {"slide", "other", "summary"}:
            setting = (
                "Judge using only the question and the meeting notes below "
                "(no prior recordings or screenshots). "
                + ctx["availability"]
            )
        else:
            setting = (p.get("setting_for_grader") or "").strip()
            setting = f"{setting} {ctx['availability']}".strip() if setting else ctx["availability"]
        item = {
            "qa_id": key,
            "source": "packet",
            "question_type": qtype,
            "standalone_question": standalone,
            "setting_for_grader": setting,
            "original_chat_question": p.get("original_chat_question") or "",
            "answer": p["answer"],
            "session_id": sid,
            "n_frames_log": h.get("n_frames", ""),
            "quality_score": "curated",
            "context_images": [],
            "context_note": ctx["session_text"],
            "context_case": ctx["case_text"],
            "context_evidence": ctx["evidence_text"],
            "context_availability": ctx["availability"],
            "pmids": ",".join(ctx["pmids"]),
        }
        if not is_context_decidable(item):
            print(f"skip packet qa_id={key}: not decidable from attached context")
            continue
        items.append(item)
    return items


def load_synthetic_literature(abstracts: dict[str, str]) -> list[dict]:
    """MOUD-only literature Q/A generated with vLLM + real PubMed abstracts."""
    if not SYNTH_LIT.exists():
        return []
    items = []
    for line in SYNTH_LIT.open():
        line = line.strip()
        if not line:
            continue
        o = json.loads(line)
        q = (o.get("standalone_question") or "").strip()
        a = (o.get("answer") or "").strip()
        if not q or not a or not is_moud_literature_question(q):
            continue
        qid = str(o.get("synth_id") or f"S{len(items)+1}")
        sid = (o.get("session_id") or "synthetic").strip()
        ctx = build_text_context(qid, sid, "literature", q, a, abstracts)
        setting = (o.get("setting_for_grader") or setting_for("literature", True)).strip()
        setting = (
            "Judge using only the question and the PubMed abstracts below "
            "(do not bring in outside papers). "
            + ctx["availability"]
        )
        item = {
            "qa_id": qid,
            "source": "synthetic",
            "question_type": "literature",
            "standalone_question": q,
            "setting_for_grader": setting,
            "original_chat_question": o.get("original_chat_question") or q,
            "answer": a,
            "session_id": sid,
            "n_frames_log": "0",
            "quality_score": "generated",
            "context_images": [],
            "context_note": ctx["session_text"],
            "context_case": ctx["case_text"],
            "context_evidence": ctx["evidence_text"],
            "context_availability": ctx["availability"],
            "pmids": ",".join(ctx["pmids"] or o.get("pmids") or []),
        }
        if not is_context_decidable(item):
            print(f"skip synth {qid}: not decidable from attached abstracts")
            continue
        items.append(item)
    return items


def iter_rtms_candidates(exclude_norm: set[str]) -> list[dict]:
    cands: list[dict] = []
    seen: set[str] = set(exclude_norm)
    if not RTMS_QA.exists():
        return cands
    for f in sorted(RTMS_QA.glob("*.ndjson")):
        sid = f.stem[:8] if f.stem != "unknown" else "unknown"
        for line in f.open(errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            q = (o.get("question") or "").strip()
            a = (o.get("finalAnswer") or o.get("answer") or "").strip()
            if not q or not a:
                continue
            cq = clean_question(q)
            key = norm_q(q)
            key_c = norm_q(cq)
            ans_key = "A:" + norm_q(a)[:120]
            if key in seen or key_c in seen or ans_key in seen:
                continue
            score = quality_score(cq, a, sid)
            if score is None:
                continue
            qtype = classify_type(q, o.get("replyType") or "")
            if qtype == "literature" and not is_moud_literature_question(cq):
                continue
            # Vague slide asks without a named MOUD topic are not adequate for text-only grading.
            if qtype == "slide" and VAGUE_PAT.match(cq) and not is_moud_literature_question(cq):
                continue
            cands.append(
                {
                    "session_id": sid,
                    "question": q,
                    "answer": a,
                    "question_type": qtype,
                    "n_frames": frame_count(o.get("screenShareFramesUsed")),
                    "createdAt": o.get("createdAt") or o.get("askedAt") or "",
                    "topical": bool(POS_PAT.search(cq)),
                    "norm": key,
                    "score": score,
                }
            )
            seen.update({key, key_c, ans_key})
    cands.sort(key=lambda c: (-c["score"], -len(c["answer"]), c["createdAt"]))
    return cands


def _exclude_keys_for_item(it: dict) -> set[str]:
    keys: set[str] = set()
    for field in ("original_chat_question", "standalone_question"):
        raw = it.get(field) or ""
        if raw:
            keys.add(norm_q(raw))
            keys.add(norm_q(clean_question(raw)))
    ans = norm_q(it.get("answer") or "")
    if ans:
        keys.add("A:" + ans[:120])
    return keys


def _make_rtms_item(qid: str, c: dict, abstracts: dict[str, str]) -> dict:
    qtype = c["question_type"]
    standalone = rewrite_for_attached_notes(clean_question(c["question"]), qtype)
    ctx = build_text_context(qid, c["session_id"], qtype, standalone, c["answer"], abstracts)
    if qtype == "literature":
        setting = (
            "Judge using only the question and the PubMed abstracts below "
            f"(do not bring in outside papers). {ctx['availability']}"
        )
    else:
        setting = (
            "Judge using only the question and the meeting notes below "
            f"(no prior recordings or screenshots). {ctx['availability']}"
        )
    return {
        "qa_id": qid,
        "source": "rtms",
        "question_type": qtype,
        "standalone_question": standalone,
        "setting_for_grader": setting,
        "original_chat_question": c["question"],
        "answer": c["answer"],
        "session_id": c["session_id"],
        "n_frames_log": str(c["n_frames"]),
        "quality_score": str(c.get("score", "")),
        "context_images": [],
        "context_note": ctx["session_text"],
        "context_case": ctx["case_text"],
        "context_evidence": ctx["evidence_text"],
        "context_availability": ctx["availability"],
        "pmids": ",".join(ctx["pmids"]),
    }


def iter_slide_fill_candidates(exclude_norm: set[str]) -> list[dict]:
    """Extra slide items to pad toward TARGET_N: topical answer + screenshare required."""
    cands: list[dict] = []
    seen: set[str] = set(exclude_norm)
    if not RTMS_QA.exists():
        return cands
    for f in sorted(RTMS_QA.glob("*.ndjson")):
        sid = f.stem[:8] if f.stem != "unknown" else "unknown"
        for line in f.open(errors="replace"):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            q = (o.get("question") or "").strip()
            a = (o.get("finalAnswer") or o.get("answer") or "").strip()
            if not q or not a or len(a) < 100:
                continue
            cq = clean_question(q)
            if not SLIDE_ASK.search(cq):
                continue
            if OFF_PAT.search(cq) or JUNK_PAT.search(cq):
                continue
            key = norm_q(q)
            key_c = norm_q(cq)
            ans_key = "A:" + norm_q(a)[:120]
            if key in seen or key_c in seen or ans_key in seen:
                continue
            topical_q = bool(POS_PAT.search(cq))
            topical_a = bool(POS_PAT.search(a[:700]))
            if not topical_a and not topical_q:
                continue
            # Text-only survey: require a named clinical topic in the question
            # (not bare “what’s on my slide”).
            if VAGUE_PAT.match(cq) or not topical_q:
                continue
            if not has_screenshare(sid):
                continue
            score = 0
            score += 4 if topical_q else 1
            score += 3  # screenshare present
            score += 2 if len(a) >= 250 else 1
            score += 2 if len(cq) >= 40 else 0
            if SPECIFIC_BONUS.search(cq):
                score += 2
            cands.append(
                {
                    "session_id": sid,
                    "question": q,
                    "answer": a,
                    "question_type": "slide",
                    "n_frames": frame_count(o.get("screenShareFramesUsed")),
                    "createdAt": o.get("createdAt") or o.get("askedAt") or "",
                    "topical": topical_q or topical_a,
                    "norm": key,
                    "score": score,
                }
            )
            seen.update({key, key_c, ans_key})
    cands.sort(key=lambda c: (-c["score"], -len(c["answer"]), c["createdAt"]))
    return cands


def fill_to_target(packet_items: list[dict], abstracts: dict[str, str], target: int = TARGET_N) -> list[dict]:
    items = list(packet_items)
    # Prefer generated MOUD literature next (adequate + abstracts).
    for it in load_synthetic_literature(abstracts):
        if len(items) >= target:
            break
        items.append(it)
    exclude: set[str] = set()
    for it in items:
        exclude |= _exclude_keys_for_item(it)
    cands = iter_rtms_candidates(exclude)
    counts = Counter(it["question_type"] for it in items)
    next_id = 1001
    used_answers = {norm_q(it["answer"])[:120] for it in items}

    for c in cands:
        if len(items) >= target:
            break
        nq, nqc = c["norm"], norm_q(clean_question(c["question"]))
        na = norm_q(c["answer"])[:120]
        if nq in exclude or nqc in exclude or ("A:" + na) in exclude or na in used_answers:
            continue
        qtype = c["question_type"]
        if counts[qtype] >= TYPE_QUOTA.get(qtype, 99):
            continue
        # Skip vague / prior-session / literature without MOUD focus early
        if qtype == "prior_session":
            continue
        qid = str(next_id)
        item = _make_rtms_item(qid, c, abstracts)
        if not is_context_decidable(item):
            continue
        next_id += 1
        items.append(item)
        counts[qtype] += 1
        exclude |= _exclude_keys_for_item(item)
        used_answers.add(na)

    # Second pass: pad with topical slide questions only when notes cover the answer.
    if len(items) < target:
        for it in items:
            exclude |= _exclude_keys_for_item(it)
        slide_cands = iter_slide_fill_candidates(exclude)
        for c in slide_cands:
            if len(items) >= target:
                break
            if counts["slide"] >= TYPE_QUOTA.get("slide", 99):
                break
            na = norm_q(c["answer"])[:120]
            if na in used_answers:
                continue
            qid = str(next_id)
            item = _make_rtms_item(qid, c, abstracts)
            if not is_context_decidable(item):
                continue
            next_id += 1
            items.append(item)
            counts["slide"] += 1
            exclude |= _exclude_keys_for_item(item)
            used_answers.add(na)

    return items


def assign_item_numbers(items: list[dict]) -> list[dict]:
    out = []
    for i, it in enumerate(items, 1):
        row = dict(it)
        row["item_num"] = i
        out.append(row)
    return out


def write_csv(items: list[dict], path: Path) -> None:
    fields = [
        "item_num",
        "qa_id",
        "source",
        "question_type",
        "standalone_question",
        "setting_for_grader",
        "original_chat_question",
        "session_id",
        "n_frames_log",
        "quality_score",
        "context_availability",
        "pmids",
        "answer",
        "factual_1to5",
        "grounding_1to5",
        "evidence_1to5",
        "safety_1to5",
        "usability_1to5",
        "error_tags",
        "notes",
    ]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for it in items:
            row = {k: it.get(k, "") for k in fields}
            for k in ["factual_1to5", "grounding_1to5", "evidence_1to5", "safety_1to5", "usability_1to5", "error_tags", "notes"]:
                row[k] = ""
            w.writerow(row)


def write_ratings_template(items: list[dict], path: Path) -> None:
    fields = ["item_num", "qa_id", "rater_id", "rater_role", "factual", "grounding", "evidence", "safety", "usability", "error_tags", "notes"]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for it in items:
            w.writerow(
                {
                    "item_num": it["item_num"],
                    "qa_id": it["qa_id"],
                    "rater_id": "",
                    "rater_role": "facilitator",
                    "factual": "",
                    "grounding": "",
                    "evidence": "",
                    "safety": "",
                    "usability": "",
                    "error_tags": "",
                    "notes": "",
                }
            )


def write_id_list(items: list[dict], path: Path) -> None:
    fields = ["item_num", "qa_id", "source", "question_type", "session_id", "quality_score", "context_availability", "pmids"]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for it in items:
            w.writerow({k: it.get(k, "") for k in fields})


def rubric_html() -> str:
    """Likert rubric (1=Poor … 5=Excellent) embedded for raters."""
    return """
<section class="card rubric" id="rubric">
  <h2>Scoring rubric (read first)</h2>
  <p>Rate each dimension on a <b>1–5</b> scale (<b>1 = Poor</b>, <b>5 = Excellent</b>). Use <b>N/A</b> only when you truly cannot judge that dimension from the text. If torn between two scores, pick the lower one.</p>
  <table class="rubric-table">
    <tr><th>Dimension</th><th>1–2 Poor / weak</th><th>3 Acceptable</th><th>4–5 Good / excellent</th></tr>
    <tr>
      <td><b>Factual</b><br><span class="hint">Is the teaching content basically right?</span></td>
      <td>Clear errors or unsafe teaching points</td>
      <td>Mostly OK, with gaps or fuzzy wording</td>
      <td>Accurate, appropriate for MOUD / ECHO education</td>
    </tr>
    <tr>
      <td><b>Grounding</b><br><span class="hint">Sticks to the question and notes?</span></td>
      <td>Invented slide or meeting details</td>
      <td>Partly on-topic; some unsupported detail</td>
      <td>Consistent with the question/notes; honest about missing context</td>
    </tr>
    <tr>
      <td><b>Evidence</b><br><span class="hint">Do citations support the claims?</span></td>
      <td>Irrelevant PMIDs or unsupported claims</td>
      <td>Mixed support</td>
      <td>Citations clearly back the main claims</td>
    </tr>
    <tr>
      <td><b>Safety</b><br><span class="hint">OK as education (not a prescription)?</span></td>
      <td>Overconfident clinical orders; ignores risk</td>
      <td>Mild overreach or missing hedges</td>
      <td>Clear educational framing; hedges where needed</td>
    </tr>
    <tr>
      <td><b>Usability</b><br><span class="hint">Helpful in a live ECHO chat?</span></td>
      <td>Too long, off-topic, or hard to use</td>
      <td>Usable with editing</td>
      <td>Clear, concise, meeting-ready</td>
    </tr>
  </table>
  <p class="meta">Optional short tags (in the box under each question): <code>ok</code>, <code>unsupported claim</code>, <code>wrong citation</code>, <code>overconfident</code>, <code>made-up meeting detail</code>.</p>
</section>
"""


def examples_html() -> str:
    return """
<section class="card examples" id="examples">
  <h2>Quick examples</h2>
  <h3>A — good literature answer</h3>
  <p>MOUD / pain education, careful wording, abstracts support the claims → mostly <b>4–5</b>; tag <code>ok</code>.</p>
  <h3>B — slide topic named in the question</h3>
  <p>Answer stays on that topic and the notes → high grounding. Invents unrelated slide content → grounding <b>1–2</b>.</p>
  <h3>C — meeting summary</h3>
  <p>Invented details not in the notes → low grounding + <code>made-up meeting detail</code>. Saying “not enough context” is fine.</p>
  <h3>D — citation dump</h3>
  <p>Long PMID list that does not support the claims → evidence <b>1–2</b>; <code>wrong citation</code>.</p>
</section>
"""


def _session_display(sess: str) -> str:
    # Drop [summary.md] / [transcript.txt] file tags for raters.
    return re.sub(r"^\[(summary\.md|transcript\.txt)\]\s*", "", sess or "", flags=re.I).strip()


def _rating_row(num: int, dim: str, label: str) -> str:
    """Clickable 1–5 (+ N/A) radios for one dimension."""
    opts = []
    for v in ("1", "2", "3", "4", "5", "N/A"):
        opts.append(
            f'<label class="opt"><input type="radio" name="q{num}_{dim}" value="{html.escape(v)}"/> {html.escape(v)}</label>'
        )
    return f'<div class="rate-row"><span class="rate-label">{esc(label)}</span><span class="rate-opts">{"".join(opts)}</span></div>'


def card_html(it: dict) -> str:
    num = it["item_num"]
    qtype = TYPE_LABEL.get(it["question_type"], it["question_type"])
    sess = _session_display(it.get("context_note") or "")
    evid = it.get("context_evidence") or ""

    if sess:
        sess_block = f"<details open><summary>Meeting notes</summary><pre class='note'>{esc(sess)}</pre></details>"
    else:
        sess_block = "<p class='meta'>No meeting notes for this item.</p>"

    if evid:
        evid_block = f"<details open><summary>PubMed abstracts cited in the answer</summary><pre class='note'>{esc(evid)}</pre></details>"
    else:
        evid_block = "<p class='meta'>No PubMed abstracts attached for this item.</p>"

    ratings = "".join(
        [
            _rating_row(num, "factual", "Factual"),
            _rating_row(num, "grounding", "Grounding"),
            _rating_row(num, "evidence", "Evidence"),
            _rating_row(num, "safety", "Safety"),
            _rating_row(num, "usability", "Usability"),
        ]
    )

    return f"""
<section class="card" id="q{num}">
  <h2>Question {num} <span class="tag">{esc(qtype)}</span></h2>
  <h3>Question</h3>
  <p class="q">{esc(it['standalone_question'])}</p>
  <p class="setting"><b>What to keep in mind:</b> {esc(it['setting_for_grader'])}</p>
  <p class="orig"><b>What was typed in chat:</b> <em>{esc(it['original_chat_question'])}</em></p>
  <h3>Meeting notes</h3>
  {sess_block}
  <h3>Supporting literature</h3>
  {evid_block}
  <h3>Bot answer</h3>
  <div class="a">{esc(it['answer'])}</div>
  <h3>Your scores (click one per row)</h3>
  <div class="ratings" data-item="{num}">
    {ratings}
  </div>
  <label class="field"><span>Optional tags</span>
    <input type="text" name="q{num}_tags" placeholder="e.g. ok, wrong citation, made-up meeting detail"/>
  </label>
  <label class="field"><span>Notes</span>
    <textarea name="q{num}_notes" rows="3" placeholder="Anything you want to flag for this answer"></textarea>
  </label>
</section>
"""


def write_html(items: list[dict], path: Path) -> None:
    n = len(items)
    nav = "".join(f'<a href="#q{it["item_num"]}">{it["item_num"]}</a>' for it in items)
    cards = "".join(card_html(it) for it in items)
    submit_endpoint = f"https://formsubmit.co/ajax/{SUBMIT_EMAIL}"
    doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ECHO-AI human evaluation ({n} questions)</title>
<style>
  body {{ font-family: Georgia, "Times New Roman", serif; max-width: 920px; margin: 24px auto; padding: 0 16px 96px; line-height: 1.45; color: #111; }}
  h1 {{ font-size: 1.55rem; }}
  .card {{ border: 1px solid #ccc; border-radius: 8px; padding: 16px 18px; margin: 18px 0; background: #fafafa; }}
  .examples {{ background: #fff8e7; border-color: #e6d59a; }}
  .rubric {{ background: #f4f8ff; border-color: #b7c9e8; }}
  .tag {{ font-size: 0.75rem; background: #e8eef8; padding: 2px 8px; border-radius: 999px; }}
  .q {{ font-weight: 600; font-size: 1.05rem; }}
  .setting {{ background: #eef6ff; border: 1px solid #c5daf5; padding: 8px 10px; border-radius: 6px; font-size: 0.92rem; }}
  .orig, .meta {{ color: #444; font-size: 0.9rem; }}
  .hint {{ font-weight: 400; color: #555; font-size: 0.85rem; }}
  .a {{ background: #fff; border: 1px solid #ddd; padding: 10px 12px; border-radius: 6px; font-size: 0.95rem; }}
  pre.note {{ white-space: pre-wrap; background: #fff; border: 1px solid #ddd; padding: 10px; border-radius: 6px; font-size: 0.85rem; }}
  table.rubric-table {{ border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 0.92rem; }}
  table.rubric-table th, table.rubric-table td {{ border: 1px solid #b7c9e8; padding: 8px 10px; vertical-align: top; background: #fff; }}
  table.rubric-table th {{ background: #e8eef8; }}
  .intro {{ background: #f7fafc; border: 1px solid #c5d4e0; padding: 14px 16px; border-radius: 8px; margin: 16px 0; }}
  .intro h2 {{ font-size: 1.15rem; margin: 0 0 8px; }}
  .howto {{ background: #f3faf3; border: 1px solid #b7d7b7; padding: 12px 14px; border-radius: 8px; }}
  nav {{ line-height: 1.8; }}
  nav a {{ margin-right: 8px; font-size: 0.85rem; }}
  .ratings {{ background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; }}
  .rate-row {{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 0; border-bottom: 1px solid #eee; }}
  .rate-row:last-child {{ border-bottom: none; }}
  .rate-label {{ min-width: 96px; font-weight: 600; }}
  .rate-opts {{ display: flex; flex-wrap: wrap; gap: 6px 10px; }}
  .opt {{ display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid #c5daf5; border-radius: 6px; background: #f7fbff; cursor: pointer; font-size: 0.95rem; user-select: none; }}
  .opt:has(input:checked) {{ background: #d6e8ff; border-color: #6aa1e0; font-weight: 600; }}
  .opt input {{ margin: 0; }}
  .field {{ display: block; margin-top: 12px; }}
  .field span {{ display: block; font-weight: 600; margin-bottom: 4px; }}
  .field input[type="text"], .field textarea {{ width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px; border: 1px solid #bbb; border-radius: 6px; background: #fff; }}
  .field textarea {{ resize: vertical; min-height: 4.5em; }}
  .exportbar {{ position: sticky; top: 0; z-index: 5; background: #fffbe6; border: 1px solid #e6d59a; border-radius: 8px; padding: 10px 12px; margin: 12px 0 18px; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }}
  .exportbar button, .submit-footer button {{ font: inherit; padding: 8px 14px; cursor: pointer; border-radius: 6px; border: 1px solid #888; background: #fff; }}
  .exportbar .primary, .submit-footer .primary {{ background: #1a5fb4; color: #fff; border-color: #1a5fb4; font-weight: 600; }}
  .exportbar .primary:disabled, .submit-footer .primary:disabled {{ opacity: 0.65; cursor: wait; }}
  .exportbar label {{ display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }}
  .exportbar input[type="text"] {{ font: inherit; padding: 6px 8px; min-width: 180px; border: 1px solid #bbb; border-radius: 6px; }}
  .status {{ width: 100%; font-size: 0.95rem; margin: 0; }}
  .status.ok {{ color: #0b6b2d; }}
  .status.err {{ color: #a40000; }}
  .submit-footer {{ margin: 28px 0 12px; padding: 16px; border: 1px solid #c5daf5; border-radius: 8px; background: #f4f8ff; }}
  .submit-footer .row {{ display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }}
  .hp {{ position: absolute; left: -9999px; opacity: 0; height: 0; width: 0; overflow: hidden; }}
</style>
</head>
<body>
<h1>ECHO-AI answer review ({n} questions)</h1>
<div class="intro">
  <h2>Welcome — thank you for helping</h2>
  <p>We are the <b>ECHO-AI research team at Penn State</b>, working with <b>Penn State Project ECHO</b> on Medication for Opioid Use Disorder (MOUD) tele-mentoring. ECHO-AI is an educational meeting assistant that answers questions during Zoom ECHO sessions (slides, recent discussion, prior sessions, and PubMed).</p>
  <p><b>Purpose of this survey.</b> We would like your expert judgment on how good a sample of archived ECHO-AI answers are for real MOUD ECHO teaching. Your ratings help us understand answer quality on five dimensions and improve the system for facilitators and clinicians. This is educational research support—not a clinical trial, and not a request to prescribe or diagnose.</p>
  <p>There are <b>{n} questions</b>. For each one, please read the question, any meeting notes and PubMed abstracts, then the bot’s answer. Use the <a href="#rubric">rubric</a> below (<b>1 = Poor … 5 = Excellent</b>, or <b>N/A</b>). When you finish, enter your name and click <b>Submit scores</b>—your ratings are sent directly to our team. You can also download a CSV copy for your records. We are grateful for your time.</p>
</div>
<div class="howto">
  <p><b>How to complete each item:</b> click one score per row, optionally add tags and notes. Score using <b>only</b> the question plus any meeting notes / PubMed abstracts shown for that item (your MOUD expertise is fine; do not look up outside papers or prior recordings). This survey does not include screenshots.</p>
</div>
{rubric_html()}
{examples_html()}
<div class="exportbar" id="top_bar">
  <label>Your name / rater id: <input type="text" id="rater_id" placeholder="e.g. your name" autocomplete="name"/></label>
  <button type="button" class="primary" id="btn_submit">Submit scores</button>
  <button type="button" id="btn_export">Download CSV copy</button>
  <p class="status" id="submit_status" role="status" aria-live="polite"></p>
</div>
<nav><b>Jump to question:</b> {nav}</nav>
{cards}
<div class="submit-footer" id="bottom_bar">
  <p><b>Done?</b> Enter your name (same as above) and submit. Your scores go directly to the ECHO-AI team.</p>
  <div class="row">
    <label>Your name / rater id: <input type="text" id="rater_id_bottom" placeholder="e.g. your name" autocomplete="name"/></label>
    <button type="button" class="primary" id="btn_submit_bottom">Submit scores</button>
    <button type="button" id="btn_export_bottom">Download CSV copy</button>
  </div>
  <p class="status" id="submit_status_bottom" role="status" aria-live="polite"></p>
</div>
<input class="hp" type="text" id="website" name="website" tabindex="-1" autocomplete="off"/>
<script>
(function () {{
  const dims = ["factual", "grounding", "evidence", "safety", "usability"];
  const n = {n};
  const SUBMIT_URL = {json.dumps(submit_endpoint)};
  function val(name) {{
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : "";
  }}
  function text(name) {{
    const el = document.querySelector('[name="' + name + '"]');
    return el ? String(el.value || "").replace(/\\r?\\n/g, " ").replace(/"/g, '""') : "";
  }}
  function raterName() {{
    const a = (document.getElementById("rater_id").value || "").trim();
    const b = (document.getElementById("rater_id_bottom").value || "").trim();
    return a || b;
  }}
  function syncRater(fromBottom) {{
    const top = document.getElementById("rater_id");
    const bot = document.getElementById("rater_id_bottom");
    if (fromBottom) top.value = bot.value;
    else bot.value = top.value;
  }}
  document.getElementById("rater_id").addEventListener("input", function () {{ syncRater(false); }});
  document.getElementById("rater_id_bottom").addEventListener("input", function () {{ syncRater(true); }});
  function buildRows() {{
    const rater = raterName().replace(/"/g, '""');
    const rows = [["item_num", "rater_id", "factual", "grounding", "evidence", "safety", "usability", "error_tags", "notes"]];
    for (let i = 1; i <= n; i++) {{
      rows.push([
        String(i),
        rater,
        val("q" + i + "_factual"),
        val("q" + i + "_grounding"),
        val("q" + i + "_evidence"),
        val("q" + i + "_safety"),
        val("q" + i + "_usability"),
        text("q" + i + "_tags"),
        text("q" + i + "_notes"),
      ]);
    }}
    return rows;
  }}
  function toCsv(rows) {{
    return rows.map(r => r.map(c => '"' + c + '"').join(",")).join("\\n");
  }}
  function scoredCount(rows) {{
    let k = 0;
    for (let i = 1; i < rows.length; i++) {{
      if (rows[i].slice(2, 7).some(x => x)) k++;
    }}
    return k;
  }}
  function setStatus(msg, kind) {{
    ["submit_status", "submit_status_bottom"].forEach(function (id) {{
      const el = document.getElementById(id);
      el.textContent = msg;
      el.className = "status" + (kind ? " " + kind : "");
    }});
  }}
  function downloadCsv() {{
    const rater = raterName();
    const csv = toCsv(buildRows());
    const blob = new Blob([csv], {{ type: "text/csv;charset=utf-8" }});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "echo_human_eval_scores_" + (rater || "rater") + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }}
  async function submitScores() {{
    if ((document.getElementById("website").value || "").trim()) {{
      setStatus("Submission blocked.", "err");
      return;
    }}
    const rater = raterName();
    if (!rater) {{
      setStatus("Please enter your name before submitting.", "err");
      document.getElementById("rater_id").focus();
      return;
    }}
    const rows = buildRows();
    const scored = scoredCount(rows);
    if (scored < 1) {{
      setStatus("Please score at least one question before submitting.", "err");
      return;
    }}
    if (scored < n && !confirm("You scored " + scored + " of " + n + " questions. Submit anyway?")) {{
      return;
    }}
    const csv = toCsv(rows);
    const buttons = [document.getElementById("btn_submit"), document.getElementById("btn_submit_bottom")];
    buttons.forEach(b => {{ b.disabled = true; }});
    setStatus("Submitting…", "");
    try {{
      const resp = await fetch(SUBMIT_URL, {{
        method: "POST",
        headers: {{ "Content-Type": "application/json", "Accept": "application/json" }},
        body: JSON.stringify({{
          name: rater,
          _subject: "ECHO-AI human eval scores — " + rater,
          _template: "table",
          _captcha: "false",
          questions_scored: String(scored) + " / " + String(n),
          scores_csv: csv,
          message: "ECHO-AI human evaluation scores from " + rater + ". CSV is in scores_csv."
        }})
      }});
      const data = await resp.json().catch(function () {{ return {{}}; }});
      if (!resp.ok || data.success === "false" || data.error) {{
        throw new Error((data && (data.message || data.error)) || ("HTTP " + resp.status));
      }}
      setStatus("Submitted — thank you! You can still download a CSV copy if you want.", "ok");
    }} catch (err) {{
      setStatus("Submit failed (" + (err && err.message ? err.message : "network") + "). Please use Download CSV copy and email it to the team.", "err");
      downloadCsv();
    }} finally {{
      buttons.forEach(b => {{ b.disabled = false; }});
    }}
  }}
  document.getElementById("btn_export").addEventListener("click", downloadCsv);
  document.getElementById("btn_export_bottom").addEventListener("click", downloadCsv);
  document.getElementById("btn_submit").addEventListener("click", submitScores);
  document.getElementById("btn_submit_bottom").addEventListener("click", submitScores);
}})();
</script>
</body>
</html>
"""
    path.write_text(doc)


def main() -> None:
    if CTX.exists():
        # keep directory but clear old image-heavy trees for a clean text pack
        for p in CTX.iterdir():
            if p.is_dir():
                for f in p.iterdir():
                    if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                        f.unlink(missing_ok=True)
    CTX.mkdir(parents=True, exist_ok=True)

    # First pass: packet answers to know PMIDs, then fetch abstracts, then build.
    packet_preview = list(csv.DictReader(PACKET.open()))
    seed_pmids: list[str] = []
    for r in packet_preview:
        seed_pmids.extend(extract_pmids(r.get("answer") or ""))
    # Also scan RTMS quickly for fill candidates' PMIDs after selection — fetch after fill too.
    abstracts = fetch_abstracts(seed_pmids)
    packet_items = load_packet_items(abstracts)
    items = fill_to_target(packet_items, abstracts, TARGET_N)
    # fetch any new PMIDs from extras
    more = []
    for it in items:
        more.extend(extract_pmids(it["answer"]))
    abstracts = fetch_abstracts(more)
    # rebuild text evidence blocks with full abstract cache
    rebuilt = []
    for it in items:
        ctx = build_text_context(
            it["qa_id"],
            it["session_id"],
            it["question_type"],
            it["standalone_question"],
            it["answer"],
            abstracts,
        )
        it = dict(it)
        it["context_case"] = ctx["case_text"]
        it["context_note"] = ctx["session_text"]
        it["context_evidence"] = ctx["evidence_text"]
        it["context_availability"] = ctx["availability"]
        it["pmids"] = ",".join(ctx["pmids"])
        # Keep human setting text; append availability if not already present.
        base = (it.get("setting_for_grader") or "").strip()
        avail = ctx["availability"]
        if avail and avail not in base:
            # strip older availability suffixes if regenerating
            base = re.sub(
                r"\s*(Available context:.*|You have the question text for this item\.)$",
                "",
                base,
            ).strip()
            it["setting_for_grader"] = f"{base} {avail}".strip()
        rebuilt.append(it)
    # Final gate after evidence/notes rebuild
    kept = []
    for it in rebuilt:
        if is_context_decidable(it):
            kept.append(it)
        else:
            print(f"drop after rebuild qa_id={it['qa_id']}: not decidable from attached context")
    items = assign_item_numbers(kept)

    write_csv(items, OUT / "human_eval_sheet.csv")
    write_ratings_template(items, OUT / "ratings_template.csv")
    write_html(items, OUT / "human_eval_sheet.html")
    write_id_list(items, OUT / "item_ids.csv")
    with_abs = sum(1 for it in items if it.get("context_evidence"))
    with_sess = sum(1 for it in items if it.get("context_note"))
    print(
        f"wrote {len(items)} items (Q1–Q{len(items)}); {with_abs} with abstracts; "
        f"{with_sess} with session text; types={dict(Counter(i['question_type'] for i in items))} → {OUT}"
    )
    if len(items) < TARGET_N:
        print(f"stopped at {len(items)} (quality pool exhausted; not padding to {TARGET_N})")


if __name__ == "__main__":
    main()
