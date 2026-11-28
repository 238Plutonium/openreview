#!/usr/bin/env python3
"""Build ECHO-only human-eval HTML/CSV (target ≤25, quality-first).

Always keeps the curated paper packet (M=13). Fills remaining slots from RTMS
archives only when items clear a quality bar (宁缺毋滥 — may finish under 25).
"""
from __future__ import annotations

import csv
import html
import io
import json
import re
import shutil
from collections import Counter
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore

# Cursor/GitHub file previews often block relative or data-URI images.
# Default: relative paths + compress frames; open via local HTTP server.
EMBED_IMAGES = False
JPEG_MAX_W = 960
JPEG_QUALITY = 55

ROOT = Path(__file__).resolve().parents[1]  # evaluation/
OUT = Path(__file__).resolve().parent
PACKET = ROOT / "packet_qa.csv"
HELDOUT = ROOT / "heldout_qa_set.csv"
CTX = OUT / "context"
SCREENSHARE = Path("/scratch1/ECHO_project/data/rtms/screenshare")
MINUTES = Path("/scratch1/ECHO_project/data/rtms/minutes")
RTMS_QA = Path("/scratch1/ECHO_project/data/rtms/qa")

TARGET_N = 25  # soft ceiling; stop early if quality pool is exhausted
MIN_FILL_SCORE = 8

# Paper ECHO-content packet (MOUD/OUD-related only) — always included first.
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

# Soft caps so fillers do not all collapse into one type.
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
    q = re.sub(r"\s+", " ", q).strip()
    return q


def frame_count(frames) -> int:
    if isinstance(frames, list):
        return len(frames)
    try:
        return int(frames or 0)
    except (TypeError, ValueError):
        return 0


def has_screenshare(sid: str) -> bool:
    if not sid or sid == "unknown" or not SCREENSHARE.exists():
        return False
    return any(p.is_dir() and p.name.startswith(sid) for p in SCREENSHARE.iterdir())


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
        "literature": "Literature / education ask during an MOUD-related ECHO session.",
        "slide": "Slide / screenshare ask. Check attached frames when present.",
        "summary": "In-meeting summary ask. Use attached frames/notes when present.",
        "prior_session": "Prior-session recall ask. Grade claimed prior-session content carefully.",
        "other": "General MOUD/ECHO educational ask during a live session.",
    }.get(qtype, "ECHO session ask.")
    if not topical and qtype in {"slide", "summary"}:
        base += " Question is session/context-oriented; topical MOUD keywords may be weak."
    return base


def quality_score(cq: str, answer: str, sid: str) -> int | None:
    """Return score if item clears the quality bar, else None."""
    if len(cq) < 20 or len(answer) < 120:
        return None
    if OFF_PAT.search(cq) or JUNK_PAT.search(cq):
        return None
    if VAGUE_PAT.match(cq):
        return None

    topical_q = bool(POS_PAT.search(cq))
    topical_a = bool(POS_PAT.search(answer[:600]))
    ss = has_screenshare(sid)
    grounding = bool(GROUNDING_PROMPT.search(cq))

    # Primary path: MOUD/ECHO topical question.
    # Secondary: grounding prompt with frames + topical answer (useful for slide checks).
    if topical_q:
        pass
    elif grounding and ss and topical_a and len(answer) >= 200:
        pass
    else:
        return None

    score = 0
    score += 4 if topical_q else 1
    score += 3 if ss else 0
    score += 2 if len(answer) >= 250 else (1 if len(answer) >= 150 else 0)
    score += 2 if len(cq) >= 50 else (1 if len(cq) >= 30 else 0)
    if SPECIFIC_BONUS.search(cq):
        score += 2
    # Thin generic lit prompts still need frames + strong answer; mild penalty.
    if re.fullmatch(
        r"(cite relevant pubs|answer the question citing pubs|use pubmed source for the question)",
        cq,
        re.I,
    ):
        score -= 2
    if score < MIN_FILL_SCORE:
        return None
    return score


