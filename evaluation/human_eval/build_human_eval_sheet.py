#!/usr/bin/env python3
"""Build MedTutor-style ECHO human-eval sheet (text case context; M≤25 quality-first).

Graders see:
  1) case pack = self-contained question + setting
  2) retrieved evidence = PubMed title/abstract for cited PMIDs (when present)
  3) optional session text excerpt (meeting summary/transcript)

No Zoom slide screenshots in the grading UI (MedTutor uses text case reports, not live slides).
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
PACKET_IDS = [3, 4, 12, 13, 15, 16, 17, 18, 30, 33, 34, 35, 36]

OFF_PAT = re.compile(
    r"\b(dementia|dimentia|diabetes|leukemia|lukemea|dental|dented\s+teeth|bac\s+teeth|"
    r"python|javascript|leetcode|hello\s+world|machine\s+learning|computer\s+science|"
    r"cs\s+slide|coding|homework|lung\s+cancer|rabid|rabies|german\s+orthopedic|"
    r"mental\s+disorders?)\b",
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
    r"what is today.?s target|hi echo ai|hello echo ai)",
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
    "literature": 6,
    "slide": 8,
    "summary": 5,
    "prior_session": 2,
    "other": 6,
}


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


def setting_for(qtype: str, topical: bool) -> str:
    base = {
        "literature": "Literature / education ask (MedTutor-style: judge against case text + cited abstracts).",
        "slide": "Slide-topic ask stated in the question text. Grade consistency with that stated case; no screenshot panel.",
        "summary": "In-meeting summary ask. Use session text excerpt when present.",
        "prior_session": "Prior-session recall. Grade claimed prior-session content against available session text.",
        "other": "General MOUD/ECHO educational ask.",
    }.get(qtype, "ECHO educational ask.")
    if not topical and qtype in {"slide", "summary"}:
        base += " Topical MOUD keywords in the question may be weak; rely on case + session text."
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


def meeting_excerpt(sid: str, max_chars: int = 1200) -> str:
    mm = session_dirs(sid)
    if not mm:
        return ""
    for name in ("summary.md", "transcript.txt"):
        path = mm / name
        if path.is_file():
            text = path.read_text(errors="replace").strip()
            if not text:
                continue
            if len(text) > max_chars:
                text = text[:max_chars].rstrip() + "…"
            return f"[{name}]\n{text}"
    return ""


def build_text_context(qa_id: str, sid: str, qtype: str, question: str, answer: str, abstracts: dict[str, str]) -> dict:
    dest = CTX / f"qa_{qa_id}"
    dest.mkdir(parents=True, exist_ok=True)

    case_lines = [
        "CASE PACK (MedTutor-style text context for the grader)",
        f"Question type: {qtype}",
        f"Session id: {sid}",
        "",
        "Case / self-contained question:",
        question.strip(),
    ]
    if qtype == "slide":
        case_lines += [
            "",
            "Note: This is a slide-topic item. The slide topic is named in the question text above. "
            "Judge whether the answer is consistent with that stated case (as MedTutor judges against a text case report). "
            "Do not require Zoom screenshots.",
        ]
    case_text = "\n".join(case_lines)
    (dest / "case_pack.txt").write_text(case_text + "\n")

    session_text = meeting_excerpt(sid)
    if session_text:
        (dest / "session_excerpt.txt").write_text(session_text + "\n")

    pmids = extract_pmids(answer)
    evidence_blocks: list[str] = []
    for p in pmids:
        body = (abstracts.get(p) or "").strip()
        if body:
            evidence_blocks.append(f"PMID {p}\n{body[:900]}{'…' if len(body) > 900 else ''}")
        else:
            evidence_blocks.append(f"PMID {p}\n[abstract not retrieved]")
    evidence_text = "\n\n".join(evidence_blocks)
    if evidence_text:
        (dest / "retrieved_evidence.txt").write_text(evidence_text + "\n")

    parts = []
    if session_text:
        parts.append("session text excerpt")
    if evidence_blocks:
        parts.append(f"{len(evidence_blocks)} PubMed abstract(s)")
    parts.append("case pack (question text)")
    availability = "; ".join(parts)

    return {
        "case_text": case_text,
        "session_text": session_text,
        "evidence_text": evidence_text,
        "pmids": pmids,
        "availability": availability,
        "images": [],  # MedTutor-style: no screenshot panel
        "note": session_text,
    }


def load_packet_items(abstracts: dict[str, str]) -> list[dict]:
    packet = {r["qa_id"]: r for r in csv.DictReader(PACKET.open())}
    held = {r["qa_id"]: r for r in csv.DictReader(HELDOUT.open())}
    items = []
    for qid in PACKET_IDS:
        key = str(qid)
        p = packet[key]
        h = held.get(key, {})
        sid = (h.get("session_id") or "unknown").strip()
        ctx = build_text_context(key, sid, p["question_type"], p["standalone_question"], p["answer"], abstracts)
        setting = (p.get("setting_for_grader") or "").strip()
        setting = f"{setting} Text context: {ctx['availability']}."
        items.append(
            {
                "qa_id": key,
                "source": "packet",
                "question_type": p["question_type"],
                "standalone_question": p["standalone_question"],
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
        )
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
            cands.append(
                {
                    "session_id": sid,
                    "question": q,
                    "answer": a,
                    "question_type": classify_type(q, o.get("replyType") or ""),
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


def fill_to_target(packet_items: list[dict], abstracts: dict[str, str], target: int = TARGET_N) -> list[dict]:
    items = list(packet_items)
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
        qid = str(next_id)
        next_id += 1
        standalone = clean_question(c["question"])
        ctx = build_text_context(qid, c["session_id"], qtype, standalone, c["answer"], abstracts)
        setting = setting_for(qtype, c["topical"]) + f" Text context: {ctx['availability']}."
        item = {
            "qa_id": qid,
            "source": "rtms",
            "question_type": qtype,
            "standalone_question": standalone,
            "setting_for_grader": setting,
            "original_chat_question": c["question"],
            "answer": c["answer"],
            "session_id": c["session_id"],
            "n_frames_log": str(c["n_frames"]),
            "quality_score": str(c["score"]),
            "context_images": [],
            "context_note": ctx["session_text"],
            "context_case": ctx["case_text"],
            "context_evidence": ctx["evidence_text"],
            "context_availability": ctx["availability"],
            "pmids": ",".join(ctx["pmids"]),
        }
        items.append(item)
        counts[qtype] += 1
        exclude |= _exclude_keys_for_item(item)
        used_answers.add(na)
    return items


def write_csv(items: list[dict], path: Path) -> None:
    fields = [
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
    fields = ["qa_id", "rater_id", "rater_role", "factual", "grounding", "evidence", "safety", "usability", "error_tags", "notes"]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for it in items:
            w.writerow({"qa_id": it["qa_id"], "rater_id": "", "rater_role": "facilitator", "factual": "", "grounding": "", "evidence": "", "safety": "", "usability": "", "error_tags": "", "notes": ""})


def write_id_list(items: list[dict], path: Path) -> None:
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["qa_id", "source", "question_type", "session_id", "quality_score", "context_availability", "pmids"])
        w.writeheader()
        for it in items:
            w.writerow({k: it.get(k, "") for k in ["qa_id", "source", "question_type", "session_id", "quality_score", "context_availability", "pmids"]})


def examples_html() -> str:
    return """
