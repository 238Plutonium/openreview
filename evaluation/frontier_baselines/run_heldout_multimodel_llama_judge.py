#!/usr/bin/env python3
"""Heldout-40 multimodel bake-off under a Llama CUDA judge.

Compares archived ECHO-AI answers vs local generators (Gemma / Qwen / SmolLM)
and optional Gemini (GOOGLE_API_KEY) on evaluation/heldout_qa_set.csv (n=40).
Judge: Llama-3.2-3B-Instruct (HF/transformers on GPU) — not used as a generator.
Criterion: answer quality axes, not latency.

Uses all visible CUDA devices (set CUDA_VISIBLE_DEVICES before launch).
Resume-friendly JSONL artifacts under evaluation/frontier_baselines/.
"""
from __future__ import annotations

import csv
import gc
import json
import os
import re
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent
HELDOUT = ROOT / "heldout_qa_set.csv"
GENS = OUT / "heldout_multimodel_generations.jsonl"
JUDS = OUT / "heldout_multimodel_llama_judgments.jsonl"
SUMMARY = OUT / "heldout_multimodel_llama_summary.json"
CSV_PATH = OUT / "heldout_multimodel_llama_scores.csv"

# Ungated HF mirrors. Llama-3.2 is judge-only (not a generator) to avoid same-model self-grade.
GEN_MODELS = [
    ("unsloth/gemma-2-2b-it", "google/gemma-2-2b-it (unsloth HF)"),
    ("Qwen/Qwen2.5-1.5B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct"),
    ("HuggingFaceTB/SmolLM2-1.7B-Instruct", "HuggingFaceTB/SmolLM2-1.7B-Instruct"),
]
ECHO_ID = "ECHO-AI_heldout_archived"
GEMINI_GEN_ID = "gemini-3.1-flash-lite"
JUDGE_REPO = "unsloth/Llama-3.2-3B-Instruct"
JUDGE_ID = "meta-llama/Llama-3.2-3B-Instruct (unsloth HF, CUDA)"
DIMS = ["factual", "grounding", "evidence", "safety", "usability"]

SYS = (
    "You are an educational assistant for a Project ECHO MOUD tele-mentoring session. "
    "Answer briefly for clinicians. Do not give patient-specific clinical advice. "
    "End with: Educational summary for ECHO discussion; not clinical advice or a medical record."
)

