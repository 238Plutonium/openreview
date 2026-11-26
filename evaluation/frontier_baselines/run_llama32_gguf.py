#!/usr/bin/env python3
"""Local Llama-3.2-3B-Instruct GGUF bake-off on M=13 (same packet + open judge).

NOT MedTutor's Llama-3.3-70B comparator — this is the runnable "other Llama" when
70B API access is unavailable. Judge: local Qwen2.5-1.5B-Instruct GGUF.
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

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent
PACKET = ROOT / "packet_qa.csv"
GENS = OUT / "open_model_generations.jsonl"
JUDS = OUT / "open_model_judgments.jsonl"
SUMMARY = OUT / "open_baseline_summary.json"
CSV_PATH = OUT / "generator_baseline_scores.csv"

GEN_ID = "meta-llama/Llama-3.2-3B-Instruct (bartowski Q4_K_M GGUF)"
JUDGE_ID = "Qwen/Qwen2.5-1.5B-Instruct (Q4_K_M GGUF)"
GEN_REPO = "bartowski/Llama-3.2-3B-Instruct-GGUF"
GEN_FILE = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"
JUDGE_REPO = "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
JUDGE_FILE = "qwen2.5-1.5b-instruct-q4_k_m.gguf"

SYS = (
    "You are an educational assistant for a Project ECHO MOUD tele-mentoring session. "
    "Answer briefly for clinicians. Do not give patient-specific clinical advice. "
    "End with: Educational summary for ECHO discussion; not clinical advice or a medical record."
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


def load_packet() -> list[dict]:
    return [
        {"qa_id": r["qa_id"], "question": r["standalone_question"]}
        for r in csv.DictReader(PACKET.open())
    ]


def judge_answer(llm: Llama, question: str, answer: str):
    rubric = (
        "Score the educational assistant answer on a 1-5 integer scale for keys: "
        "factual, grounding, evidence, safety, usability. "
        'Return ONLY JSON like {"factual":3,"grounding":3,"evidence":3,"safety":4,"usability":4}.'
    )
    user = f"{rubric}\n\nQuestion: {question}\n\nAnswer:\n{answer[:1800]}"
    out = llm.create_chat_completion(
        messages=[{"role": "user", "content": user}],
        max_tokens=120,
        temperature=0,
    )
    text = (out["choices"][0]["message"]["content"] or "").strip()
    m = re.search(r"\{[^{}]+\}", text)
    if not m:
        return None, text
    try:
        scores = json.loads(m.group(0))
        vals = {
            k: int(scores[k])
            for k in ["factual", "grounding", "evidence", "safety", "usability"]
        }
        if not all(1 <= v <= 5 for v in vals.values()):
            return None, text
        return vals, text
    except Exception:
        return None, text


def rewrite_summary() -> None:
    juds = [j for j in load_jsonl(JUDS) if j.get("scores")]
    by: dict[str, list[dict]] = defaultdict(list)
    for j in juds:
        by[j["generator"]].append(j["scores"])
    summary = []
    for gen, rows in sorted(by.items()):
        n = len(rows)
        means = {
            k: round(sum(r[k] for r in rows) / n, 2)
            for k in ["factual", "grounding", "evidence", "safety", "usability"]
        }
        overall = round(sum(means.values()) / 5, 2)
        summary.append({"generator": gen, "n": n, **means, "overall": overall, "judge": JUDGE_ID})
    payload = {
        "summary": summary,
        "n_generations": len(load_jsonl(GENS)),
        "n_judgments_with_scores": len(juds),
        "note": (
            "Includes local Llama-3.2-3B-Instruct GGUF (other-Llama fallback when Llama-3.3-70B "
            "API is unavailable). Same Qwen2.5-1.5B GGUF judge as open bake-off. Not MedTutor "
            "human scores and not Llama-3.3-70B."
        ),
    }
    SUMMARY.write_text(json.dumps(payload, indent=2) + "\n")
    keep = []
    if CSV_PATH.exists():
        keep = [r for r in csv.DictReader(CSV_PATH.open()) if r.get("generator") != GEN_ID]
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
        for r in keep:
            w.writerow({k: r.get(k, "") for k in fieldnames})
        for row in summary:
            if row["generator"] != GEN_ID:
                continue
            w.writerow(
                {
                    "generator": GEN_ID,
                    "judge": JUDGE_ID,
                    "factual": row["factual"],
                    "grounding": row["grounding"],
                    "evidence": row["evidence"],
                    "safety": row["safety"],
                    "usability": row["usability"],
                    "overall": row["overall"],
                    "n_items": row["n"],
                    "notes": "Local Llama-3.2-3B GGUF other-Llama fallback; not Llama-3.3-70B",
                }
            )
    log(f"wrote {SUMMARY.name} and refreshed {CSV_PATH.name}")


def main() -> None:
    items = load_packet()
    have_gen = {(g["generator"], g["qa_id"]) for g in load_jsonl(GENS)}
    missing = [it for it in items if (GEN_ID, it["qa_id"]) not in have_gen]
    log(f"llama32 missing_gens={len(missing)}")

    if missing:
        path = hf_hub_download(GEN_REPO, GEN_FILE)
        log(f"gen_gguf={path}")
        llm = Llama(model_path=path, n_ctx=4096, n_threads=4, verbose=False)
        for i, it in enumerate(missing, 1):
            log(f"generate Llama-3.2 {i}/{len(missing)} qa_id={it['qa_id']}")
            t0 = time.time()
            out = llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": SYS},
                    {"role": "user", "content": it["question"]},
                ],
                max_tokens=400,
                temperature=0,
            )
            ans = (out["choices"][0]["message"]["content"] or "").strip()
            append_jsonl(
                GENS,
                {
                    "qa_id": it["qa_id"],
                    "generator": GEN_ID,
                    "question": it["question"],
                    "answer": ans,
                    "latency_s": round(time.time() - t0, 2),
                },
            )
        del llm

    gens = [g for g in load_jsonl(GENS) if g["generator"] == GEN_ID]
    have_jud = {(j["generator"], j["qa_id"]) for j in load_jsonl(JUDS) if j.get("scores")}
    need = [g for g in gens if (g["generator"], g["qa_id"]) not in have_jud]
    log(f"llama32 need_judge={len(need)}")
    if need:
        jpath = hf_hub_download(JUDGE_REPO, JUDGE_FILE)
        log(f"judge_gguf={jpath}")
        judge_llm = Llama(model_path=jpath, n_ctx=4096, n_threads=4, verbose=False)
        for i, g in enumerate(need, 1):
            log(f"judge Llama-3.2 {i}/{len(need)} qa_id={g['qa_id']}")
            scores, raw = None, None
            for attempt in range(1, 4):
                scores, raw = judge_answer(judge_llm, g["question"], g["answer"])
                if scores:
                    break
                log(f"judge parse fail attempt {attempt}: {raw!r:.160}")
            append_jsonl(
                JUDS,
                {
                    "qa_id": g["qa_id"],
                    "generator": GEN_ID,
                    "judge": JUDGE_ID,
                    "scores": scores,
                    "raw": raw,
                },
            )

    rewrite_summary()
    data = json.loads(SUMMARY.read_text())
    by = {r["generator"]: r for r in data["summary"]}
    echo = by.get("ECHO-AI_archived")
    llama = by.get(GEN_ID)
    log(f"ECHO-AI_archived overall={echo and echo.get('overall')}")
    log(f"Llama-3.2-3B overall={llama and llama.get('overall')} n={llama and llama.get('n')}")
    log("DONE")


if __name__ == "__main__":
    main()