<section class="card examples" id="examples">
  <h2>Annotation examples (MedTutor-style)</h2>
  <p>Score each axis <b>1–5</b>. Optional tags: <code>ok</code>, <code>unsupported_claim</code>, <code>irrelevant_pmid</code>, <code>overconfident</code>, <code>weak_case_grounding</code>, <code>hallucinated_session</code>.</p>
  <h3>Example A — literature + abstracts</h3>
  <p>Case asks for MOUD/pain/SUD education. Answer hedges; cited abstracts support claims → factual/evidence/safety/usability <b>4–5</b>; tags <code>ok</code>.</p>
  <h3>Example B — slide-topic stated in the case text</h3>
  <p>Question names the slide topic (e.g. DSM / stigma). Answer matches that stated topic and session excerpt → high grounding. Invents unrelated slide content → grounding <b>1–2</b>, tag <code>weak_case_grounding</code>.</p>
  <h3>Example C — summary / prior session</h3>
  <p>Use the session text excerpt when present. If the bot invents specific meeting details absent from the excerpt → tag <code>hallucinated_session</code> and keep grounding low. Honest abstention is not punished.</p>
  <h3>Example D — citation dump</h3>
  <p>PMIDs whose abstracts do not support the claims → evidence <b>1–2</b>, tag <code>irrelevant_pmid</code>.</p>
