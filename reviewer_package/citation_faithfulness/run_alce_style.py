#!/usr/bin/env python3
"""ALCE/MedCite-style citation faithfulness eval on archived ECHO-AI answers.

Scores statement-level citation recall & precision against PubMed abstracts using
a local Instruct LLM as an attribution judge (0 / 0.5 / 1), following the spirit of:
  - ALCE (Gao et al., EMNLP 2023): https://github.com/princeton-nlp/ALCE
  - MedCite (ACL Findings 2025): statement-level medical citation P/R

This is automatic machine evaluation, not clinician validation.
Bibliography/reference-list lines are excluded; only answer-body assertions with
resolvable PMIDs are scored.
"""
from __future__ import annotations

import csv
import json
import re
import statistics
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PRIV = ROOT.parent
OUT = ROOT
CACHE = OUT / "abstract_cache.json"
VLLM = "http://127.0.0.1:8001/v1/chat/completions"
MODEL = "Qwen/Qwen3-4B-Instruct-2507"

BIB_LINE = re.compile(
    r"^\[(\d+)\]:\s*(?:PMID\s*)?(\d{5,9})\s*\|(?P<title>.*)$",
    re.I | re.M,
)
INLINE_PMID = re.compile(r"\[PMID:(\d{5,9})\]")
FOOTNOTE = re.compile(r"\[(\d+)\]")


def split_body_and_bib(answer: str):
    lines = answer.splitlines()
    bib_start = None
    for i, line in enumerate(lines):
        if re.match(r"^\[\d+\]:\s*", line.strip()):
            bib_start = i
            break
    if bib_start is None:
        body, bib_text = answer, ""
    else:
        body = "\n".join(lines[:bib_start]).strip()
        bib_text = "\n".join(lines[bib_start:])
    fmap, titles = {}, {}
    for m in BIB_LINE.finditer(bib_text):
        fmap[m.group(1)] = m.group(2)
        titles[m.group(1)] = m.group("title").strip()
    return body, fmap, titles


def extract_units(answer: str):
    body, fmap, _titles = split_body_and_bib(answer)
    raw_lines = [ln.rstrip() for ln in body.splitlines()]
    merged = []
    for ln in raw_lines:
        s = ln.strip()
        if re.fullmatch(r"(?:\[\d+\]\s*)+", s) and merged:
            merged[-1] = merged[-1] + " " + s
        else:
            merged.append(ln)
    text = "\n".join(merged)
    norm = re.sub(r"([.!?])\s*((?:\[\d+\]\s*)+)", r" \2\1", text)
    parts = [
        p.strip()
        for p in re.split(r"\n+|(?<=[.!?])\s+(?=[A-Z“\"I])", norm)
        if p.strip()
    ]
    units = []
    for i, part in enumerate(parts):
        if re.match(r"^\[\d+\]:\s*", part):
            continue
        pmids = INLINE_PMID.findall(part)
        for n in FOOTNOTE.findall(part):
            if n in fmap:
                pmids.append(fmap[n])
        pmids = sorted(set(pmids))
        claim = INLINE_PMID.sub("", part)
        claim = re.sub(r"\[\d+\]", "", claim).strip()
        claim = re.sub(r"\s+", " ", claim)
        if len(claim) < 25 or not pmids:
            continue
        # skip disclaimer-only
        if "educational summary" in claim.lower() and "not clinical advice" in claim.lower():
            continue
        units.append({"unit_id": i, "claim": claim, "pmids": pmids})
    return units, len(re.findall(r"^\[\d+\]:\s*PMID", answer, re.M | re.I))


def load_answers(limit: int = 40):
    items = []
    held = PRIV / "heldout_qa_set.csv"
    for r in csv.DictReader(held.open(encoding="utf-8")):
        if (r.get("question_type") or "").lower() != "literature":
            continue
        ans = r.get("answer") or ""
        body, fmap, _ = split_body_and_bib(ans)
        pmids = sorted(
            set(INLINE_PMID.findall(ans))
            | set(fmap.values())
            | set(re.findall(r"\d{6,9}", r.get("pmids") or ""))
        )
        if not pmids:
            continue
        items.append(
            {
                "source": "heldout_qa_set",
                "qa_id": str(r["qa_id"]),
                "question": r.get("question") or "",
                "answer": ans,
                "pmids": pmids,
            }
        )
    qa_root = Path("/home/ugrads/qxl5189/echo_merge_nested/data/rtms/qa")
    if qa_root.exists():
        for p in sorted(qa_root.glob("*.ndjson")):
            for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
                if not line.strip():
                    continue
                try:
                    o = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ans = o.get("answer") or o.get("finalAnswer") or ""
                if "PMID" not in ans and not BIB_LINE.search(ans):
                    continue
                q = o.get("question") or ""
                # prefer literature-ish
                low = (q + " " + ans).lower()
                if not any(
                    k in low
                    for k in (
                        "pmid",
                        "treatment",
                        "literature",
                        "pubmed",
                        "guideline",
                        "diabetes",
                        "hiv",
                        "buprenorphine",
                        "opioid",
                        "moud",
                    )
                ):
                    continue
                _, fmap, _ = split_body_and_bib(ans)
                pmids = sorted(set(INLINE_PMID.findall(ans)) | set(fmap.values()))
                if not pmids:
                    continue
                items.append(
                    {
                        "source": f"rtms_qa/{p.name}",
                        "qa_id": str(o.get("id") or f"{p.stem}:{len(items)}"),
                        "question": q,
                        "answer": ans,
                        "pmids": pmids,
                    }
                )
    seen = set()
    uniq = []
    for it in items:
        key = (it["answer"][:240], tuple(it["pmids"][:4]))
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)
        if len(uniq) >= limit:
            break
    return uniq


