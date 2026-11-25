#!/usr/bin/env python3
"""Frontier API bake-off (GPT / Claude / Gemini) on M=13. Requires secrets."""
from __future__ import annotations

import csv
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent
PACKET = ROOT / "packet_qa.csv"
GENS = OUT / "api_model_generations.jsonl"
JUDS = OUT / "api_model_judgments.jsonl"
CSV_PATH = OUT / "generator_baseline_scores.csv"

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


def http_json(url: str, headers: dict, body: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def gen_openai(question: str) -> tuple[str, str]:
    key = os.environ["OPENAI_API_KEY"]
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    data = http_json(
        "https://api.openai.com/v1/chat/completions",
        {"Authorization": f"Bearer {key}"},
        {
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": SYS},
                {"role": "user", "content": question},
            ],
        },
    )
    return model, data["choices"][0]["message"]["content"].strip()


def gen_anthropic(question: str) -> tuple[str, str]:
    key = os.environ["ANTHROPIC_API_KEY"]
    model = os.environ.get("ANTHROPIC_MODEL", "claude-3-5-haiku-latest")
    data = http_json(
        "https://api.anthropic.com/v1/messages",
        {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
        {
            "model": model,
            "max_tokens": 400,
            "temperature": 0,
            "system": SYS,
            "messages": [{"role": "user", "content": question}],
        },
    )
    text = "".join(
        b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
    )
    return model, text.strip()


def gen_gemini(question: str) -> tuple[str, str]:
    key = os.environ["GOOGLE_API_KEY"]
    model = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={key}"
    )
    data = http_json(
        url,
        {},
        {
            "contents": [{"role": "user", "parts": [{"text": f"{SYS}\n\n{question}"}]}],
            "generationConfig": {"temperature": 0, "maxOutputTokens": 400},
        },
    )
    parts = data["candidates"][0]["content"]["parts"]
    text = "".join(p.get("text", "") for p in parts)
    return model, text.strip()


PROVIDERS = {
    "openai": ("OPENAI_API_KEY", gen_openai),
    "anthropic": ("ANTHROPIC_API_KEY", gen_anthropic),
    "gemini": ("GOOGLE_API_KEY", gen_gemini),
}


def main() -> None:
    items = [
        {"qa_id": r["qa_id"], "question": r["standalone_question"]}
        for r in csv.DictReader(PACKET.open())
    ]
    available = []
    for name, (env, fn) in PROVIDERS.items():
        if os.environ.get(env):
            available.append((name, fn))
            log(f"secret present: {env}")
        else:
            log(f"secret MISSING: {env}")
    if not available:
        raise SystemExit("No API secrets available; abort.")

    have = {(g["generator"], g["qa_id"]) for g in load_jsonl(GENS)}
    for name, fn in available:
        for it in items:
            # generator id filled after first call; use provider prefix for resume keys
            prior = [
                g
                for g in load_jsonl(GENS)
                if g["qa_id"] == it["qa_id"] and g.get("provider") == name
            ]
            if prior:
                continue
            log(f"generate {name} qa_id={it['qa_id']}")
            t0 = time.time()
            try:
                model, ans = fn(it["question"])
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")[:300]
                log(f"HTTP {e.code} {name}: {body}")
                raise
            append_jsonl(
                GENS,
                {
                    "qa_id": it["qa_id"],
                    "provider": name,
                    "generator": model,
                    "question": it["question"],
                    "answer": ans,
                    "latency_s": round(time.time() - t0, 2),
                },
            )
    log(f"DONE generations={len(load_jsonl(GENS))}")
    log("Judging: reuse open_model judge or human panel; scores not auto-merged here.")


if __name__ == "__main__":
    main()
