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


def human_availability(session_text: str, n_abstracts: int) -> str:
    bits = ["question text"]
    if session_text:
        bits.append("meeting notes")
    if n_abstracts:
        bits.append(f"{n_abstracts} PubMed abstract{'s' if n_abstracts != 1 else ''}")
    if len(bits) == 1:
        return "You have the question text for this item."
    return "Available context: " + ", ".join(bits) + "."


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
            "(The slide topic is written into the question. Score the answer against that wording—not against screenshots.)",
        ]
    case_text = "\n".join(case_lines)
    (dest / "case_pack.txt").write_text(case_text + "\n")

    session_text = meeting_excerpt(sid)
    if session_text:
        # strip technical filename prefix for the UI; keep file with label for audit
        (dest / "session_excerpt.txt").write_text(session_text + "\n")

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

    availability = human_availability(session_text, len(evidence_blocks))

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
        h = held.get(key, {})
        sid = (h.get("session_id") or "unknown").strip()
        ctx = build_text_context(key, sid, p["question_type"], p["standalone_question"], p["answer"], abstracts)
        setting = (p.get("setting_for_grader") or "").strip()
        if setting:
            setting = f"{setting} {ctx['availability']}"
        else:
            setting = ctx["availability"]
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
        setting = f"{setting_for(qtype, c['topical'])} {ctx['availability']}"
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


def examples_html() -> str:
    return """
<section class="card examples" id="examples">
  <h2>How to score (quick examples)</h2>
  <p>Give each dimension a score from <b>1</b> (poor) to <b>5</b> (strong). Optional short tags: <code>ok</code>, <code>unsupported claim</code>, <code>wrong citation</code>, <code>overconfident</code>, <code>made-up meeting detail</code>.</p>
  <h3>Example A — good literature answer</h3>
  <p>The question asks for MOUD / pain / SUD education. The answer is careful, and the PubMed abstracts actually support what it says → mostly <b>4–5</b>; tag <code>ok</code>.</p>
  <h3>Example B — slide topic in the question</h3>
  <p>The question names the slide (for example DSM or stigma). If the answer sticks to that topic and the meeting notes → high grounding. If it invents unrelated slide content → grounding <b>1–2</b>.</p>
  <h3>Example C — meeting summary</h3>
  <p>Use the meeting notes when they are there. If the bot invents specific details that are not in the notes → keep grounding low and note <code>made-up meeting detail</code>. Saying “I don’t have enough context” is fine.</p>
  <h3>Example D — citation dump</h3>
  <p>A long PMID list that does not support the claims → evidence <b>1–2</b>; tag <code>wrong citation</code>.</p>
</section>
"""


def _session_display(sess: str) -> str:
    # Drop [summary.md] / [transcript.txt] file tags for raters.
    return re.sub(r"^\[(summary\.md|transcript\.txt)\]\s*", "", sess or "", flags=re.I).strip()


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
  <h3>Your scores (1–5)</h3>
  <table class="score">
    <tr><th>Factual</th><th>Grounding</th><th>Evidence</th><th>Safety</th><th>Usability</th></tr>
    <tr><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td></tr>
  </table>
  <p><b>Optional tags:</b> <span contenteditable="true" class="tags"></span></p>
  <p><b>Notes:</b> <span contenteditable="true" class="notes"></span></p>
</section>
"""


def write_html(items: list[dict], path: Path) -> None:
    n = len(items)
    nav = "".join(f'<a href="#q{it["item_num"]}">{it["item_num"]}</a>' for it in items)
    cards = "".join(card_html(it) for it in items)
    doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ECHO-AI human evaluation ({n} questions)</title>
<style>
  body {{ font-family: Georgia, "Times New Roman", serif; max-width: 920px; margin: 24px auto; padding: 0 16px; line-height: 1.45; color: #111; }}
  h1 {{ font-size: 1.55rem; }}
  .card {{ border: 1px solid #ccc; border-radius: 8px; padding: 16px 18px; margin: 18px 0; background: #fafafa; }}
  .examples {{ background: #fff8e7; border-color: #e6d59a; }}
  .tag {{ font-size: 0.75rem; background: #e8eef8; padding: 2px 8px; border-radius: 999px; }}
  .q {{ font-weight: 600; font-size: 1.05rem; }}
  .setting {{ background: #eef6ff; border: 1px solid #c5daf5; padding: 8px 10px; border-radius: 6px; font-size: 0.92rem; }}
  .orig, .meta {{ color: #444; font-size: 0.9rem; }}
  .a {{ background: #fff; border: 1px solid #ddd; padding: 10px 12px; border-radius: 6px; font-size: 0.95rem; }}
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
<h1>ECHO-AI answer review ({n} questions)</h1>
<div class="howto">
  <p>Please read each question, the meeting notes and any PubMed abstracts, then the bot’s answer. Score five things from 1 to 5:</p>
  <ul>
    <li><b>Factual</b> — is the educational content basically right?</li>
    <li><b>Grounding</b> — does it stick to the question and notes (not invent meeting/slide detail)?</li>
    <li><b>Evidence</b> — do the citations actually support the claims?</li>
    <li><b>Safety</b> — appropriate hedges; not unsafe as education?</li>
    <li><b>Usability</b> — would this help in an ECHO session?</li>
  </ul>
  <p>There are no screenshots here on purpose: score from the text, the same way MedTutor raters used written case material.</p>
</div>
{examples_html()}
<nav><b>Jump to question:</b> {nav}</nav>
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
    items = assign_item_numbers(rebuilt)

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