def fetch_abstracts(pmids: list[str]) -> dict[str, str]:
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    missing = [p for p in pmids if p not in cache or len(cache.get(p, "")) < 40]
    for i in range(0, len(missing), 15):
        batch = missing[i : i + 15]
        url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            f"db=pubmed&id={','.join(batch)}&retmode=xml"
            "&tool=echoai_alce&email=qxl5189%40psu.edu"
        )
        proc = subprocess.run(["curl", "-fsSL", url], capture_output=True)
        if proc.returncode != 0:
            print("fetch fail", batch[:2], proc.stderr[:120])
            continue
        root = ET.fromstring(proc.stdout)
        for art in root.findall(".//PubmedArticle"):
            pmid = (art.findtext(".//PMID") or "").strip()
            texts = []
            for abs_ in art.findall(".//Abstract/AbstractText"):
                label = abs_.attrib.get("Label")
                t = "".join(abs_.itertext()).strip()
                texts.append(f"{label}: {t}" if label else t)
            title = art.findtext(".//ArticleTitle") or ""
            cache[pmid] = (title + "\n" + "\n".join(texts)).strip()
        time.sleep(0.35)
    CACHE.write_text(json.dumps(cache, indent=2))
    return cache


def chat(messages: list[dict], temperature: float = 0.0, max_tokens: int = 80) -> str:
    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        VLLM,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    return data["choices"][0]["message"]["content"].strip()


def parse_attr(text: str) -> float | None:
    m = re.search(r"\b(0(?:\.5)?|1(?:\.0)?|0\.0)\b", text)
    if not m:
        # words
        low = text.lower()
        if "partial" in low:
            return 0.5
        if "fully" in low or "supported" in low and "not" not in low and "un" not in low:
            return 1.0
        if "unsupported" in low or "not supported" in low:
            return 0.0
        return None
    return float(m.group(1))


