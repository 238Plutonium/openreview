#!/usr/bin/env python3
"""Context-routing vs competing methods (offline + archived end-to-end).

Compares ECHO-AI's rule-based focus/retrieval routers and delivery policies to
simple competing policies on the same cases. End-to-end speech and no-frame
numbers are taken from archived ablation summaries (already run on the lab bots).
"""
from __future__ import annotations

import csv
import json
import re
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PRIV = ROOT.parent
PUB = Path("/home/ugrads/qxl5189/echo-ai-naacl-submission/evaluation")
OUT = ROOT
VLLM = "http://127.0.0.1:8001/v1/chat/completions"
MODEL = "Qwen/Qwen3-4B-Instruct-2507"

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
        re.search(r"\b(similar|previous|prior|historical|past|comparable)\s+(case|patient|presentation)s?\b", n)
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


def llm_focus(question: str) -> str:
    prompt = (
        "Classify the meeting question focus. Reply with ONLY one token: "
        "speech, visual, or general.\n"
        "speech = asking what someone said aloud.\n"
        "visual = asking what is on the slide/screen.\n"
        "general = neither.\n\n"
        f"Question: {question}"
    )
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "Reply with only: speech, visual, or general."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": 8,
    }
    req = urllib.request.Request(
        VLLM, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = json.load(resp)["choices"][0]["message"]["content"].strip().lower()
    for lab in ("speech", "visual", "general"):
        if lab in text:
            return lab
    return "general"


def load_focus_gold() -> list[dict]:
    items = []
    speech_path = PUB / "speech_recall_ablation" / "cases.jsonl"
    for line in speech_path.read_text().splitlines():
        o = json.loads(line)
        items.append({"id": o.get("id") or o.get("case_id"), "question": o["question"], "gold_focus": "speech", "source": "speech_ablation"})
    paired = json.loads((PUB / "recorded_replay" / "paired_cases.json").read_text())
    for o in paired:
        items.append({"id": o["id"], "question": o["question"], "gold_focus": "visual", "source": "noframe_paired"})
    # packet non-slide non-prior as general-ish; slides as visual
    packet = list(csv.DictReader((PUB / "packet_qa.csv").open()))
    for r in packet:
        qt = (r.get("question_type") or "").lower()
        q = r.get("standalone_question") or r.get("original_chat_question") or ""
        if not q.strip():
            continue
        if qt == "slide":
            gold = "visual"
        elif qt in {"literature", "prior_session", "summary", "other"}:
            # literature/prior are retrieval, not speech/visual focus
            gold = "general"
        else:
            gold = "general"
        items.append({"id": f"packet:{r['qa_id']}", "question": q, "gold_focus": gold, "source": "packet"})
    return items


def load_retrieval_gold() -> list[dict]:
    items = []
    packet = list(csv.DictReader((PUB / "packet_qa.csv").open()))
    for r in packet:
        qt = (r.get("question_type") or "").lower()
        q = r.get("standalone_question") or ""
        if qt == "literature":
            gold = "literature"
        elif qt == "prior_session":
            gold = "historical-cases"
        else:
            gold = "none"
        items.append({"id": f"packet:{r['qa_id']}", "question": q, "gold_intent": gold, "source": "packet"})
    held = list(csv.DictReader((PUB / "heldout_qa_set_echo_only.csv").open()))
    for r in held:
        qt = (r.get("question_type") or "").lower()
        q = r.get("question") or ""
        if qt == "literature":
            gold = "literature"
        elif qt == "prior_session":
            gold = "historical-cases"
        else:
            gold = "none"
        items.append({"id": f"heldout:{r['qa_id']}", "question": q, "gold_intent": gold, "source": "heldout"})
    # synthetic extras for balance
    synth = [
        ("syn:lit1", "What does PubMed say about buprenorphine induction guidelines?", "literature"),
        ("syn:lit2", "Cite medical literature on CBT-I for insomnia", "literature"),
        ("syn:hist1", "What did we discuss about this patient in the previous ECHO session?", "historical-cases"),
        ("syn:hist2", "Search prior session transcripts for similar MOUD cases", "historical-cases"),
        ("syn:none1", "What time does the meeting start?", "none"),
        ("syn:none2", "Who is presenting next?", "none"),
    ]
    for i, q, g in synth:
        items.append({"id": i, "question": q, "gold_intent": g, "source": "synthetic"})
    return items


def accuracy(preds: list[str], golds: list[str]) -> float:
    return sum(p == g for p, g in zip(preds, golds)) / len(golds) if golds else 0.0


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    focus_items = load_focus_gold()
    # Focus router comparison
    focus_rows = []
    llm_ok = True
    try:
        urllib.request.urlopen(urllib.request.Request(VLLM.replace("/chat/completions", "/models")), timeout=3)
    except Exception:
        # models endpoint may differ
        try:
            llm_focus("What did the facilitator say about the room?")
        except Exception as e:
            llm_ok = False
            print("LLM focus baseline unavailable:", e)

    methods_focus = {
        "echo_rule_router": echo_question_focus,
        "always_speech": lambda q: "speech",
        "always_visual": lambda q: "visual",
        "always_general": lambda q: "general",
    }
    if llm_ok:
        methods_focus["llm_router_qwen3_4b"] = llm_focus

    focus_summary = {}
    for name, fn in methods_focus.items():
        preds = []
        for it in focus_items:
            pred = fn(it["question"])
            preds.append(pred)
            focus_rows.append(
                {
                    "task": "focus",
                    "method": name,
                    "id": it["id"],
                    "source": it["source"],
                    "question": it["question"][:200],
                    "gold": it["gold_focus"],
                    "pred": pred,
                    "correct": int(pred == it["gold_focus"]),
                }
            )
        golds = [it["gold_focus"] for it in focus_items]
        focus_summary[name] = {
            "n": len(golds),
            "accuracy": accuracy(preds, golds),
            "by_gold": {
                g: accuracy(
                    [p for p, gg in zip(preds, golds) if gg == g],
                    [gg for gg in golds if gg == g],
                )
                for g in sorted(set(golds))
            },
        }
        print("focus", name, focus_summary[name]["accuracy"])

    # Retrieval intent comparison
    ret_items = load_retrieval_gold()
    methods_ret = {
        "echo_rule_router": echo_retrieval_intent,
        "always_literature": lambda q: "literature",
        "always_historical": lambda q: "historical-cases",
        "always_none": lambda q: "none",
    }
    ret_summary = {}
    for name, fn in methods_ret.items():
        preds = []
        for it in ret_items:
            pred = fn(it["question"])
            # map both -> count as literature if gold literature else historical if gold hist else wrong unless gold both
            preds.append(pred)
            focus_rows.append(
                {
                    "task": "retrieval_intent",
                    "method": name,
                    "id": it["id"],
                    "source": it["source"],
                    "question": it["question"][:200],
                    "gold": it["gold_intent"],
                    "pred": pred,
                    "correct": int(
                        pred == it["gold_intent"]
                        or (pred == "both" and it["gold_intent"] in {"literature", "historical-cases"})
                    ),
                }
            )
        golds = [it["gold_intent"] for it in ret_items]
        # recompute correct with both rule
        correct = []
        for it in ret_items:
            pred = fn(it["question"])
            ok = pred == it["gold_intent"] or (
                pred == "both" and it["gold_intent"] in {"literature", "historical-cases"}
            )
            correct.append(ok)
        ret_summary[name] = {"n": len(golds), "accuracy": sum(correct) / len(correct)}
        print("retrieval", name, ret_summary[name]["accuracy"])

    # Archived end-to-end policy comparisons
    speech = json.loads((PUB / "speech_recall_ablation" / "runs" / "speech_summary.json").read_text())
    noframe_summary = (PUB / "paired_zero_frame_summary.md").read_text() if (PUB / "paired_zero_frame_summary.md").exists() else ""
    # also from CSV
    nf = list(csv.DictReader((PRIV / "paired_zero_frame.csv").open()))
    def refuse(label: str) -> bool:
        return str(label).strip().lower() in {"refuse", "abstain", "cannot-see", "cannot_see"}
    on = [r for r in nf if r["condition"].strip().lower() in {"baseline", "guard_on", "on"}]
    off = [r for r in nf if r["condition"].strip().lower() in {"treatment", "guard_off", "off"}]

    e2e = {
        "speech_conflict_routing": {
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
            "delta_withheld_minus_always_frame": speech["paired_withheld_minus_included"],
        },
        "visual_missing_frame_routing": {
            "echo_no_frame_guard_on": {
                "abstain": sum(1 for r in on if refuse(r["label"])),
                "n": len(on),
            },
            "competitor_guard_off_still_draft": {
                "abstain": sum(1 for r in off if refuse(r["label"])),
                "n": len(off),
            },
        },
    }

    summary = {
        "protocol": (
            "Routing vs competing methods. Focus/retrieval: offline accuracy vs gold labels. "
            "Speech/no-frame: archived paired end-to-end ablations on lab bots."
        ),
        "focus_router_accuracy": focus_summary,
        "retrieval_intent_accuracy": ret_summary,
        "end_to_end_policy": e2e,
        "llm_focus_available": llm_ok,
        "n_focus_items": len(focus_items),
        "n_retrieval_items": len(ret_items),
        "gold_focus_counts": dict(Counter(it["gold_focus"] for it in focus_items)),
        "gold_intent_counts": dict(Counter(it["gold_intent"] for it in ret_items)),
    }

    with (OUT / "routing_method_predictions.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(focus_rows[0].keys()))
        w.writeheader()
        w.writerows(focus_rows)
    (OUT / "routing_comparison_summary.json").write_text(json.dumps(summary, indent=2) + "\n")

    # Markdown table for paper/reviewers
    fs = focus_summary
    rs = ret_summary
    md = f"""# Context routing vs competing methods

## End-to-end delivery policy (archived lab runs)

| Setting | ECHO routing | Competing method | Metric |
|---------|--------------|------------------|--------|
| Speech vs slide conflict (30 cases × 3) | Withhold frame on speech focus | Always attach conflicting slide | Spoken token 1.00 vs 0.62; slide-only 0.00 vs 0.38 |
| Visual ask, zero frames (n=35) | No-frame fixed abstention | Draft anyway (guard off) | Abstain 33/35 vs 3/35 |

## Focus router accuracy (offline; n={len(focus_items)})

| Method | Accuracy |
|--------|----------|
| **ECHO rule router** | **{fs['echo_rule_router']['accuracy']:.3f}** |
| Always speech | {fs['always_speech']['accuracy']:.3f} |
| Always visual | {fs['always_visual']['accuracy']:.3f} |
| Always general | {fs['always_general']['accuracy']:.3f} |
"""
    if "llm_router_qwen3_4b" in fs:
        md += f"| LLM router (Qwen3-4B) | {fs['llm_router_qwen3_4b']['accuracy']:.3f} |\n"
    md += f"""
Gold mix: {dict(Counter(it['gold_focus'] for it in focus_items))}

## Retrieval-intent router accuracy (offline; n={len(ret_items)})

| Method | Accuracy |
|--------|----------|
| **ECHO rule router** | **{rs['echo_rule_router']['accuracy']:.3f}** |
| Always literature | {rs['always_literature']['accuracy']:.3f} |
| Always historical | {rs['always_historical']['accuracy']:.3f} |
| Always none | {rs['always_none']['accuracy']:.3f} |

Gold mix: {dict(Counter(it['gold_intent'] for it in ret_items))}
"""
    (OUT / "README.md").write_text(md)
    print(json.dumps(summary, indent=2)[:2000])


if __name__ == "__main__":
    main()
