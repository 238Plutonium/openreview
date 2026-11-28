#!/usr/bin/env python3
"""Build ECHO-only (M=13) human-eval HTML/CSV with annotation examples + session context.

Copies a few screenshare / minutes slides into context/qa_<id>/ when available so
raters are not asked to grade slide items with zero visual evidence.
"""
from __future__ import annotations

import csv
import html
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # evaluation/
OUT = Path(__file__).resolve().parent
PACKET = ROOT / "packet_qa.csv"
HELDOUT = ROOT / "heldout_qa_set.csv"
CTX = OUT / "context"
SCREENSHARE = Path("/scratch1/ECHO_project/data/rtms/screenshare")
MINUTES = Path("/scratch1/ECHO_project/data/rtms/minutes")

# Paper ECHO-content packet (MOUD/OUD-related only).
PACKET_IDS = [3, 4, 12, 13, 15, 16, 17, 18, 30, 33, 34, 35, 36]


def esc(s: str) -> str:
    return html.escape(s or "").replace("\n", "<br>")


def session_dirs(sid: str) -> tuple[Path | None, Path | None]:
    if not sid or sid == "unknown":
        return None, None
    ss = next((p for p in SCREENSHARE.iterdir() if p.is_dir() and p.name.startswith(sid)), None) if SCREENSHARE.exists() else None
    mm = next((p for p in MINUTES.iterdir() if p.is_dir() and p.name.startswith(sid)), None) if MINUTES.exists() else None
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
    # Prefer distinct files; keep order, unique by name
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
    """Copy images + write note; return metadata for HTML."""
    dest = CTX / f"qa_{qa_id}"
    dest.mkdir(parents=True, exist_ok=True)
    ss, mm = session_dirs(sid)
    imgs = collect_images(ss, mm, limit=4 if qtype in {"slide", "summary", "other", "prior_session"} else 2)
    rel_imgs: list[str] = []
    for i, src in enumerate(imgs, 1):
        dst = dest / f"frame_{i}{src.suffix.lower()}"
        if not dst.exists() or dst.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dst)
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


def load_items() -> list[dict]:
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
                "question_type": p["question_type"],
                "standalone_question": p["standalone_question"],
                "setting_for_grader": setting,
                "original_chat_question": p.get("original_chat_question") or "",
                "answer": p["answer"],
                "session_id": sid,
                "n_frames_log": h.get("n_frames", ""),
                "context_images": ctx["images"],
                "context_note": ctx["note"],
                "context_availability": ctx["availability"],
            }
        )
    return items


def write_csv(items: list[dict], path: Path) -> None:
    fields = [
        "qa_id",
        "question_type",
        "standalone_question",
        "setting_for_grader",
        "original_chat_question",
        "session_id",
        "n_frames_log",
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
            row["answer"] = it["answer"]
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


def card_html(it: dict) -> str:
    qid = it["qa_id"]
    imgs = it.get("context_images") or []
    note = it.get("context_note") or ""
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
  <h2>Question {qid} <span class="tag">{esc(it['question_type'])}</span></h2>
  <h3>Question (self-contained)</h3>
  <p class="q">{esc(it['standalone_question'])}</p>
  <p class="setting"><b>Setting for grader:</b> {esc(it['setting_for_grader'])}</p>
  <p class="orig"><b>Original chat text:</b> <em>{esc(it['original_chat_question'])}</em></p>
  <p class="meta">session_id=<code>{esc(it['session_id'])}</code> · log n_frames={esc(str(it.get('n_frames_log','')))} · {esc(it['context_availability'])}</p>
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
    nav = "".join(f'<a href="#q{it["qa_id"]}">{it["qa_id"]}</a>' for it in items)
    cards = "".join(card_html(it) for it in items)
    doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ECHO-AI Human Evaluation — M=13 MOUD packet</title>
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
  nav a {{ margin-right: 8px; font-size: 0.9rem; }}
  code {{ font-size: 0.9em; }}
</style>
</head>
<body>
<h1>ECHO-AI human evaluation — M=13 MOUD / ECHO packet</h1>
<div class="howto">
  <p><b>Scope:</b> Only ECHO/MOUD-related items from the paper packet (n=13). Off-domain probes (diabetes, leukemia, demo CS slides, …) are excluded.</p>
  <p><b>Task:</b> Score the archived ECHO answer on factual · grounding · evidence · safety · usability (1–5). Use <b>N/A</b> for grounding when required context is missing.</p>
  <p><b>Context:</b> Where available, session frames and short notes are attached below each question (see also <code>PROTOCOL.md</code>).</p>
  <p>Save a copy of this HTML after editing, or copy scores into <code>ratings_template.csv</code>.</p>
</div>
{examples_html()}
<nav><b>Jump:</b> {nav}</nav>
{cards}
</body>
</html>
"""
    path.write_text(doc)


def main() -> None:
    CTX.mkdir(parents=True, exist_ok=True)
    items = load_items()
    write_csv(items, OUT / "human_eval_sheet.csv")
    write_ratings_template(items, OUT / "ratings_template.csv")
    write_html(items, OUT / "human_eval_sheet.html")
    with_ctx = sum(1 for it in items if it["context_images"])
    print(f"wrote {len(items)} ECHO/MOUD items; {with_ctx} with frame context → {OUT}")


if __name__ == "__main__":
    main()