def judge_attr(claim: str, evidence: str) -> tuple[float | None, str]:
    prompt = (
        "You are an attribution judge for medical QA citations (ALCE/MedCite style).\n"
        "Decide whether the CLAIM is supported by the EVIDENCE (PubMed title+abstract).\n"
        "Return ONLY one token: 1 (fully supported), 0.5 (partially supported), or 0 (not supported).\n"
        "Do not invent facts beyond the evidence.\n\n"
        f"CLAIM:\n{claim}\n\nEVIDENCE:\n{evidence[:3500]}\n"
    )
    raw = chat(
        [
            {"role": "system", "content": "Reply with only 1, 0.5, or 0."},
            {"role": "user", "content": prompt},
        ]
    )
    return parse_attr(raw), raw


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    items = load_answers(40)
    print(f"loaded {len(items)} answers")
    # build units
    prepared = []
    for it in items:
        units, nbib = extract_units(it["answer"])
        prepared.append({**it, "units": units, "n_bib_excluded": nbib})
    n_units = sum(len(p["units"]) for p in prepared)
    print(f"assertion units {n_units}; answers with units {sum(1 for p in prepared if p['units'])}")

    pmids = sorted({pmid for p in prepared for u in p["units"] for pmid in u["pmids"]})
    cache = fetch_abstracts(pmids)
    print(f"abstracts cached {sum(1 for p in pmids if cache.get(p))}/{len(pmids)}")

    rows = []
    for p in prepared:
        for u in p["units"]:
            # concatenate cited abstracts (MedCite-style union for recall)
            ev_parts = []
            for pmid in u["pmids"]:
                abs_ = cache.get(pmid, "")
                ev_parts.append(f"[PMID:{pmid}]\n{abs_}" if abs_ else f"[PMID:{pmid}]\n(MISSING ABSTRACT)")
            evidence = "\n\n".join(ev_parts)
            score, raw = judge_attr(u["claim"], evidence)
            rows.append(
                {
                    "source": p["source"],
                    "qa_id": p["qa_id"],
                    "question": p["question"][:240],
                    "unit_id": u["unit_id"],
                    "claim": u["claim"][:500],
                    "pmids": ";".join(u["pmids"]),
                    "n_pmids": len(u["pmids"]),
                    "attr_score": score,
                    "judge_raw": raw[:120],
                    "n_bib_excluded": p["n_bib_excluded"],
                }
            )
            print(
                p["qa_id"],
                u["unit_id"],
                score,
                u["pmids"][:3],
                u["claim"][:70].replace("\n", " "),
            )

    # ALCE-style statement citation recall: fraction of statements with attr==1
    # MedCite also uses partial; report both strict and soft
    scored = [r for r in rows if r["attr_score"] is not None]
    strict = [r for r in scored if r["attr_score"] == 1.0]
    soft = [r for r in scored if r["attr_score"] is not None and r["attr_score"] >= 0.5]
    # precision proxy: among cited statements, share fully / soft supported
    # (ALCE precision needs per-citation judgments; here each unit cites a set judged jointly)
    summary = {
        "protocol": (
            "ALCE/MedCite-style statement-level attribution against PubMed abstracts. "
            "Local judge: Qwen3-4B-Instruct-2507 (temp 0). "
            "Bibliography lines excluded. Not clinician validation."
        ),
        "judge_model": MODEL,
        "n_answers": len(prepared),
        "n_answers_with_assertions": sum(1 for p in prepared if p["units"]),
        "n_assertion_units": len(rows),
        "n_scored": len(scored),
        "n_parse_fail": sum(1 for r in rows if r["attr_score"] is None),
        "citation_recall_strict_attr1": (len(strict) / len(scored)) if scored else None,
        "citation_recall_soft_attr_ge_0_5": (len(soft) / len(scored)) if scored else None,
        "mean_attr_score": statistics.mean(r["attr_score"] for r in scored) if scored else None,
        "attr_histogram": dict(Counter(str(r["attr_score"]) for r in scored)),
        "benchmarks_referenced": {
            "ALCE": "https://github.com/princeton-nlp/ALCE",
            "MedCite": "https://aclanthology.org/2025.findings-acl.967/",
        },
    }

    # Per-citation ALCE precision (each PMID judged alone)
    per_rows = []
    for r in rows:
        for pmid in str(r["pmids"]).split(";"):
            if not pmid:
                continue
            abs_ = cache.get(pmid, "")
            evidence = f"[PMID:{pmid}]\n{abs_ or '(MISSING ABSTRACT)'}"
            score, raw = judge_attr(r["claim"], evidence)
            per_rows.append(
                {
                    "source": r["source"],
                    "qa_id": r["qa_id"],
                    "unit_id": r["unit_id"],
                    "claim": r["claim"],
                    "n_pmids": r["n_pmids"],
                    "pmid": pmid,
                    "attr_score": score,
                    "judge_raw": raw[:80],
                }
            )
            print("per-cite", r["qa_id"], pmid, score)

    per_scored = [r for r in per_rows if r["attr_score"] is not None]
    by_unit: dict[tuple, list[float]] = {}
    for r in per_scored:
        by_unit.setdefault((r["qa_id"], r["unit_id"]), []).append(float(r["attr_score"]))
    summary["per_citation"] = {
        "protocol": (
            "ALCE-style per-citation attribution; precision over citation instances; "
            "recall = statements with ≥1 supporting cite"
        ),
        "judge_model": MODEL,
        "n_citation_instances": len(per_rows),
        "n_scored": len(per_scored),
        "citation_precision_strict_attr1": (
            sum(1 for r in per_scored if r["attr_score"] == 1.0) / len(per_scored)
            if per_scored
            else None
        ),
        "citation_precision_soft_attr_ge_0_5": (
            sum(1 for r in per_scored if r["attr_score"] >= 0.5) / len(per_scored)
            if per_scored
            else None
        ),
        "statement_recall_any_cite_strict": (
            sum(1 for scores in by_unit.values() if max(scores) == 1.0) / len(by_unit)
            if by_unit
            else None
        ),
        "statement_recall_any_cite_soft": (
            sum(1 for scores in by_unit.values() if max(scores) >= 0.5) / len(by_unit)
            if by_unit
            else None
        ),
        "mean_attr_score": (
            statistics.mean(r["attr_score"] for r in per_scored) if per_scored else None
        ),
        "attr_histogram": dict(Counter(str(r["attr_score"]) for r in per_scored)),
    }

    with (OUT / "citation_attr_units.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with (OUT / "citation_attr_per_pmid.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(per_rows[0].keys()))
        w.writeheader()
        w.writerows(per_rows)
    (OUT / "citation_attr_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
