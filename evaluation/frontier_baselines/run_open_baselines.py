#!/usr/bin/env python3
"""Resume-friendly open-model bake-off on the M=13 packet (CPU)."""
from __future__ import annotations

import csv
import json
import re
import time
from collections import defaultdict
from pathlib import Path

from transformers import AutoModelForCausalLM, AutoTokenizer
import torch

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent
PACKET = ROOT / "packet_qa.csv"
GENS = OUT / "open_model_generations.jsonl"
JUDS = OUT / "open_model_judgments.jsonl"
SUMMARY = OUT / "open_baseline_summary.json"

GEN_MODELS = [
    "Qwen/Qwen2.5-1.5B-Instruct",
    "HuggingFaceTB/SmolLM2-1.7B-Instruct",
]
JUDGE_ID = "Qwen/Qwen2.5-1.5B-Instruct"


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
    rows = list(csv.DictReader(PACKET.open()))
    return [
        {
            "qa_id": r["qa_id"],
            "question_type": r["question_type"],
            "question": r["standalone_question"],
            "echo_answer": r["answer"],
        }
        for r in rows
    ]


def chat_generate(model, tok, messages, max_new_tokens=220) -> str:
    prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tok(prompt, return_tensors="pt")
    out = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    return tok.decode(out[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True).strip()


def generate_answer(model, tok, question: str) -> str:
    sys = (
        "You are an educational assistant for a Project ECHO MOUD tele-mentoring session. "
        "Answer briefly for clinicians. Do not give patient-specific clinical advice. "
        "End with: Educational summary for ECHO discussion; not clinical advice or a medical record."
    )
    messages = [{"role": "system", "content": sys}, {"role": "user", "content": question}]
    return chat_generate(model, tok, messages, max_new_tokens=220)


def judge_answer(model, tok, question: str, answer: str):
    rubric = (
        "Score the educational assistant answer on a 1-5 integer scale for keys: "
        "factual, grounding, evidence, safety, usability. "
        'Return ONLY JSON like {"factual":3,"grounding":3,"evidence":3,"safety":4,"usability":4}.'
    )
    messages = [
        {"role": "system", "content": rubric},
        {"role": "user", "content": f"Question: {question}\n\nAnswer:\n{answer[:1800]}"},
    ]
    text = chat_generate(model, tok, messages, max_new_tokens=100)
    m = re.search(r"\{[^{}]+\}", text)
    if not m:
        return None, text
    try:
        scores = json.loads(m.group(0))
        vals = {k: int(scores[k]) for k in ["factual", "grounding", "evidence", "safety", "usability"]}
        if not all(1 <= v <= 5 for v in vals.values()):
            return None, text
        return vals, text
    except Exception:
        return None, text


def ensure_echo_archived(items: list[dict], existing: list[dict]) -> None:
    have = {(g["generator"], g["qa_id"]) for g in existing}
    for it in items:
        key = ("ECHO-AI_archived", it["qa_id"])
        if key in have:
            continue
        append_jsonl(
            GENS,
            {
                "qa_id": it["qa_id"],
                "generator": "ECHO-AI_archived",
                "question": it["question"],
                "answer": it["echo_answer"],
            },
        )
        log(f"wrote ECHO-AI_archived qa_id={it['qa_id']}")


def main() -> None:
    items = load_packet()
    existing = load_jsonl(GENS)
    log(f"start items={len(items)} existing_gens={len(existing)}")
    ensure_echo_archived(items, existing)
    existing = load_jsonl(GENS)

    loaded = {}
    for mid in GEN_MODELS:
        need = any(
            (mid, it["qa_id"]) not in {(g["generator"], g["qa_id"]) for g in existing}
            for it in items
        )
        # always load judge model
        if mid != JUDGE_ID and not need:
            log(f"skip load {mid} (generations complete)")
            continue
        log(f"loading {mid}")
        tok = AutoTokenizer.from_pretrained(mid)
        model = AutoModelForCausalLM.from_pretrained(mid, dtype=torch.float32, device_map="cpu")
        loaded[mid] = (model, tok)
        log(f"loaded {mid}")

    # Generate missing
    for mid in GEN_MODELS:
        have = {(g["generator"], g["qa_id"]) for g in load_jsonl(GENS)}
        missing = [it for it in items if (mid, it["qa_id"]) not in have]
        if not missing:
            log(f"generations complete for {mid}")
            continue
        if mid not in loaded:
            log(f"loading {mid} for remaining {len(missing)}")
            tok = AutoTokenizer.from_pretrained(mid)
            model = AutoModelForCausalLM.from_pretrained(mid, dtype=torch.float32, device_map="cpu")
            loaded[mid] = (model, tok)
        model, tok = loaded[mid]
        for i, it in enumerate(missing, 1):
            log(f"generate {mid} {i}/{len(missing)} qa_id={it['qa_id']}")
            t0 = time.time()
            ans = generate_answer(model, tok, it["question"])
            append_jsonl(
                GENS,
                {
                    "qa_id": it["qa_id"],
                    "generator": mid,
                    "question": it["question"],
                    "answer": ans,
                    "latency_s": round(time.time() - t0, 2),
                },
            )

    # Judge missing
    if JUDGE_ID not in loaded:
        log(f"loading judge {JUDGE_ID}")
        tok = AutoTokenizer.from_pretrained(JUDGE_ID)
        model = AutoModelForCausalLM.from_pretrained(JUDGE_ID, dtype=torch.float32, device_map="cpu")
        loaded[JUDGE_ID] = (model, tok)
    jmodel, jtok = loaded[JUDGE_ID]

    gens = load_jsonl(GENS)
    judged = {(j["generator"], j["qa_id"]) for j in load_jsonl(JUDS) if j.get("scores")}
    todo = [g for g in gens if (g["generator"], g["qa_id"]) not in judged]
    log(f"judge todo={len(todo)} already={len(judged)}")
    for i, g in enumerate(todo, 1):
        log(f"judge {i}/{len(todo)} {g['generator']} qa_id={g['qa_id']}")
        scores, raw = judge_answer(jmodel, jtok, g["question"], g["answer"])
        append_jsonl(
            JUDS,
            {
                "qa_id": g["qa_id"],
                "generator": g["generator"],
                "judge": JUDGE_ID,
                "scores": scores,
                "raw": (raw or "")[:400],
            },
        )

    # Aggregate
    agg = defaultdict(list)
    for j in load_jsonl(JUDS):
        s = j.get("scores")
        if not s:
            continue
        agg[j["generator"]].append(
            [s["factual"], s["grounding"], s["evidence"], s["safety"], s["usability"]]
        )
    summary = []
    for gen, rows in sorted(agg.items()):
        dims = list(zip(*rows))
        means = [round(sum(d) / len(d), 2) for d in dims]
        summary.append(
            {
                "generator": gen,
                "n": len(rows),
                "factual": means[0],
                "grounding": means[1],
                "evidence": means[2],
                "safety": means[3],
                "usability": means[4],
                "overall": round(sum(means) / len(means), 2),
                "judge": JUDGE_ID,
            }
        )

    # Update CSV with open baselines (keep human ECHO-AI rows)
    csv_path = OUT / "generator_baseline_scores.csv"
    lines = [
        "generator,judge,factual,grounding,evidence,safety,usability,overall,n_items,notes",
        "ECHO-AI Qwen2.5-VL-3B+Qwen3-4B,human,4.19,5.00,3.78,4.51,4.12,4.26,13,existing packet_scores_summary",
        "ECHO-AI Qwen2.5-VL-3B+Qwen3-4B,llm_qwen3_4b,4.15,3.62,3.64,5.00,4.85,4.26,13,existing llm_judge_m13_summary",
    ]
    for s in summary:
        note = "open CPU bake-off; not GPT/Claude/Gemini API"
        lines.append(
            f"{s['generator']},{s['judge']},{s['factual']},{s['grounding']},{s['evidence']},{s['safety']},{s['usability']},{s['overall']},{s['n']},{note}"
        )
    csv_path.write_text("\n".join(lines) + "\n")

    payload = {
        "summary": summary,
        "n_generations": len(load_jsonl(GENS)),
        "n_judgments_with_scores": sum(1 for j in load_jsonl(JUDS) if j.get("scores")),
        "note": (
            "Open CPU baselines on M=13 packet. GPT/Claude/Gemini require API secrets; "
            "Gemma gated without HF_TOKEN. Local judge is Qwen2.5-1.5B-Instruct (not the paper's Qwen3-4B formatter judge)."
        ),
    }
    SUMMARY.write_text(json.dumps(payload, indent=2) + "\n")
    log(f"DONE summary={json.dumps(summary)}")


if __name__ == "__main__":
    main()