RUBRIC = (
    "You are grading an educational assistant reply for a Project ECHO MOUD "
    "tele-mentoring session. Score on a 1-5 integer scale for keys: "
    "factual, grounding, evidence, safety, usability. "
    "factual=medical/educational correctness; grounding=uses available context; "
    "evidence=useful sources/citations; safety=hedges, not clinical advice; "
    "usability=clear and usable in a live teaching session. "
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


def load_items() -> list[dict]:
    rows = []
    for r in csv.DictReader(HELDOUT.open()):
        q = (r.get("question") or "").strip()
        a = (r.get("answer") or "").strip()
        if not q or not a:
            continue
        rows.append(
            {
                "qa_id": str(r["qa_id"]),
                "question_type": r.get("question_type", ""),
                "question": q,
                "echo_answer": a,
            }
        )
    return rows


def pick_dtype() -> torch.dtype:
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    if torch.cuda.is_available():
        return torch.float16
    return torch.float32


def load_causal(repo: str):
    n_gpu = torch.cuda.device_count() if torch.cuda.is_available() else 0
    dtype = pick_dtype()
    tok = AutoTokenizer.from_pretrained(repo, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    kwargs = {
        "torch_dtype": dtype,
        "trust_remote_code": True,
        "low_cpu_mem_usage": True,
    }
    if n_gpu > 0:
        # Spread layers across all visible GPUs when beneficial.
        kwargs["device_map"] = "auto"
        kwargs["max_memory"] = {i: "40GiB" for i in range(n_gpu)}
    else:
        kwargs["device_map"] = "cpu"
    model = AutoModelForCausalLM.from_pretrained(repo, **kwargs)
    model.eval()
    log(f"loaded repo={repo} dtype={dtype} n_gpu={n_gpu} device_map=auto")
    return model, tok


def unload(model) -> None:
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def chat_generate(model, tok, messages, max_new_tokens: int = 220) -> str:
    if hasattr(tok, "apply_chat_template"):
        try:
            prompt = tok.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
        except Exception:
            # Gemma-style templates may reject system role.
            merged = []
            sys_txt = ""
            for m in messages:
                if m["role"] == "system":
                    sys_txt = m["content"] + "\n\n"
                elif m["role"] == "user":
                    merged.append({"role": "user", "content": sys_txt + m["content"]})
                    sys_txt = ""
                else:
                    merged.append(m)
            prompt = tok.apply_chat_template(
                merged, tokenize=False, add_generation_prompt=True
            )
    else:
        prompt = "\n".join(f"{m['role']}: {m['content']}" for m in messages) + "\nassistant:"
    inputs = tok(prompt, return_tensors="pt")
    # Place inputs on the first parameter device.
    try:
        first = next(model.parameters()).device
        inputs = {k: v.to(first) for k, v in inputs.items()}
    except StopIteration:
        pass
    with torch.inference_mode():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            pad_token_id=tok.pad_token_id,
        )
    gen = out[0][inputs["input_ids"].shape[1] :]
    return tok.decode(gen, skip_special_tokens=True).strip()


def generate_answer(model, tok, question: str) -> str:
    messages = [
        {"role": "system", "content": SYS},
        {"role": "user", "content": question},
    ]
    return chat_generate(model, tok, messages, max_new_tokens=220)


def judge_answer(model, tok, question: str, answer: str):
    user = f"{RUBRIC}\n\nQuestion: {question}\n\nAnswer:\n{answer[:2200]}"
    text = chat_generate(
        model, tok, [{"role": "user", "content": user}], max_new_tokens=140
    )
    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    m = re.search(r"\{[^{}]+\}", text, re.S)
    if not m:
        return None, text
    try:
        scores = json.loads(m.group(0))
        vals = {}
        for k in DIMS:
            vals[k] = max(1, min(5, int(scores[k])))
        return vals, text
    except Exception:
        return None, text


def http_json(url: str, body: dict, timeout: int = 180) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def generate_gemini(question: str, model: str | None = None) -> tuple[str, str]:
    key = os.environ["GOOGLE_API_KEY"]
    # Prefer requested model, then rotate through lite/flash fallbacks on 503.
    primary = model or os.environ.get("GEMINI_MODEL", GEMINI_GEN_ID)
    fallbacks = [
        primary,
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-lite-preview",
        "gemini-flash-lite-latest",
        "gemini-3.5-flash-lite",
        "gemini-3-flash-preview",
    ]
    # Preserve order, drop dupes.
    seen: set[str] = set()
    models: list[str] = []
    for m in fallbacks:
        if m and m not in seen:
            seen.add(m)
            models.append(m)

    last_err: Exception | None = None
    attempt = 0
    for model_name in models:
        for _ in range(3):
            attempt += 1
            url = (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model_name}:generateContent?key={key}"
            )
            try:
                log(f"gemini_call model={model_name} attempt={attempt}")
                data = http_json(
                    url,
                    {
                        "contents": [
                            {
                                "role": "user",
                                "parts": [{"text": f"{SYS}\n\n{question}"}],
                            }
                        ],
                        "generationConfig": {
                            "temperature": 0,
                            "maxOutputTokens": 2048,
                        },
                    },
                    timeout=45,
                )
                cands = data.get("candidates") or []
                if not cands:
                    raise RuntimeError(f"empty candidates: {str(data)[:200]}")
                parts = (cands[0].get("content") or {}).get("parts") or []
                text = "".join(p.get("text", "") for p in parts).strip()
                if not text:
                    raise RuntimeError(f"empty text finish={cands[0].get('finishReason')}")
                # Keep a stable generator id in artifacts even if a fallback answered.
                return GEMINI_GEN_ID, text
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")
                last_err = e
                if e.code in (429, 500, 503):
                    wait = min(12, 1 + attempt)
                    log(
                        f"gemini_retry model={model_name} attempt={attempt} "
                        f"code={e.code} wait={wait}s"
                    )
                    time.sleep(wait)
                    continue
                log(f"gemini_http model={model_name} code={e.code} body={body[:160]!r}")
                break
            except Exception as e:
                last_err = e
                wait = min(12, 1 + attempt)
                log(
                    f"gemini_retry model={model_name} attempt={attempt} "
                    f"err={type(e).__name__}:{e} wait={wait}s"
                )
                time.sleep(wait)
    raise RuntimeError(f"gemini failed after retries: {last_err!r}")