def session_dirs(sid: str) -> tuple[Path | None, Path | None]:
    if not sid or sid == "unknown":
        return None, None
    ss = (
        next((p for p in SCREENSHARE.iterdir() if p.is_dir() and p.name.startswith(sid)), None)
        if SCREENSHARE.exists()
        else None
    )
    mm = (
        next((p for p in MINUTES.iterdir() if p.is_dir() and p.name.startswith(sid)), None)
        if MINUTES.exists()
        else None
    )
    return ss, mm


def collect_images(ss: Path | None, mm: Path | None, limit: int = 4) -> list[Path]:
    imgs: list[Path] = []
    if mm and (mm / "slides").is_dir():
        imgs.extend(sorted((mm / "slides").glob("slide_*.jpg")))
    if ss:
        uniq = ss / "unique" / "frames"
        if uniq.is_dir():
            imgs.extend(sorted(uniq.glob("*.jpg")))
        else:
            imgs.extend(sorted(ss.rglob("*.jpg")))
    seen: set[str] = set()
    out: list[Path] = []
    for p in imgs:
        if p.name in seen:
            continue
        seen.add(p.name)
        out.append(p)
        if len(out) >= limit:
            break
    return out


def meeting_note(mm: Path | None, max_chars: int = 900) -> str:
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


def copy_context(qa_id: str, sid: str, qtype: str) -> dict:
    dest = CTX / f"qa_{qa_id}"
    dest.mkdir(parents=True, exist_ok=True)
    ss, mm = session_dirs(sid)
    imgs = collect_images(ss, mm, limit=4 if qtype in {"slide", "summary", "other", "prior_session"} else 2)
    rel_imgs: list[str] = []
    for i, src in enumerate(imgs, 1):
        dst = dest / f"frame_{i}.jpg"
        _write_compressed_jpeg(src, dst)
        rel_imgs.append(f"context/qa_{qa_id}/{dst.name}")

    note = meeting_note(mm) if qtype in {"summary", "prior_session", "other", "slide"} else ""
    if note:
        (dest / "meeting_note.txt").write_text(note + "\n")

    availability = []
    if rel_imgs:
        availability.append(f"{len(rel_imgs)} session frame(s) attached")
    else:
        availability.append("NO session frames attached")
    if note:
        availability.append("short meeting note/transcript excerpt attached")
    elif qtype in {"summary", "prior_session", "slide"}:
        availability.append("no meeting transcript excerpt available for this session id")

    return {
        "images": rel_imgs,
        "note": note,
        "availability": "; ".join(availability),
        "session_id": sid,
        "screenshare_dir": str(ss) if ss else "",
    }


def load_packet_items() -> list[dict]:
    packet = {r["qa_id"]: r for r in csv.DictReader(PACKET.open())}
    held = {r["qa_id"]: r for r in csv.DictReader(HELDOUT.open())}
    items = []
    for qid in PACKET_IDS:
        key = str(qid)
        if key not in packet:
            raise SystemExit(f"missing packet qa_id={qid}")
        p = packet[key]
        h = held.get(key, {})
        sid = (h.get("session_id") or "unknown").strip()
        ctx = copy_context(key, sid, p["question_type"])
        setting = (p.get("setting_for_grader") or "").strip()
        setting = f"{setting} Context availability: {ctx['availability']}."
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
                "context_images": ctx["images"],
                "context_note": ctx["note"],
                "context_availability": ctx["availability"],
            }
        )
    return items


def iter_rtms_candidates(exclude_norm: set[str]) -> list[dict]:
    cands: list[dict] = []
    seen: set[str] = set(exclude_norm)
    if not RTMS_QA.exists():
        return cands
    for f in sorted(RTMS_QA.glob("*.ndjson")):
        sid_full = f.stem
        sid = sid_full[:8] if sid_full != "unknown" else "unknown"
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
            topical = bool(POS_PAT.search(cq))
            qtype = classify_type(q, o.get("replyType") or "")
            cands.append(
                {
                    "session_id": sid,
                    "question": q,
                    "answer": a,
                    "question_type": qtype,
                    "n_frames": frame_count(o.get("screenShareFramesUsed")),
                    "createdAt": o.get("createdAt") or o.get("askedAt") or "",
                    "topical": topical,
                    "norm": key,
                    "score": score,
                }
            )
            seen.add(key)
            seen.add(key_c)
            seen.add(ans_key)
    cands.sort(key=lambda c: (-c["score"], -len(c["answer"]), c["createdAt"]))
    return cands


