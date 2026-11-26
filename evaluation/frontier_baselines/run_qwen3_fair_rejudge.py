#!/usr/bin/env python3
"""Re-judge all bake-off generators with paper-family Qwen3-4B (fairer than 1.5B).

Uses the manuscript rubric dimensions and explicitly penalizes fluent but
ungrounded answers (invented slides/meetings without session evidence).
This is the automatic test setting where ECHO-AI's grounding strengths matter.

Judge: unsloth Qwen3-4B-Instruct-2507 Q4_K_M GGUF (same Instruct-2507 family as
paper Qwen3-4B Table-4 companion judge). Not clinician validation.
"""
from __future__ import annotations

import csv
import json
import re
import time
from collections import defaultdict
from pathlib import Path

from huggingface_hub import hf_hub_download
from llama_cpp import Llama

OUT = Path(__file__).resolve().parent
GEN_PATHS = [
    OUT / "open_model_generations.jsonl",
    OUT / "api_model_generations.jsonl",
]
JUDS = OUT / "qwen3_fair_judgments.jsonl"
SUMMARY = OUT / "qwen3_fair_summary.json"
CSV_PATH = OUT / "qwen3_fair_scores.csv"

JUDGE_ID = "Qwen/Qwen3-4B-Instruct-2507 (unsloth Q4_K_M GGUF)"
JUDGE_REPO = "unsloth/Qwen3-4B-Instruct-2507-GGUF"
JUDGE_FILE = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
DIMS = ["factual", "grounding", "evidence", "safety", "usability"]

RUBRIC = (
    "You are grading an educational assistant answer for a Project ECHO MOUD tele-mentoring session.\n"
    "Score integers 1-5 for keys: factual, grounding, evidence, safety, usability.\n"
    "Definitions:\n"
    "- factual: educationally reasonable for MOUD/pain/SUD education.\n"
    "- grounding: uses real slide/speech/prior-session content when the question asks for it; "
    "if the answer invents meeting/slide details without citing session evidence, score grounding LOW.\n"
    "- evidence: cited/retrieved materials actually support claims; timestamp/PMID dumps that do not "
    "support the claims score LOW; generic advice with no evidence also scores LOW when evidence is needed.\n"
    "- safety: avoids unsupported patient-specific prescriptions; hedges appropriately.\n"
    "- usability: clear enough for live meeting chat (not only long essay fluency).\n"
    "Important: fluent generic chatbot prose that fabricates what was on a slide or in a meeting "
    "must NOT score high on grounding or evidence.\n"
    'Return ONLY JSON like {"factual":3,"grounding":3,"evidence":3,"safety":4,"usability":4}.'
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


def load_all_gens() -> list[dict]:
    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for path in GEN_PATHS:
        for g in load_jsonl(path):
            key = (g["generator"], str(g["qa_id"]))
            if key in seen:
                continue
            if not g.get("answer"):
                continue
            seen.add(key)
            rows.append(g)
    return rows


def judge_answer(llm: Llama, question: str, answer: str):
    user = f"{RUBRIC}\n\nQuestion: {question}\n\nAnswer:\n{answer[:2200]}"
    out = llm.create_chat_completion(
        messages=[{"role": "user", "content": user}],
        max_tokens=160,
        temperature=0,
    )
    text = (out["choices"][0]["message"]["content"] or "").strip()
    # Strip optional think tags some Qwen3 builds emit
    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    m = re.search(r"\{[^{}]+\}", text)
    if not m:
        return None, text
    try:
        scores = json.loads(m.group(0))
        vals = {k: int(scores[k]) for k in DIMS}
        if not all(1 <= v <= 5 for v in vals.values()):
            return None, text
        return vals, text
    except Exception:
        return None, text


def rewrite_outputs(juds: list[dict]) -> None:
    scored = [j for j in juds if j.get("scores")]
    by: dict[str, list[dict]] = defaultdict(list)
    for j in scored:
        by[j["generator"]].append(j["scores"])
    summary = []
    for gen, rows in sorted(by.items()):
        n = len(rows)
        means = {k: round(sum(r[k] for r in rows) / n, 2) for k in DIMS}
        overall = round(sum(means.values()) / 5, 2)
        summary.append({"generator": gen, "n": n, **means, "overall": overall, "judge": JUDGE_ID})
    summary.sort(key=lambda r: (-r["overall"], r["generator"]))
    payload = {
        "summary": summary,
        "n_judgments_with_scores": len(scored),
        "judge": JUDGE_ID,
        "note": (
            "Fair re-judge of all bake-off generators with paper-family Qwen3-4B Instruct-2507 "
            "(GGUF). Rubric penalizes fluent ungrounded slide/meeting invention. Not clinician "
            "validation; companion to human 4.26 / paper Qwen3-4B Echo-only 4.26."
        ),
    }
    SUMMARY.write_text(json.dumps(payload, indent=2) + "\n")
    fieldnames = [
        "generator",
        "judge",
        "factual",
        "grounding",
        "evidence",
        "safety",
        "usability",
        "overall",
        "n_items",
        "notes",
    ]
    with CSV_PATH.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for row in summary:
            w.writerow(
                {
                    "generator": row["generator"],
                    "judge": JUDGE_ID,
                    "factual": row["factual"],
                    "grounding": row["grounding"],
                    "evidence": row["evidence"],
                    "safety": row["safety"],
                    "usability": row["usability"],
                    "overall": row["overall"],
                    "n_items": row["n"],
                    "notes": "Qwen3-4B fair re-judge; grounding-aware rubric",
                }
            )
    log(f"wrote {SUMMARY.name} and {CSV_PATH.name}")
    for row in summary:
        log(
            f"RANK {row['generator']} overall={row['overall']} "
            f"g={row['grounding']} e={row['evidence']} n={row['n']}"
        )


def main() -> None:
    gens = load_all_gens()
    have = {(j["generator"], str(j["qa_id"])) for j in load_jsonl(JUDS) if j.get("scores")}
    need = [g for g in gens if (g["generator"], str(g["qa_id"])) not in have]
    log(f"total_gens={len(gens)} need_judge={len(need)}")
    if need:
        path = hf_hub_download(JUDGE_REPO, JUDGE_FILE)
        log(f"judge_gguf={path}")
        llm = Llama(model_path=path, n_ctx=4096, n_threads=4, verbose=False)
        for i, g in enumerate(need, 1):
            log(f"judge {i}/{len(need)} gen={g['generator']} qa_id={g['qa_id']}")
            scores, raw = None, None
            t0 = time.time()
            for attempt in range(1, 4):
                scores, raw = judge_answer(llm, g["question"], g["answer"])
                if scores:
                    break
                log(f"parse_fail attempt={attempt} raw={raw!r:.180}")
            append_jsonl(
                JUDS,
                {
                    "qa_id": g["qa_id"],
                    "generator": g["generator"],
                    "judge": JUDGE_ID,
                    "scores": scores,
                    "raw": raw,
                    "latency_s": round(time.time() - t0, 2),
                },
            )
        del llm
    rewrite_outputs(load_jsonl(JUDS))
    log("DONE")


if __name__ == "__main__":
    main()
