#!/usr/bin/env python3
"""Context-routing vs competing methods (portable offline + archived E2E).

Paths resolve relative to this package / its parent ``evaluation`` (or ``eval``)
directory—no absolute lab usernames required.

Gold labels are **category-derived** (speech-ablation cases → speech; paired
no-frame → visual; packet/heldout ``question_type`` → focus/intent) plus a few
synthetic intent probes. They are **not** independently double-annotated.

Optional LLM baselines need ``ECHO_VLLM_URL`` (default ``http://127.0.0.1:8001/v1``).
Without a live endpoint, rule / always-* baselines and archived E2E still run.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import statistics
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EVAL_ROOT = ROOT.parent  # .../evaluation or .../eval
OUT = ROOT
DEFAULT_VLLM = os.environ.get("ECHO_VLLM_URL", "http://127.0.0.1:8001/v1").rstrip("/")
MODEL = os.environ.get("ECHO_JUDGE_MODEL", "Qwen/Qwen3-4B-Instruct-2507")

SPEECH_WORD = re.compile(
    r"\b(?:say|said|says|saying|hear|heard|hearing|speak|spoke|spoken|speaking|"
    r"talk|talks|talked|talking|discuss|discussed|discussing|mention|mentioned|"
    r"mentioning|repeat|repeated|repeating)\b",
    re.I,
)
VISUAL_WORD = re.compile(
    r"\b(?:slides?|screens?|images?|pictures?|photos?|diagrams?|figures?|charts?|"
    r"shown|display(?:ed|ing)?|pages?)\b",
    re.I,
)
SCREEN_SAYS = re.compile(
    r"\b(?:slides?|screens?|images?|pictures?|photos?|diagrams?|figures?|charts?|pages?)\b"
    r"(?:\s+\S+){0,3}\s+\b(?:says?|said|show[sn]?|shown|tells?|reads?)\b",
    re.I,
)
READS_SCREEN = re.compile(
    r"\b(?:says?|said|show[sn]?|shown|tells?|reads?)\b(?:\s+(?:on|in|from|the|my|this|a)){0,4}\s+"
    r"\b(?:slides?|screens?|images?|pictures?|photos?|diagrams?|figures?|charts?|pages?)\b",
    re.I,
)


def _find(*rel_candidates: str) -> Path | None:
    for rel in rel_candidates:
        p = EVAL_ROOT / rel
        if p.exists():
            return p
        p2 = ROOT / rel
        if p2.exists():
            return p2
    return None


def echo_question_focus(question: str) -> str:
    has_speech = bool(SPEECH_WORD.search(question))
    has_visual = bool(VISUAL_WORD.search(question))
    asks_screen = bool(SCREEN_SAYS.search(question) or READS_SCREEN.search(question))
    if has_visual and asks_screen:
        return "visual"
    if has_speech:
        return "speech"
    if has_visual:
        return "visual"
    return "general"


def echo_retrieval_intent(question: str) -> str:
    n = question.lower()
    historical = bool(
        re.search(
            r"\b(similar|previous|prior|historical|past|comparable)\s+(case|patient|presentation)s?\b",
            n,
        )
        or re.search(
            r"\b(?:from|in|based on|according to|using|search|check|look up|retrieve|find|compare|across)\s+"
            r"(?:the\s+)?(?:previous|prior|past|historical|old|earlier)\s+(?:echo\s+)?"
            r"(?:video|videos|recording|recordings|session|sessions|meeting|meetings|transcript|transcripts)\b",
            n,
        )
        or re.search(
            r"\b(?:previous|prior|past|historical|old|earlier)\s+(?:echo\s+)?"
            r"(?:video|videos|recording|recordings|session|sessions|meeting|meetings|transcript|transcripts)\b",
            n,
        )
        or re.search(r"\b(case|patient)\s+(history|series|comparison)\b", n)
    )
    literature = bool(
        re.search(
            r"\b(evidence|study|studies|research|literature|pubmed|medpub|paper|papers|article|articles|"
            r"reference|references|guideline|trial|meta-analysis|systematic review|risk comparison|"
            r"treatment option|standard of care|best practice|recommen\w*)\b",
            n,
        )
    )
    if historical and literature:
        return "both"
    if historical:
        return "historical-cases"
    if literature:
        return "literature"
    return "none"


def chat(system: str, user: str, max_tokens: int = 16) -> tuple[str, float]:
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    url = f"{DEFAULT_VLLM}/chat/completions"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = json.load(resp)["choices"][0]["message"]["content"].strip()
    return text, time.perf_counter() - t0


def llm_focus(question: str) -> tuple[str, float]:
    raw, sec = chat(
        "Reply with only: speech, visual, or general.",
        "Classify the meeting question focus. Reply with ONLY one token: "
        "speech, visual, or general.\n"
        "speech = asking what someone said aloud.\n"
        "visual = asking what is on the slide/screen.\n"
        "general = neither.\n\n"
        f"Question: {question}",
    )
    low = raw.lower()
    for lab in ("speech", "visual", "general"):
        if lab in low:
            return lab, sec
    return "general", sec


def llm_retrieval_intent(question: str) -> tuple[str, float]:
    raw, sec = chat(
        "Reply with only one label: literature, historical-cases, both, or none.",
        "Classify retrieval intent for a Project ECHO meeting assistant. "
        "Reply with ONLY one token from: literature, historical-cases, both, none.\n"
        "literature = needs PubMed/guidelines/papers.\n"
        "historical-cases = needs prior ECHO session / past cases.\n"
        "both = needs both.\n"
        "none = no external retrieval.\n\n"
        f"Question: {question}",
    )
    low = raw.lower().replace("_", "-").replace(" ", "-")
    for lab in ("historical-cases", "literature", "both", "none"):
        if lab in low or lab.replace("-", " ") in raw.lower():
            return lab, sec
    if "historical" in low or "prior" in low or "session" in low:
        return "historical-cases", sec
    if "liter" in low or "pubmed" in low:
        return "literature", sec
    return "none", sec


def llm_available() -> bool:
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"{DEFAULT_VLLM}/models"), timeout=3
        )
        return True
    except Exception:
        try:
            llm_focus("What did the facilitator say?")
            return True
        except Exception:
            return False


def build_focus_gold() -> list[dict]:
    """Category-derived gold (not independent annotation)."""
    items: list[dict] = []
    speech_path = _find("speech_recall_ablation/cases.jsonl")
    if not speech_path:
        raise FileNotFoundError("speech_recall_ablation/cases.jsonl not found under evaluation/")
    for line in speech_path.read_text(encoding="utf-8").splitlines():
        o = json.loads(line)
        items.append(
            {
                "id": str(o.get("id") or o.get("case_id")),
                "question": o["question"],
                "gold_focus": "speech",
                "source": "speech_ablation",
                "gold_provenance": "category: speech-conflict ablation cases (designed as speech asks)",
            }
        )
    paired_path = _find("recorded_replay/paired_cases.json", "paired_cases.json")
    if not paired_path:
        raise FileNotFoundError("paired_cases.json not found")
    for o in json.loads(paired_path.read_text(encoding="utf-8")):
        items.append(
            {
                "id": o["id"],
                "question": o["question"],
                "gold_focus": "visual",
                "source": "noframe_paired",
                "gold_provenance": "category: zero-frame visual paired cases",
            }
        )
    packet_path = _find("packet_qa.csv")
    if packet_path:
        for r in csv.DictReader(packet_path.open(encoding="utf-8")):
            qt = (r.get("question_type") or "").lower()
            q = r.get("standalone_question") or r.get("original_chat_question") or ""
            if not q.strip():
                continue
            gold = "visual" if qt == "slide" else "general"
            items.append(
                {
                    "id": f"packet:{r['qa_id']}",
                    "question": q,
                    "gold_focus": gold,
                    "source": "packet",
                    "gold_provenance": f"category: packet question_type={qt} → focus={gold}",
                }
            )
    return items


def build_retrieval_gold() -> list[dict]:
    items: list[dict] = []

    def add(rows, id_prefix: str, q_key: str, source: str):
        for r in rows:
            qt = (r.get("question_type") or "").lower()
            q = r.get(q_key) or ""
            if not q.strip():
                continue
            if qt == "literature":
                gold = "literature"
            elif qt == "prior_session":
                gold = "historical-cases"
            else:
                gold = "none"
            items.append(
                {
                    "id": f"{id_prefix}:{r.get('qa_id')}",
                    "question": q,
                    "gold_intent": gold,
                    "source": source,
                    "gold_provenance": f"category: question_type={qt} → intent={gold}",
                }
            )

    packet = _find("packet_qa.csv")
    if packet:
        add(list(csv.DictReader(packet.open(encoding="utf-8"))), "packet", "standalone_question", "packet")
    held = _find("heldout_qa_set_echo_only.csv", "heldout_qa_set.csv")
    if held:
        rows = list(csv.DictReader(held.open(encoding="utf-8")))
        for r in rows:
            qt = (r.get("question_type") or "").lower()
            q = r.get("question") or r.get("standalone_question") or ""
            if not q.strip():
                continue
            if qt == "literature":
                gold = "literature"
            elif qt == "prior_session":
                gold = "historical-cases"
            else:
                gold = "none"
            items.append(
                {
                    "id": f"heldout:{r.get('qa_id')}",
                    "question": q,
                    "gold_intent": gold,
                    "source": "heldout",
                    "gold_provenance": f"category: question_type={qt} → intent={gold}",
                }
            )

    synth = [
        ("syn:lit1", "What does PubMed say about buprenorphine induction guidelines?", "literature"),
        ("syn:lit2", "Cite medical literature on CBT-I for insomnia", "literature"),
        ("syn:hist1", "What did we discuss about this patient in the previous ECHO session?", "historical-cases"),
        ("syn:hist2", "Search prior session transcripts for similar MOUD cases", "historical-cases"),
        ("syn:none1", "What time does the meeting start?", "none"),
        ("syn:none2", "Who is presenting next?", "none"),
    ]
    for i, q, g in synth:
        items.append(
            {
                "id": i,
                "question": q,
                "gold_intent": g,
                "source": "synthetic",
                "gold_provenance": "synthetic probe authored for intent coverage (not independent annotation)",
            }
        )
    return items


def intent_match(pred: str, gold: str) -> bool:
    return pred == gold or (pred == "both" and gold in {"literature", "historical-cases"})


def accuracy(flags: list[bool]) -> float:
    return sum(flags) / len(flags) if flags else 0.0


def load_e2e() -> dict:
    speech_path = _find("speech_recall_ablation/runs/speech_summary.json", "speech_summary.json")
    if not speech_path:
        # fall back to packaged copy
        speech_path = ROOT / "speech_summary.json"
    speech = json.loads(speech_path.read_text(encoding="utf-8")) if speech_path.exists() else None

    nf_path = _find("paired_zero_frame.csv")
    e2e: dict = {}
    if speech:
        e2e["speech_conflict_routing"] = {
            "echo_withhold_frames_on_speech": {
                "spoken_token_rate": speech["arms"]["withheld"]["case_mean_token_rates"]["spoken_token_present"],
                "slide_token_rate": speech["arms"]["withheld"]["case_mean_token_rates"]["slide_token_present"],
                "n_calls": speech["arms"]["withheld"]["successful"],
            },
            "competitor_always_attach_frame": {
                "spoken_token_rate": speech["arms"]["included"]["case_mean_token_rates"]["spoken_token_present"],
                "slide_token_rate": speech["arms"]["included"]["case_mean_token_rates"]["slide_token_present"],
                "n_calls": speech["arms"]["included"]["successful"],
            },
            "delta_withheld_minus_always_frame": speech.get("paired_withheld_minus_included"),
            "source_file": str(speech_path.relative_to(EVAL_ROOT) if speech_path.is_relative_to(EVAL_ROOT) else speech_path.name),
        }
    if nf_path:
        nf = list(csv.DictReader(nf_path.open(encoding="utf-8")))

        def refuse(label: str) -> bool:
            return str(label).strip().lower() in {"refuse", "abstain", "cannot-see", "cannot_see"}

        on = [r for r in nf if r["condition"].strip().lower() in {"baseline", "guard_on", "on"}]
        off = [r for r in nf if r["condition"].strip().lower() in {"treatment", "guard_off", "off"}]
        e2e["visual_missing_frame_routing"] = {
            "echo_no_frame_guard_on": {"abstain": sum(1 for r in on if refuse(r["label"])), "n": len(on)},
            "competitor_guard_off_still_draft": {
                "abstain": sum(1 for r in off if refuse(r["label"])),
                "n": len(off),
            },
            "source_file": str(nf_path.relative_to(EVAL_ROOT) if nf_path.is_relative_to(EVAL_ROOT) else nf_path.name),
        }
    return e2e


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-llm", action="store_true", help="Skip LLM focus/intent baselines")
    args = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    focus_items = build_focus_gold()
    ret_items = build_retrieval_gold()
    (OUT / "gold_focus.jsonl").write_text(
        "\n".join(json.dumps(x, ensure_ascii=False) for x in focus_items) + "\n", encoding="utf-8"
    )
    (OUT / "gold_retrieval.jsonl").write_text(
        "\n".join(json.dumps(x, ensure_ascii=False) for x in ret_items) + "\n", encoding="utf-8"
    )

    use_llm = (not args.skip_llm) and llm_available()
    print(f"EVAL_ROOT={EVAL_ROOT}")
    print(f"LLM baselines: {'on '+DEFAULT_VLLM if use_llm else 'skipped'}")

    pred_rows: list[dict] = []
    focus_summary: dict = {}
    latency: dict = {}

    # --- focus ---
    methods_focus = {
        "echo_rule_router": lambda q: (echo_question_focus(q), None),
        "always_speech": lambda q: ("speech", None),
        "always_visual": lambda q: ("visual", None),
        "always_general": lambda q: ("general", None),
    }
    if use_llm:
        methods_focus["llm_router_qwen3_4b"] = llm_focus

    for name, fn in methods_focus.items():
        preds: list[str] = []
        secs: list[float] = []
        for it in focus_items:
            t0 = time.perf_counter()
            out = fn(it["question"])
            if isinstance(out, tuple):
                pred, sec = out
                if sec is None:
                    sec = time.perf_counter() - t0
            else:
                pred, sec = out, time.perf_counter() - t0
            preds.append(pred)
            secs.append(sec)
            pred_rows.append(
                {
                    "task": "focus",
                    "method": name,
                    "id": it["id"],
                    "source": it["source"],
                    "question": it["question"][:200],
                    "gold": it["gold_focus"],
                    "pred": pred,
                    "correct": int(pred == it["gold_focus"]),
                    "latency_s": round(sec, 6),
                    "gold_provenance": it["gold_provenance"],
                }
            )
        golds = [it["gold_focus"] for it in focus_items]
        focus_summary[name] = {
            "n": len(golds),
            "accuracy": sum(p == g for p, g in zip(preds, golds)) / len(golds),
            "latency_mean_s": statistics.mean(secs),
            "latency_median_s": statistics.median(secs),
            "latency_p95_s": sorted(secs)[max(0, int(0.95 * (len(secs) - 1)))],
        }
        print("focus", name, focus_summary[name])

    latency["focus_rule_vs_llm"] = None
    if "llm_router_qwen3_4b" in focus_summary:
        latency["focus_rule_vs_llm"] = {
            "rule_mean_s": focus_summary["echo_rule_router"]["latency_mean_s"],
            "llm_mean_s": focus_summary["llm_router_qwen3_4b"]["latency_mean_s"],
            "speedup_rule_over_llm": focus_summary["llm_router_qwen3_4b"]["latency_mean_s"]
            / max(focus_summary["echo_rule_router"]["latency_mean_s"], 1e-9),
        }

    # --- retrieval intent ---
    methods_ret = {
        "echo_rule_router": lambda q: (echo_retrieval_intent(q), None),
        "always_literature": lambda q: ("literature", None),
        "always_historical": lambda q: ("historical-cases", None),
        "always_none": lambda q: ("none", None),
    }
    if use_llm:
        methods_ret["llm_intent_qwen3_4b"] = llm_retrieval_intent

    ret_summary: dict = {}
    for name, fn in methods_ret.items():
        flags: list[bool] = []
        secs: list[float] = []
        for it in ret_items:
            t0 = time.perf_counter()
            out = fn(it["question"])
            if isinstance(out, tuple):
                pred, sec = out
                if sec is None:
                    sec = time.perf_counter() - t0
            else:
                pred, sec = out, time.perf_counter() - t0
            ok = intent_match(pred, it["gold_intent"])
            flags.append(ok)
            secs.append(sec)
            pred_rows.append(
                {
                    "task": "retrieval_intent",
                    "method": name,
                    "id": it["id"],
                    "source": it["source"],
                    "question": it["question"][:200],
                    "gold": it["gold_intent"],
                    "pred": pred,
                    "correct": int(ok),
                    "latency_s": round(sec, 6),
                    "gold_provenance": it["gold_provenance"],
                }
            )
        ret_summary[name] = {
            "n": len(flags),
            "accuracy": accuracy(flags),
            "latency_mean_s": statistics.mean(secs),
            "latency_median_s": statistics.median(secs),
            "latency_p95_s": sorted(secs)[max(0, int(0.95 * (len(secs) - 1)))],
        }
        print("retrieval", name, ret_summary[name])

    latency["retrieval_rule_vs_llm"] = None
    if "llm_intent_qwen3_4b" in ret_summary:
        latency["retrieval_rule_vs_llm"] = {
            "rule_mean_s": ret_summary["echo_rule_router"]["latency_mean_s"],
            "llm_mean_s": ret_summary["llm_intent_qwen3_4b"]["latency_mean_s"],
            "speedup_rule_over_llm": ret_summary["llm_intent_qwen3_4b"]["latency_mean_s"]
            / max(ret_summary["echo_rule_router"]["latency_mean_s"], 1e-9),
        }

    e2e = load_e2e()
    summary = {
        "protocol": (
            "Routing vs competing methods. Paths relative to evaluation/. "
            "Gold labels are category-derived (+ synthetic intent probes), not independent annotation. "
            "Speech/no-frame E2E from archived paired runs."
        ),
        "eval_root": str(EVAL_ROOT),
        "vllm_url": DEFAULT_VLLM if use_llm else None,
        "gold_label_caveat": (
            "Focus/intent gold comes from existing experiment categories and synthetic probes; "
            "not independently annotated by humans for this study."
        ),
        "focus_router_accuracy": focus_summary,
        "retrieval_intent_accuracy": ret_summary,
        "latency": latency,
        "end_to_end_policy": e2e,
        "llm_baselines_run": use_llm,
        "n_focus_items": len(focus_items),
        "n_retrieval_items": len(ret_items),
        "gold_focus_counts": dict(Counter(it["gold_focus"] for it in focus_items)),
        "gold_intent_counts": dict(Counter(it["gold_intent"] for it in ret_items)),
    }

    with (OUT / "routing_method_predictions.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(pred_rows[0].keys()))
        w.writeheader()
        w.writerows(pred_rows)
    (OUT / "routing_comparison_summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    fs, rs = focus_summary, ret_summary
    lat_f = latency.get("focus_rule_vs_llm") or {}
    lat_r = latency.get("retrieval_rule_vs_llm") or {}
    md = f"""# Context routing vs competing methods

