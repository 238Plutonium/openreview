#!/usr/bin/env python3
"""MedTutor-aligned Llama-3.3-70B-Instruct bake-off on M=13 (same packet + judge rubric).

Generation via OpenAI-compatible API (Groq / Together / Fireworks / OpenRouter / HF router).
Judging via local Qwen2.5-1.5B-Instruct GGUF (same rubric as open CPU bake-off).

Env (first match wins for generation):
  GROQ_API_KEY | TOGETHER_API_KEY | FIREWORKS_API_KEY | OPENROUTER_API_KEY | HF_TOKEN
Optional overrides:
  LLAMA33_BASE_URL, LLAMA33_MODEL, LLAMA33_API_KEY
"""
from __future__ import annotations

import csv
import json
import os
import re
import time
import urllib.error
import urllib.request
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

GEN_ID = "meta-llama/Llama-3.3-70B-Instruct"
JUDGE_ID = "Qwen/Qwen2.5-1.5B-Instruct (Q4_K_M GGUF)"
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


def resolve_endpoint() -> tuple[str, str, str]:
    """Return (base_url, api_key, model)."""
    if os.environ.get("LLAMA33_API_KEY") and os.environ.get("LLAMA33_BASE_URL"):
        return (
            os.environ["LLAMA33_BASE_URL"].rstrip("/"),
            os.environ["LLAMA33_API_KEY"],
            os.environ.get("LLAMA33_MODEL", GEN_ID),
        )
    candidates = [
        (
            "GROQ_API_KEY",
            "https://api.groq.com/openai/v1",
            os.environ.get("LLAMA33_MODEL", "llama-3.3-70b-versatile"),
        ),
        (
            "TOGETHER_API_KEY",
            "https://api.together.xyz/v1",
            os.environ.get("LLAMA33_MODEL", "meta-llama/Llama-3.3-70B-Instruct-Turbo"),
        ),
        (
            "FIREWORKS_API_KEY",
            "https://api.fireworks.ai/inference/v1",
            os.environ.get(
                "LLAMA33_MODEL",
                "accounts/fireworks/models/llama-v3p3-70b-instruct",
            ),
        ),
        (
            "OPENROUTER_API_KEY",
            "https://openrouter.ai/api/v1",
            os.environ.get("LLAMA33_MODEL", "meta-llama/llama-3.3-70b-instruct"),
        ),
        (
            "HF_TOKEN",
            "https://router.huggingface.co/v1",
            os.environ.get("LLAMA33_MODEL", "meta-llama/Llama-3.3-70B-Instruct"),
        ),
    ]
    for env, base, model in candidates:
        key = os.environ.get(env)
        if key:
            log(f"using endpoint env={env} model={model}")
            return base, key, model
    raise SystemExit(
        "No Llama-3.3 API key. Set one of GROQ_API_KEY, TOGETHER_API_KEY, "
        "FIREWORKS_API_KEY, OPENROUTER_API_KEY, HF_TOKEN (or LLAMA33_API_KEY + LLAMA33_BASE_URL)."
    )


def http_json(url: str, headers: dict, body: dict, timeout: int = 180) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def generate_llama(base: str, key: str, model: str, question: str) -> str:
    data = http_json(
        f"{base}/chat/completions",
        {"Authorization": f"Bearer {key}"},
        {
            "model": model,
            "temperature": 0,
            "max_tokens": 400,
            "messages": [
                {"role": "system", "content": SYS},
                {"role": "user", "content": question},
            ],
        },
    )
    return data["choices"][0]["message"]["content"].strip()


def load_judge() -> Llama:
    path = hf_hub_download(JUDGE_REPO, JUDGE_FILE)
    log(f"judge_gguf={path}")
    return Llama(model_path=path, n_ctx=4096, n_threads=4, verbose=False)


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
        summary.append(
            {
                "generator": gen,
                "n": n,
                **means,
                "overall": overall,
                "judge": JUDGE_ID if gen == GEN_ID else rows and JUDGE_ID,
            }
        )
    # Preserve prior note + Llama note
    payload = {
        "summary": summary,
        "n_generations": len(load_jsonl(GENS)),
        "n_judgments_with_scores": len(juds),
        "note": (
            "Includes MedTutor-aligned Llama-3.3-70B-Instruct API generations judged by "
            "local Qwen2.5-1.5B GGUF (same rubric as open bake-off). Not MedTutor human scores."
        ),
    }
    SUMMARY.write_text(json.dumps(payload, indent=2) + "\n")
    # Refresh CSV rows for this bake-off family
    keep = []
    if CSV_PATH.exists():
        keep = [
            r
            for r in csv.DictReader(CSV_PATH.open())
            if r.get("generator") != GEN_ID
        ]
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
                    "notes": "MedTutor-aligned Llama-3.3-70B vs ECHO-AI open bake-off judge",
                }
            )
    log(f"wrote {SUMMARY.name} and refreshed {CSV_PATH.name}")


def main() -> None:
    items = load_packet()
    base, key, model = resolve_endpoint()
    have_gen = {(g["generator"], g["qa_id"]) for g in load_jsonl(GENS)}
    missing = [it for it in items if (GEN_ID, it["qa_id"]) not in have_gen]
    log(f"llama33 missing_gens={len(missing)} model={model}")

    for i, it in enumerate(missing, 1):
        log(f"generate Llama-3.3 {i}/{len(missing)} qa_id={it['qa_id']}")
        t0 = time.time()
        ans = None
        for attempt in range(1, 6):
            try:
                ans = generate_llama(base, key, model, it["question"])
                break
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")[:400]
                log(f"HTTP {e.code} attempt {attempt}: {body}")
                if e.code in {429, 503} and attempt < 5:
                    time.sleep(8 * attempt)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError) as e:
                log(f"net {type(e).__name__} attempt {attempt}")
                if attempt < 5:
                    time.sleep(8 * attempt)
                    continue
                raise
        append_jsonl(
            GENS,
            {
                "qa_id": it["qa_id"],
                "generator": GEN_ID,
                "provider_model": model,
                "question": it["question"],
                "answer": ans,
                "latency_s": round(time.time() - t0, 2),
            },
        )

    # Judge Llama rows (and any missing)
    gens = [g for g in load_jsonl(GENS) if g["generator"] == GEN_ID]
    have_jud = {(j["generator"], j["qa_id"]) for j in load_jsonl(JUDS) if j.get("scores")}
    need = [g for g in gens if (g["generator"], g["qa_id"]) not in have_jud]
    log(f"llama33 need_judge={len(need)}")
    if need:
        llm = load_judge()
        for i, g in enumerate(need, 1):
            log(f"judge Llama-3.3 {i}/{len(need)} qa_id={g['qa_id']}")
            scores, raw = None, None
            for attempt in range(1, 4):
                scores, raw = judge_answer(llm, g["question"], g["answer"])
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
    # Print ECHO vs Llama line for convenience
    data = json.loads(SUMMARY.read_text())
    by = {r["generator"]: r for r in data["summary"]}
    echo = by.get("ECHO-AI_archived")
    llama = by.get(GEN_ID)
    log(f"ECHO-AI_archived overall={echo and echo.get('overall')}")
    log(f"Llama-3.3-70B overall={llama and llama.get('overall')} n={llama and llama.get('n')}")
    log("DONE")


if __name__ == "__main__":
    main()