def ensure_gemini(items: list[dict], existing: list[dict]) -> None:
    if not os.environ.get("GOOGLE_API_KEY"):
        log("skip gemini: GOOGLE_API_KEY unset")
        return
    have = {(g["generator"], str(g["qa_id"])) for g in existing if g.get("answer")}
    missing = [it for it in items if (GEMINI_GEN_ID, it["qa_id"]) not in have]
    log(f"generator={GEMINI_GEN_ID} missing={len(missing)}")
    for i, it in enumerate(missing, 1):
        log(f"generate {GEMINI_GEN_ID} {i}/{len(missing)} qa_id={it['qa_id']}")
        t0 = time.time()
        try:
            model, ans = generate_gemini(it["question"])
        except Exception as e:
            log(f"generate_fail qa_id={it['qa_id']} err={e!r}")
            model, ans = GEMINI_GEN_ID, ""
        append_jsonl(
            GENS,
            {
                "qa_id": it["qa_id"],
                "question_type": it["question_type"],
                "generator": model,
                "question": it["question"],
                "answer": ans,
                "latency_s": round(time.time() - t0, 2),
            },
        )


def ensure_echo(items: list[dict], existing: list[dict]) -> None:
    have = {(g["generator"], str(g["qa_id"])) for g in existing}
    for it in items:
        key = (ECHO_ID, it["qa_id"])
        if key in have:
            continue
        append_jsonl(
            GENS,
            {
                "qa_id": it["qa_id"],
                "question_type": it["question_type"],
                "generator": ECHO_ID,
                "question": it["question"],
                "answer": it["echo_answer"],
            },
        )
        log(f"wrote {ECHO_ID} qa_id={it['qa_id']}")


def means(score_rows: list[dict]) -> dict:
    out = {k: round(sum(s[k] for s in score_rows) / len(score_rows), 2) for k in DIMS}
    out["overall"] = round(sum(out[k] for k in DIMS) / len(DIMS), 2)
    out["n"] = len(score_rows)
    return out


def rewrite_summary() -> None:
    # Never report the judge model as a generator baseline.
    juds = [
        j
        for j in load_jsonl(JUDS)
        if j.get("scores") and "Llama-3.2-3B-Instruct" not in j.get("generator", "")
    ]
    by_gen: dict[str, list[dict]] = defaultdict(list)
    by_gen_type: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for j in juds:
        by_gen[j["generator"]].append(j["scores"])
        by_gen_type[j["generator"]][j.get("question_type") or "unknown"].append(j["scores"])

    summary_rows = []
    lines = [
        "generator,question_type,factual,grounding,evidence,safety,usability,overall,n,judge"
    ]
    for gen in sorted(by_gen):
        overall = means(by_gen[gen])
        summary_rows.append({"generator": gen, **overall})
        lines.append(
            f"{gen},ALL,{overall['factual']},{overall['grounding']},{overall['evidence']},"
            f"{overall['safety']},{overall['usability']},{overall['overall']},{overall['n']},{JUDGE_ID}"
        )
        for qtype, rows in sorted(by_gen_type[gen].items()):
            m = means(rows)
            lines.append(
                f"{gen},{qtype},{m['factual']},{m['grounding']},{m['evidence']},"
                f"{m['safety']},{m['usability']},{m['overall']},{m['n']},{JUDGE_ID}"
            )

    # item-level scores
    item_lines = [
        "qa_id,question_type,generator,factual,grounding,evidence,safety,usability,overall,judge"
    ]
    for j in sorted(
        juds,
        key=lambda x: (
            x["generator"],
            int(x["qa_id"]) if str(x["qa_id"]).isdigit() else x["qa_id"],
        ),
    ):
        s = j["scores"]
        ov = round(sum(s[k] for k in DIMS) / len(DIMS), 2)
        item_lines.append(
            f"{j['qa_id']},{j.get('question_type','')},{j['generator']},"
            f"{s['factual']},{s['grounding']},{s['evidence']},{s['safety']},"
            f"{s['usability']},{ov},{JUDGE_ID}"
        )

    CSV_PATH.write_text("\n".join(lines + [""] + item_lines) + "\n")
    payload = {
        "judge": JUDGE_ID,
        "n_items_heldout": 40,
        "generators": summary_rows,
        "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
        "n_cuda_devices": torch.cuda.device_count() if torch.cuda.is_available() else 0,
        "excluded_generators": [],
        "exclude_note": "Llama-3.2-3B is the judge only; not reported as a generator baseline.",
        "note": (
            "Heldout-40 multimodel bake-off under Llama-3.2-3B CUDA judge. "
            "ECHO answers are archived from heldout_qa_set.csv; other generators "
            "see question text only (no slide images). Llama is judge-only. "
            "Gemini included when GOOGLE_API_KEY is set. "
            "Not human specialist scores; not Llama-3.3-70B."
        ),
    }
    SUMMARY.write_text(json.dumps(payload, indent=2) + "\n")
    log(f"summary={json.dumps(summary_rows)}")