## Portability

```bash
# from the public repo
cd evaluation/routing_comparison
python3 run_routing_baselines.py          # uses sibling files under evaluation/
python3 run_routing_baselines.py --skip-llm   # no GPU/vLLM required for rule/always-* + archived E2E
```

`EVAL_ROOT` defaults to the parent of this folder (`evaluation/` or `eval/`). Optional:
`ECHO_VLLM_URL` (default `http://127.0.0.1:8001/v1`).

## Gold-label caveat

Labels are **category-derived** (speech ablation → speech; no-frame paired → visual;
packet/heldout `question_type` → focus/intent) plus synthetic intent probes.
They are **not** independently double-annotated. See `gold_*.jsonl` `gold_provenance`.

## End-to-end delivery policy (archived lab runs)

| Setting | ECHO routing | Competing method |
|---------|--------------|------------------|
| Speech vs slide conflict (30×3) | Withhold frame: spoken 1.00, slide-only 0.00 | Always attach slide: spoken 0.62, slide-only 0.38 |
| Visual ask, zero frames (n=35) | Guard on: abstain 33/35 | Guard off: 3/35 |

## Focus router (n={len(focus_items)})

| Method | Accuracy | Mean latency |
|--------|----------|--------------|
| **ECHO rule** | **{fs['echo_rule_router']['accuracy']:.3f}** | **{fs['echo_rule_router']['latency_mean_s']*1000:.3f} ms** |
| Always speech | {fs['always_speech']['accuracy']:.3f} | — |
| Always visual | {fs['always_visual']['accuracy']:.3f} | — |
| Always general | {fs['always_general']['accuracy']:.3f} | — |
"""
    if "llm_router_qwen3_4b" in fs:
        md += (
            f"| LLM focus (Qwen3-4B) | {fs['llm_router_qwen3_4b']['accuracy']:.3f} | "
            f"{fs['llm_router_qwen3_4b']['latency_mean_s']*1000:.1f} ms |\n"
        )
        md += f"\nRule vs LLM focus speedup: **{lat_f.get('speedup_rule_over_llm', float('nan')):.0f}×** "
        md += f"(rule {lat_f.get('rule_mean_s',0)*1000:.3f} ms vs LLM {lat_f.get('llm_mean_s',0)*1000:.1f} ms mean).\n"

    md += f"""