</section>
"""


def card_html(it: dict) -> str:
    qid = it["qa_id"]
    case = it.get("context_case") or ""
    sess = it.get("context_note") or ""
    evid = it.get("context_evidence") or ""

    case_block = f"<pre class='note'>{esc(case)}</pre>" if case else "<p class='warn'>No case pack.</p>"
    sess_block = (
        f"<details open><summary>Session text excerpt (like MedTutor case-adjacent notes)</summary><pre class='note'>{esc(sess)}</pre></details>"
        if sess
        else "<p class='meta'>No meeting summary/transcript excerpt for this session id.</p>"
    )
    evid_block = (
        f"<details open><summary>Retrieved evidence — PubMed title/abstract</summary><pre class='note'>{esc(evid)}</pre></details>"
        if evid
        else "<p class='meta'>No PMIDs / abstracts attached (non-literature or uncited answer).</p>"
    )

    return f"""
<section class="card" id="q{qid}">
  <h2>Question {qid} <span class="tag">{esc(it['question_type'])}</span> <span class="tag src">{esc(it.get('source') or '')}</span></h2>
  <h3>1. Case pack</h3>
  <p class="q">{esc(it['standalone_question'])}</p>
  <p class="setting"><b>Setting:</b> {esc(it['setting_for_grader'])}</p>
  <p class="orig"><b>Original chat:</b> <em>{esc(it['original_chat_question'])}</em></p>
  <p class="meta">session_id=<code>{esc(it['session_id'])}</code> · quality={esc(str(it.get('quality_score','')))} · {esc(it['context_availability'])}</p>
  {case_block}
  <h3>2. Session / case-adjacent text</h3>
  {sess_block}
  <h3>3. Retrieved evidence (abstracts)</h3>
  {evid_block}
  <h3>4. System output to grade</h3>
  <div class="a">{esc(it['answer'])}</div>
  <h3>Your scores (1–5)</h3>
  <table class="score">
    <tr><th>factual</th><th>grounding</th><th>evidence</th><th>safety</th><th>usability</th></tr>
    <tr><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td></tr>
  </table>
  <p><b>error_tags</b>: <span contenteditable="true" class="tags"></span></p>
  <p><b>notes</b>: <span contenteditable="true" class="notes"></span></p>