def _exclude_keys_for_item(it: dict) -> set[str]:
    keys: set[str] = set()
    for field in ("original_chat_question", "standalone_question"):
        raw = it.get(field) or ""
        if not raw:
            continue
        keys.add(norm_q(raw))
        keys.add(norm_q(clean_question(raw)))
    ans = norm_q(it.get("answer") or "")
    if ans:
        keys.add("A:" + ans[:120])
    return keys


def fill_to_target(packet_items: list[dict], target: int = TARGET_N) -> list[dict]:
    items = list(packet_items)
    exclude: set[str] = set()
    for it in items:
        exclude |= _exclude_keys_for_item(it)
    cands = iter_rtms_candidates(exclude)
    counts = Counter(it["question_type"] for it in items)
    next_id = 1001
    used_answers = {norm_q(it["answer"])[:120] for it in items}

    def take(c: dict) -> dict:
        nonlocal next_id
        qid = str(next_id)
        next_id += 1
        qtype = c["question_type"]
        sid = c["session_id"]
        ctx = copy_context(qid, sid, qtype)
        standalone = clean_question(c["question"])
        setting = setting_for(qtype, c["topical"])
        setting = f"{setting} Context availability: {ctx['availability']}."
        return {
            "qa_id": qid,
            "source": "rtms",
            "question_type": qtype,
            "standalone_question": standalone,
            "setting_for_grader": setting,
            "original_chat_question": c["question"],
            "answer": c["answer"],
            "session_id": sid,
            "n_frames_log": str(c["n_frames"]),
            "quality_score": str(c["score"]),
            "context_images": ctx["images"],
            "context_note": ctx["note"],
            "context_availability": ctx["availability"],
        }

    def is_dup(c: dict) -> bool:
        nq = c["norm"]
        nqc = norm_q(clean_question(c["question"]))
        na = norm_q(c["answer"])[:120]
        if nq in exclude or nqc in exclude or ("A:" + na) in exclude:
            return True
        if na in used_answers:
            return True
        return False

    # Single pass: highest score first; respect soft type caps; never lower the bar.
    for c in cands:
        if len(items) >= target:
            break
        if is_dup(c):
            continue
        qtype = c["question_type"]
        if counts[qtype] >= TYPE_QUOTA.get(qtype, 99):
            continue
        # Prefer extras that actually have attachable frames when type needs them.
        if qtype in {"slide", "summary"} and not has_screenshare(c["session_id"]):
            continue
        item = take(c)
        # Drop if context copy still found nothing for grounding-critical types.
        if qtype in {"slide"} and not item["context_images"]:
            shutil.rmtree(CTX / f"qa_{item['qa_id']}", ignore_errors=True)
            continue
        items.append(item)
        counts[qtype] += 1
        exclude |= _exclude_keys_for_item(item)
        used_answers.add(norm_q(c["answer"])[:120])

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
        "context_images",
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
            row["context_images"] = "|".join(it.get("context_images") or [])
            for k in [
                "factual_1to5",
                "grounding_1to5",
                "evidence_1to5",
                "safety_1to5",
                "usability_1to5",
                "error_tags",
                "notes",
            ]:
                row[k] = ""
            w.writerow(row)