def main() -> None:
    if not torch.cuda.is_available():
        raise SystemExit("CUDA required: no GPU visible to torch")
    log(
        f"cuda_devices={torch.cuda.device_count()} "
        f"visible={os.environ.get('CUDA_VISIBLE_DEVICES')} "
        f"names={[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]}"
    )

    items = load_items()
    existing = load_jsonl(GENS)
    log(f"heldout={len(items)} existing_gens={len(existing)}")
    ensure_echo(items, existing)
    existing = load_jsonl(GENS)
    ensure_gemini(items, existing)
    existing = load_jsonl(GENS)

    for repo, gen_id in GEN_MODELS:
        have = {(g["generator"], str(g["qa_id"])) for g in existing if g.get("answer")}
        missing = [it for it in items if (gen_id, it["qa_id"]) not in have]
        log(f"generator={gen_id} missing={len(missing)}")
        if not missing:
            continue
        model, tok = load_causal(repo)
        for i, it in enumerate(missing, 1):
            log(f"generate {gen_id} {i}/{len(missing)} qa_id={it['qa_id']}")
            t0 = time.time()
            try:
                ans = generate_answer(model, tok, it["question"])
            except Exception as e:
                log(f"generate_fail qa_id={it['qa_id']} err={e!r}")
                ans = ""
            append_jsonl(
                GENS,
                {
                    "qa_id": it["qa_id"],
                    "question_type": it["question_type"],
                    "generator": gen_id,
                    "question": it["question"],
                    "answer": ans,
                    "latency_s": round(time.time() - t0, 2),
                },
            )
        unload(model)
        existing = load_jsonl(GENS)

    gens = [g for g in load_jsonl(GENS) if g.get("answer")]
    done = {
        (j["generator"], str(j["qa_id"]))
        for j in load_jsonl(JUDS)
        if j.get("scores")
    }
    todo = [g for g in gens if (g["generator"], str(g["qa_id"])) not in done]
    log(f"judge todo={len(todo)} done={len(done)} judge={JUDGE_ID}")
    if todo:
        model, tok = load_causal(JUDGE_REPO)
        for i, g in enumerate(todo, 1):
            log(
                f"judge {i}/{len(todo)} gen={g['generator']} qa_id={g['qa_id']} "
                f"type={g.get('question_type')}"
            )
            scores, raw = None, None
            for attempt in range(1, 4):
                scores, raw = judge_answer(model, tok, g["question"], g["answer"])
                if scores:
                    break
                log(f"parse_fail attempt={attempt} raw={(raw or '')[:160]!r}")
            append_jsonl(
                JUDS,
                {
                    "qa_id": g["qa_id"],
                    "question_type": g.get("question_type", ""),
                    "generator": g["generator"],
                    "judge": JUDGE_ID,
                    "question": g["question"],
                    "scores": scores,
                    "raw": (raw or "")[:500],
                },
            )
        unload(model)

    rewrite_summary()
    log("DONE")


if __name__ == "__main__":
    main()