</section>
"""


def write_html(items: list[dict], path: Path) -> None:
    n = len(items)
    n_packet = sum(1 for it in items if it.get("source") == "packet")
    n_rtms = n - n_packet
    types = Counter(it["question_type"] for it in items)
    type_str = ", ".join(f"{k}={v}" for k, v in sorted(types.items()))
    nav = "".join(f'<a href="#q{it["qa_id"]}">{it["qa_id"]}</a>' for it in items)
    cards = "".join(card_html(it) for it in items)
    doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ECHO-AI Human Evaluation — MedTutor-style M={n}</title>
<style>
  body {{ font-family: Georgia, "Times New Roman", serif; max-width: 920px; margin: 24px auto; padding: 0 16px; line-height: 1.45; color: #111; }}
  h1 {{ font-size: 1.55rem; }}
  .card {{ border: 1px solid #ccc; border-radius: 8px; padding: 16px 18px; margin: 18px 0; background: #fafafa; }}
  .examples {{ background: #fff8e7; border-color: #e6d59a; }}
  .tag {{ font-size: 0.75rem; background: #e8eef8; padding: 2px 8px; border-radius: 999px; }}
  .tag.src {{ background: #eee; }}
  .q {{ font-weight: 600; font-size: 1.05rem; }}
  .setting {{ background: #eef6ff; border: 1px solid #c5daf5; padding: 8px 10px; border-radius: 6px; font-size: 0.92rem; }}
  .orig, .meta {{ color: #444; font-size: 0.9rem; }}
  .a {{ background: #fff; border: 1px solid #ddd; padding: 10px 12px; border-radius: 6px; font-size: 0.95rem; }}
  .warn {{ background: #ffe8e8; border: 1px solid #e2a0a0; padding: 8px 10px; border-radius: 6px; }}
  pre.note {{ white-space: pre-wrap; background: #fff; border: 1px solid #ddd; padding: 10px; border-radius: 6px; font-size: 0.85rem; }}
  table.score {{ border-collapse: collapse; width: 100%; margin-top: 8px; }}
  table.score th, table.score td {{ border: 1px solid #bbb; padding: 8px; text-align: center; background: #fff; min-width: 70px; }}
  [contenteditable="true"] {{ outline: 2px dashed #8ab; min-height: 1.2em; }}
  .howto {{ background: #f3faf3; border: 1px solid #b7d7b7; padding: 12px 14px; border-radius: 8px; }}
  nav {{ line-height: 1.8; }}
  nav a {{ margin-right: 8px; font-size: 0.85rem; }}
</style>
</head>
<body>
<h1>ECHO-AI human evaluation — MedTutor-style text context (M={n})</h1>
<div class="howto">
  <p><b>Design:</b> Follows MedTutor (Jang et al., 2025): clinicians grade against a <b>text case pack</b> + <b>retrieved evidence abstracts</b> (+ optional session text). <b>No Zoom slide screenshots</b> in this UI.</p>
  <p><b>Scope:</b> n={n} ({n_packet} curated packet + {n_rtms} quality RTMS extras). Types: {esc(type_str)}.</p>
  <p><b>Task:</b> Score factual · grounding · evidence · safety · usability (1–5). Grounding = consistency with the case pack / session excerpt, not pixel matching.</p>
  <p>Public link: <a href="https://238plutonium.github.io/openreview/human-eval/">https://238plutonium.github.io/openreview/human-eval/</a></p>
</div>
{examples_html()}
<nav><b>Jump:</b> {nav}</nav>
{cards}
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
        # refresh setting suffix
        base_setting = re.sub(r"\s*Text context:.*$", "", it["setting_for_grader"]).strip()
        it["setting_for_grader"] = f"{base_setting} Text context: {ctx['availability']}."
        rebuilt.append(it)
    items = rebuilt

    write_csv(items, OUT / "human_eval_sheet.csv")
    write_ratings_template(items, OUT / "ratings_template.csv")
    write_html(items, OUT / "human_eval_sheet.html")
    write_id_list(items, OUT / "item_ids.csv")
    with_abs = sum(1 for it in items if it.get("context_evidence"))
    with_sess = sum(1 for it in items if it.get("context_note"))
    print(
        f"wrote {len(items)} MedTutor-style items; {with_abs} with abstracts; "
        f"{with_sess} with session text; types={dict(Counter(i['question_type'] for i in items))} → {OUT}"
    )
    if len(items) < TARGET_N:
        print(f"stopped at {len(items)} (quality pool exhausted; not padding to {TARGET_N})")


if __name__ == "__main__":
    main()
