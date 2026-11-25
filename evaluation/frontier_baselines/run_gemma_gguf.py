#!/usr/bin/env python3
"""Obtain Gemma-2-2B-IT answers via ungated GGUF (no HF_TOKEN / no GPU)."""
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

GEN_ID = "google/gemma-2-2b-it (bartowski Q4_K_M GGUF)"
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
    return [
        {
            "qa_id": r["qa_id"],
            "question": r["standalone_question"],
        }
        for r in csv.DictReader(PACKET.open())
    ]


def main() -> None:
    items = load_packet()
    have = {(g["generator"], g["qa_id"]) for g in load_jsonl(GENS)}
    missing = [it for it in items if (GEN_ID, it["qa_id"]) not in have]
    log(f"gemma missing={len(missing)}")

    if missing:
        path = hf_hub_download(
            "bartowski/gemma-2-2b-it-GGUF", "gemma-2-2b-it-Q4_K_M.gguf"
        )
        log(f"gguf={path}")
        llm = Llama(model_path=path, n_ctx=2048, n_threads=4, verbose=False)
        sys = (
            "You are an educational assistant for a Project ECHO MOUD tele-mentoring session. "
            "Answer briefly for clinicians. Do not give patient-specific clinical advice. "
            "End with: Educational summary for ECHO discussion; not clinical advice or a medical record."
        )
        for i, it in enumerate(missing, 1):
            log(f"generate Gemma {i}/{len(missing)} qa_id={it['qa_id']}")
            t0 = time.time()
            # Gemma chat template rejects system role in this llama-cpp build.
            user = f"{sys}\n\nQuestion: {it['question']}"
            out = llm.create_chat_completion(
                messages=[{"role": "user", "content": user}],
                max_tokens=220,
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

    # Judge with existing Qwen 1.5B if available locally via transformers
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    log(f"loading judge {JUDGE_ID}")
    jtok = AutoTokenizer.from_pretrained(JUDGE_ID)
    jmodel = AutoModelForCausalLM.from_pretrained(
        JUDGE_ID, dtype=torch.float32, device_map="cpu"
    )

    def judge(question: str, answer: str):
        rubric = (
            "Score the educational assistant answer on a 1-5 integer scale for keys: "
            "factual, grounding, evidence, safety, usability. "
            'Return ONLY JSON like {"factual":3,"grounding":3,"evidence":3,"safety":4,"usability":4}.'
        )
        messages = [
            {"role": "system", "content": rubric},
            {"role": "user", "content": f"Question: {question}\n\nAnswer:\n{answer[:1800]}"},
        ]
        prompt = jtok.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = jtok(prompt, return_tensors="pt")
        out = jmodel.generate(**inputs, max_new_tokens=100, do_sample=False)
        text = jtok.decode(
            out[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True
        ).strip()
        m = re.search(r"\{[^{}]+\}", text, re.S)
        if not m:
            return None, text
        try:
            scores = json.loads(m.group(0))
            vals = {}
            for k in ["factual", "grounding", "evidence", "safety", "usability"]:
                vals[k] = max(1, min(5, int(scores[k])))
            return vals, text
        except Exception:
            return None, text

    gens = [g for g in load_jsonl(GENS) if g["generator"] == GEN_ID]
    judged = {
        (j["generator"], j["qa_id"])
        for j in load_jsonl(JUDS)
        if j.get("scores") and j["generator"] == GEN_ID
    }
    todo = [g for g in gens if (g["generator"], g["qa_id"]) not in judged]
    log(f"judge gemma todo={len(todo)}")
    for i, g in enumerate(todo, 1):
        log(f"judge Gemma {i}/{len(todo)} qa_id={g['qa_id']}")
        scores, raw = judge(g["question"], g["answer"])
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

    # Re-aggregate all generators with scores
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

    lines = [
        "generator,judge,factual,grounding,evidence,safety,usability,overall,n_items,notes",
        "ECHO-AI Qwen2.5-VL-3B+Qwen3-4B,human,4.19,5.00,3.78,4.51,4.12,4.26,13,existing packet_scores_summary",
        "ECHO-AI Qwen2.5-VL-3B+Qwen3-4B,llm_qwen3_4b,4.15,3.62,3.64,5.00,4.85,4.26,13,existing llm_judge_m13_summary",
    ]
    for s in summary:
        note = "open CPU bake-off"
        if "gemma" in s["generator"].lower():
            note = "Gemma-2-2B-IT via ungated bartowski Q4_K_M GGUF; no HF_TOKEN"
        lines.append(
            f"{s['generator']},{s['judge']},{s['factual']},{s['grounding']},{s['evidence']},{s['safety']},{s['usability']},{s['overall']},{s['n']},{note}"
        )
    CSV_PATH.write_text("\n".join(lines) + "\n")
    payload = {
        "summary": summary,
        "n_generations": len(load_jsonl(GENS)),
        "n_judgments_with_scores": sum(1 for j in load_jsonl(JUDS) if j.get("scores")),
        "note": (
            "Includes Gemma-2-2B-IT GGUF. GPT/Claude/Gemini still need API secrets. "
            "Local judge remains Qwen2.5-1.5B-Instruct."
        ),
    }
    SUMMARY.write_text(json.dumps(payload, indent=2) + "\n")
    log(f"DONE gemma summary={json.dumps([s for s in summary if 'gemma' in s['generator'].lower()])}")


if __name__ == "__main__":
    main()
