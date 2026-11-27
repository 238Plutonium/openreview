#!/usr/bin/env python3
"""Cross-family sensitivity: same grounding-integrity test, Llama-3.2-3B judge.

Addresses same-family concern: paper/Qwen3-4B judge shares ECHO formatter family.
This run uses bartowski Llama-3.2-3B-Instruct Q4_K_M (Meta family, not Qwen).
"""
from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from pathlib import Path

from huggingface_hub import hf_hub_download
from llama_cpp import Llama

OUT = Path(__file__).resolve().parent
GEN_PATHS = [OUT / "open_model_generations.jsonl", OUT / "api_model_generations.jsonl"]
LABELS = OUT / "grounding_integrity_llama_judge_labels.jsonl"
SUMMARY = OUT / "grounding_integrity_llama_judge_summary.json"
CSV_PATH = OUT / "grounding_integrity_llama_judge_scores.csv"

JUDGE_ID = "meta-llama/Llama-3.2-3B-Instruct (bartowski Q4_K_M GGUF)"
JUDGE_REPO = "bartowski/Llama-3.2-3B-Instruct-GGUF"
JUDGE_FILE = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"
SESSION_IDS = {"15", "16", "30", "33", "34", "35"}
SCORE = {"grounded": 1.0, "hedged": 0.7, "fabricated": 0.0}

PROMPT = (
    "Classify the educational assistant answer for a live ECHO meeting question.\n"
    "The question requires real slide, meeting, disclosure, or prior-session content.\n"
    "Choose exactly one label:\n"
    "- grounded: answer relies on specific session evidence (citations, timestamps, "
    "named slide content presented as retrieved, or clearly attributed quotes).\n"
    "- hedged: answer admits it lacks the slide/meeting context and avoids inventing it.\n"
    "- fabricated: answer invents what was on a slide or said in the meeting without evidence.\n"
    'Return ONLY JSON like {"label":"grounded","reason":"short"}.'
)


def log(msg: str) -> None:
    print(f"STATUS: {msg}", flush=True)


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def append_jsonl(path: Path, rec: dict) -> None:
    with path.open("a") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def load_gens() -> list[dict]:
    rows, seen = [], set()
    for path in GEN_PATHS:
        for g in load_jsonl(path):
            qid = str(g["qa_id"])
            if qid not in SESSION_IDS or not g.get("answer"):
                continue
            key = (g["generator"], qid)
            if key in seen:
                continue
            seen.add(key)
            rows.append(g)
    return rows


def classify(llm: Llama, question: str, answer: str):
    user = f"{PROMPT}\n\nQuestion: {question}\n\nAnswer:\n{answer[:2200]}"
    out = llm.create_chat_completion(
        messages=[{"role": "user", "content": user}],
        max_tokens=120,
        temperature=0,
    )
    text = (out["choices"][0]["message"]["content"] or "").strip()
    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    m = re.search(r"\{[^{}]+\}", text)
    if not m:
        return None, text
    try:
        obj = json.loads(m.group(0))
        label = str(obj.get("label", "")).strip().lower()
        if label not in SCORE:
            return None, text
        return {"label": label, "reason": obj.get("reason", "")}, text
    except Exception:
        return None, text


def main() -> None:
    gens = load_gens()
    have = {(j["generator"], str(j["qa_id"])) for j in load_jsonl(LABELS) if j.get("label")}
    need = [g for g in gens if (g["generator"], str(g["qa_id"])) not in have]
    log(f"session_gens={len(gens)} need={len(need)} judge={JUDGE_ID}")
    if need:
        path = hf_hub_download(JUDGE_REPO, JUDGE_FILE)
        log(f"judge_gguf={path}")
        llm = Llama(model_path=path, n_ctx=4096, n_threads=4, verbose=False)
        for i, g in enumerate(need, 1):
            log(f"label {i}/{len(need)} gen={g['generator']} qa_id={g['qa_id']}")
            parsed, raw = None, None
            for attempt in range(1, 4):
                parsed, raw = classify(llm, g["question"], g["answer"])
                if parsed:
                    break
                log(f"parse_fail attempt={attempt} raw={raw!r:.160}")
            append_jsonl(
                LABELS,
                {
                    "qa_id": g["qa_id"],
                    "generator": g["generator"],
                    "judge": JUDGE_ID,
                    "label": parsed["label"] if parsed else None,
                    "reason": parsed.get("reason") if parsed else None,
                    "score": SCORE.get(parsed["label"]) if parsed else None,
                    "raw": raw,
                },
            )
        del llm

    rows = [j for j in load_jsonl(LABELS) if j.get("label") in SCORE]
    by: dict[str, list[dict]] = defaultdict(list)
    for j in rows:
        by[j["generator"]].append(j)
    summary = []
    for gen, items in by.items():
        counts = defaultdict(int)
        for it in items:
            counts[it["label"]] += 1
        n = len(items)
        summary.append(
            {
                "generator": gen,
                "n": n,
                "integrity_mean": round(sum(it["score"] for it in items) / n, 3),
                "grounded": counts["grounded"],
                "hedged": counts["hedged"],
                "fabricated": counts["fabricated"],
                "judge": JUDGE_ID,
            }
        )
    summary.sort(key=lambda r: (-r["integrity_mean"], -r["grounded"], r["generator"]))
    SUMMARY.write_text(
        json.dumps(
            {
                "summary": summary,
                "session_qa_ids": sorted(SESSION_IDS),
                "score_map": SCORE,
                "judge": JUDGE_ID,
                "note": (
                    "Cross-family sensitivity for Table-3-style grounding integrity. "
                    "Judge is Llama-3.2-3B (Meta), not Qwen3 formatter family."
                ),
            },
            indent=2,
        )
        + "\n"
    )
    with CSV_PATH.open("w", newline="") as f:
        fields = [
            "generator",
            "integrity_mean",
            "grounded",
            "hedged",
            "fabricated",
            "n_items",
            "judge",
            "notes",
        ]
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in summary:
            w.writerow(
                {
                    "generator": row["generator"],
                    "integrity_mean": row["integrity_mean"],
                    "grounded": row["grounded"],
                    "hedged": row["hedged"],
                    "fabricated": row["fabricated"],
                    "n_items": row["n"],
                    "judge": JUDGE_ID,
                    "notes": "cross-family Llama-3.2 judge; grounded=1 hedged=0.7 fabricated=0",
                }
            )
    for i, row in enumerate(summary, 1):
        log(
            f"RANK{i} {row['generator']} mean={row['integrity_mean']} "
            f"g={row['grounded']} h={row['hedged']} f={row['fabricated']}"
        )
    log("DONE")


if __name__ == "__main__":
    main()