def write_ratings_template(items: list[dict], path: Path) -> None:
    fields = [
        "qa_id",
        "rater_id",
        "rater_role",
        "factual",
        "grounding",
        "evidence",
        "safety",
        "usability",
        "error_tags",
        "notes",
    ]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for it in items:
            w.writerow(
                {
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


def examples_html() -> str:
    return """
<section class="card examples" id="examples">
  <h2>Annotation examples (read before scoring)</h2>
  <p>Score each axis <b>1–5</b>, or type <b>N/A</b> for grounding when required context is missing/unusable. Error tags (optional): <code>ok</code>, <code>wrong_slide</code>, <code>no_frame_hallucination</code>, <code>irrelevant_pmid</code>, <code>unsupported_claim</code>, <code>overconfident</code>, <code>frame_refuse</code>, <code>asr_cascade</code>.</p>
  <h3>Example A — literature with supportive citations</h3>
  <p>MOUD/pain/SUD educational answer, appropriate hedges, citations actually support claims → typically factual/evidence/safety/usability <b>4–5</b>; tags <code>ok</code>.</p>
  <h3>Example B — slide question with frames attached</h3>
  <p>Compare the answer to the images in the Context panel. Matches visible text → high grounding. Invents bullets not on the frames → grounding <b>1–2</b>, tag <code>wrong_slide</code>.</p>
  <h3>Example C — needs slide/meeting but context weak or absent</h3>
  <p>Mark grounding <b>N/A</b> if you cannot verify. If the bot invents detailed slide/meeting content anyway → tag <code>no_frame_hallucination</code> and keep factual/grounding low. If it honestly refuses → grounding N/A is fine; do not punish abstention.</p>
  <h3>Example D — citation dump</h3>
  <p>PMID list that does not support the claims → evidence <b>1–2</b>, tag <code>irrelevant_pmid</code>.</p>
</section>
"""


def _write_compressed_jpeg(src: Path, dst: Path) -> None:
    """Copy/resize frame so the HTTP-served sheet stays light."""
    if Image is None:
        shutil.copy2(src, dst)
        return
    im = Image.open(src).convert("RGB")
    w, h = im.size
    if w > JPEG_MAX_W:
        im = im.resize((JPEG_MAX_W, int(h * JPEG_MAX_W / w)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    dst.write_bytes(buf.getvalue())


def card_html(it: dict) -> str:
    qid = it["qa_id"]
    imgs = it.get("context_images") or []
    note = it.get("context_note") or ""
    src_tag = it.get("source") or ""
    img_block = ""
    if imgs:
        figs = "".join(
            f'<figure class="ctx"><img src="{html.escape(src)}" alt="session frame for qa {qid}" loading="lazy"/><figcaption>{html.escape(Path(src).name)}</figcaption></figure>'
            for src in imgs
        )
        img_block = f"<div class='ctx-grid'>{figs}</div>"
    else:
        img_block = "<p class='warn'><b>No frames attached</b> for this item. If the question needs a slide/screen, mark grounding N/A unless you are only scoring honesty of abstention.</p>"

    note_block = ""
    if note:
        note_block = f"<details open><summary>Meeting note / transcript excerpt</summary><pre class='note'>{esc(note)}</pre></details>"

    return f"""
<section class="card" id="q{qid}">
  <h2>Question {qid} <span class="tag">{esc(it['question_type'])}</span> <span class="tag src">{esc(src_tag)}</span></h2>
  <h3>Question (self-contained)</h3>
  <p class="q">{esc(it['standalone_question'])}</p>
  <p class="setting"><b>Setting for grader:</b> {esc(it['setting_for_grader'])}</p>
  <p class="orig"><b>Original chat text:</b> <em>{esc(it['original_chat_question'])}</em></p>
  <p class="meta">session_id=<code>{esc(it['session_id'])}</code> · log n_frames={esc(str(it.get('n_frames_log','')))} · quality={esc(str(it.get('quality_score','')))} · {esc(it['context_availability'])}</p>
  <h3>Context for grader</h3>
  {img_block}
  {note_block}
  <h3>Bot answer (ECHO archived)</h3>
  <div class="a">{esc(it['answer'])}</div>
  <h3>Your scores (1–5; use N/A if not judgeable)</h3>
  <table class="score">
    <tr><th>factual</th><th>grounding</th><th>evidence</th><th>safety</th><th>usability</th></tr>
    <tr><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td><td contenteditable="true"></td></tr>
  </table>
  <p><b>error_tags</b> (optional): <span contenteditable="true" class="tags"></span></p>
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
<title>ECHO-AI Human Evaluation — M={n}</title>
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
  .ctx-grid {{ display: grid; grid-template-columns: 1fr; gap: 10px; }}
  @media (min-width: 720px) {{ .ctx-grid {{ grid-template-columns: 1fr 1fr; }} }}
  figure.ctx {{ margin: 0; background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 6px; }}
  figure.ctx img {{ width: 100%; height: auto; display: block; border-radius: 4px; }}
  figure.ctx figcaption {{ font-size: 0.75rem; color: #555; margin-top: 4px; }}
  pre.note {{ white-space: pre-wrap; background: #fff; border: 1px solid #ddd; padding: 10px; border-radius: 6px; font-size: 0.85rem; }}
  table.score {{ border-collapse: collapse; width: 100%; margin-top: 8px; }}
  table.score th, table.score td {{ border: 1px solid #bbb; padding: 8px; text-align: center; background: #fff; min-width: 70px; }}
  [contenteditable="true"] {{ outline: 2px dashed #8ab; min-height: 1.2em; }}
  .howto {{ background: #f3faf3; border: 1px solid #b7d7b7; padding: 12px 14px; border-radius: 8px; }}
  nav {{ line-height: 1.8; }}
  nav a {{ margin-right: 8px; font-size: 0.85rem; }}
  code {{ font-size: 0.9em; }}
</style>
</head>
<body>
<h1>ECHO-AI human evaluation — M={n} (quality-first ECHO / MOUD)</h1>
<div class="howto">
  <p><b>Scope:</b> ECHO/MOUD-related items only (n={n}: {n_packet} curated packet + {n_rtms} high-quality RTMS extras). Off-domain probes and vague screen/summary asks are excluded. Target ceiling is 25; we do not pad with weak items.</p>
  <p><b>Type mix:</b> {esc(type_str)}</p>
  <p><b>Task:</b> Score the archived ECHO answer on factual · grounding · evidence · safety · usability (1–5). Use <b>N/A</b> for grounding when required context is missing.</p>
  <p><b>Context:</b> Where available, session frames and short notes are attached below each question (see also <code>PROTOCOL.md</code>).</p>
  <p><b>How to open:</b> do <i>not</i> rely on Cursor/GitHub file preview (images will be blank). Serve this folder over HTTP, e.g. <code>python3 -m http.server 8765</code> then open <code>http://127.0.0.1:8765/human_eval_sheet.html</code>.</p>
  <p>Save a copy of this HTML after editing, or copy scores into <code>ratings_template.csv</code>.</p>
</div>
{examples_html()}
<nav><b>Jump:</b> {nav}</nav>
{cards}
</body>
</html>
"""
    path.write_text(doc)


def write_id_list(items: list[dict], path: Path) -> None:
    with path.open("w", newline="") as f:
        w = csv.DictWriter(
            f,
            fieldnames=[
                "qa_id",
                "source",
                "question_type",
                "session_id",
                "quality_score",
                "context_availability",
            ],
        )
        w.writeheader()
        for it in items:
            w.writerow(
                {
                    "qa_id": it["qa_id"],
                    "source": it.get("source", ""),
                    "question_type": it["question_type"],
                    "session_id": it["session_id"],
                    "quality_score": it.get("quality_score", ""),
                    "context_availability": it["context_availability"],
                }
            )


def main() -> None:
    if CTX.exists():
        shutil.rmtree(CTX)
    CTX.mkdir(parents=True, exist_ok=True)
    packet_items = load_packet_items()
    items = fill_to_target(packet_items, TARGET_N)
    write_csv(items, OUT / "human_eval_sheet.csv")
    write_ratings_template(items, OUT / "ratings_template.csv")
    write_html(items, OUT / "human_eval_sheet.html")
    write_id_list(items, OUT / "item_ids.csv")
    with_ctx = sum(1 for it in items if it["context_images"])
    types = Counter(it["question_type"] for it in items)
    print(
        f"wrote {len(items)} ECHO/MOUD items (ceiling {TARGET_N}); "
        f"{with_ctx} with frame context; types={dict(types)} → {OUT}"
    )
    extras = [it for it in items if it.get("source") == "rtms"]
    for it in extras:
        print(f"  + {it['qa_id']} score={it['quality_score']} {it['question_type']}: {it['standalone_question'][:90]}")
    if len(items) < TARGET_N:
        print(f"stopped at {len(items)} (quality pool exhausted; not padding to {TARGET_N})")


if __name__ == "__main__":
    main()