## Retrieval-intent router (n={len(ret_items)})

| Method | Accuracy | Mean latency |
|--------|----------|--------------|
| **ECHO rule** | **{rs['echo_rule_router']['accuracy']:.3f}** | **{rs['echo_rule_router']['latency_mean_s']*1000:.3f} ms** |
| Always literature | {rs['always_literature']['accuracy']:.3f} | — |
| Always historical | {rs['always_historical']['accuracy']:.3f} | — |
| Always none | {rs['always_none']['accuracy']:.3f} | — |
"""
    if "llm_intent_qwen3_4b" in rs:
        md += (
            f"| LLM intent (Qwen3-4B) | {rs['llm_intent_qwen3_4b']['accuracy']:.3f} | "
            f"{rs['llm_intent_qwen3_4b']['latency_mean_s']*1000:.1f} ms |\n"
        )
        md += f"\nRule vs LLM intent speedup: **{lat_r.get('speedup_rule_over_llm', float('nan')):.0f}×**.\n"

    (OUT / "README.md").write_text(md, encoding="utf-8")
    print(json.dumps({"latency": latency, "focus": {k: v["accuracy"] for k, v in fs.items()}, "retrieval": {k: v["accuracy"] for k, v in rs.items()}}, indent=2))


if __name__ == "__main__":
    main()
