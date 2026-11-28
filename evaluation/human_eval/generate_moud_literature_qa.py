#!/usr/bin/env python3
"""Generate MOUD-only literature Q/A pairs with real PubMed abstracts + local vLLM.

Writes synthetic_moud_literature.jsonl for the human-eval builder.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

OUT = Path(__file__).resolve().parent / "synthetic_moud_literature.jsonl"
ABSTRACT_CACHE = Path(__file__).resolve().parents[1] / "citation_faithfulness" / "abstract_cache.json"
VLLM = "http://127.0.0.1:8001/v1/chat/completions"
MODEL = "Qwen/Qwen3-4B-Instruct-2507"

# Seed MOUD literature questions (educational ECHO style). Bot drafts answers grounded in fetched abstracts.
SEED_QUESTIONS = [
    "For a Project ECHO MOUD session: what does the evidence say about starting buprenorphine in primary care for opioid use disorder?",
    "In MOUD education, how do clinicians compare methadone and buprenorphine for treating opioid use disorder?",
    "What should ECHO participants know about extended-release naltrexone (XR-NTX) for opioid use disorder?",
    "How is medication for opioid use disorder (MOUD) managed during pregnancy according to current guidance?",
    "What are evidence-based approaches to perioperative pain management for patients already on buprenorphine or methadone?",
    "How can clinicians reduce the risk of precipitated withdrawal when starting buprenorphine, especially with fentanyl exposure?",
    "What strategies improve retention in buprenorphine treatment for opioid use disorder?",
    "How should acute pain be treated in a patient who is stable on MOUD?",
    "What is the role of contingency management alongside MOUD for stimulant co-use or treatment engagement?",
    "What non-stigmatizing, evidence-informed language should clinicians use when discussing MOUD and relapse?",
    "When a patient on buprenorphine still has cravings or ongoing opioid use, what adjustments does the literature support?",
    "What does evidence say about depot buprenorphine (injectable) versus daily sublingual buprenorphine for OUD?",
    "What should ECHO clinicians know about urine drug testing and interpreting unexpected results during MOUD?",
    "How does evidence guide take-home methadone or buprenorphine flexibility after COVID-era policy changes?",
    "What are best practices for linking emergency-department patients with opioid use disorder to ongoing MOUD?",
    "How should clinicians counsel patients about overdose prevention and naloxone while on MOUD?",
]

# Extra MOUD literature asks (tight PubMed match) to fill context-decidable human-eval slots.
EXTRA_SEED_QUESTIONS = [
    "What does evidence say about low-dose or micro-induction buprenorphine initiation for patients using fentanyl?",
    "How should ECHO clinicians discuss shared decision-making when choosing among buprenorphine, methadone, and XR-naltrexone?",
    "What does the literature report about buprenorphine or methadone continuation for patients who are incarcerated or reentering the community?",
    "What evidence informs MOUD care for adolescents and young adults with opioid use disorder?",
    "How does evidence guide co-prescribing or distributing naloxone to patients receiving MOUD?",
    "What do studies show about telehealth or virtual delivery of buprenorphine treatment for opioid use disorder?",
    "What is known about treating co-occurring stimulant (methamphetamine or cocaine) use among patients on MOUD?",
    "How should clinicians interpret and respond to a return to opioid use while a patient is retained in MOUD?",
]


def chat(messages: list[dict], max_tokens: int = 700, temperature: float = 0.2) -> str:
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
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read().decode())
    return (data["choices"][0]["message"]["content"] or "").strip()


def pubmed_search(query: str, retmax: int = 3) -> list[str]:
    url = (
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
        f"db=pubmed&retmax={retmax}&retmode=json&term={urllib.parse.quote(query)}"
        "&tool=echoai_humaneval&email=qxl5189%40psu.edu"
    )
    proc = subprocess.run(["curl", "-fsSL", url], capture_output=True, text=True)
    if proc.returncode != 0:
        return []
    try:
        ids = json.loads(proc.stdout).get("esearchresult", {}).get("idlist", [])
    except json.JSONDecodeError:
        return []
    return [str(x) for x in ids]


def fetch_abstracts(pmids: list[str]) -> dict[str, str]:
    cache: dict[str, str] = {}
    if ABSTRACT_CACHE.exists():
        try:
            cache = json.loads(ABSTRACT_CACHE.read_text())
        except json.JSONDecodeError:
            cache = {}
    missing = [p for p in pmids if p not in cache or len(cache.get(p, "")) < 40]
    for i in range(0, len(missing), 12):
        batch = missing[i : i + 12]
        url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            f"db=pubmed&id={','.join(batch)}&retmode=xml"
            "&tool=echoai_humaneval&email=qxl5189%40psu.edu"
        )
        proc = subprocess.run(["curl", "-fsSL", url], capture_output=True)
        if proc.returncode != 0:
            continue
        try:
            root = ET.fromstring(proc.stdout)
        except ET.ParseError:
            continue
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
    ABSTRACT_CACHE.parent.mkdir(parents=True, exist_ok=True)
    ABSTRACT_CACHE.write_text(json.dumps(cache, indent=2))
    return {p: cache.get(p, "") for p in pmids}


def search_query_for_question(q: str) -> str:
    # Keep searches MOUD-focused.
    base = (
        "(opioid use disorder[Title/Abstract] OR medication for opioid use disorder[Title/Abstract] "
        "OR buprenorphine[Title/Abstract] OR methadone[Title/Abstract] OR naltrexone[Title/Abstract])"
    )
    # Pull a few content words from the question.
    words = re.findall(r"[A-Za-z][A-Za-z\-]{3,}", q.lower())
    stop = {
        "project",
        "echo",
        "session",
        "participants",
        "clinicians",
        "patient",
        "patients",
        "should",
        "about",
        "according",
        "current",
        "guidance",
        "evidence",
        "what",
        "when",
        "with",
        "from",
        "that",
        "this",
        "does",
        "have",
        "into",
        "during",
        "already",
        "especially",
        "using",
        "know",
    }
    keys = [w for w in words if w not in stop][:6]
    extra = " AND ".join(f"{k}[Title/Abstract]" for k in keys[:3]) if keys else "buprenorphine[Title/Abstract]"
    return f"{base} AND ({extra})"


def draft_answer(question: str, abstracts: dict[str, str]) -> str:
    evidence = []
    for i, (pmid, body) in enumerate(abstracts.items(), 1):
        if not body:
            continue
        evidence.append(f"[{i}] PMID {pmid}\n{body[:900]}")
    evid_block = "\n\n".join(evidence) if evidence else "(No abstracts retrieved.)"
    sys = (
        "You are ECHO-AI, an educational assistant for Project ECHO MOUD tele-mentoring. "
        "Answer for clinicians in a live teaching session. Be accurate, concise, and hedge appropriately. "
        "Use ONLY the provided PubMed abstracts for citations. "
        "Cite as [n] matching the abstract list. "
        "End with: Educational summary for ECHO discussion; not clinical advice or a medical record. "
        "Do not invent PMIDs."
    )
    user = (
        f"Question:\n{question}\n\n"
        f"Abstracts you may cite:\n{evid_block}\n\n"
        "Write the educational answer now."
    )
    return chat(
        [{"role": "system", "content": sys}, {"role": "user", "content": user}],
        max_tokens=750,
        temperature=0.2,
    )


def format_answer_with_refs(answer: str, abstracts: dict[str, str]) -> str:
    # Append a clean reference list for PMIDs that appear or all provided.
    lines = [answer.strip(), ""]
    for i, (pmid, body) in enumerate(abstracts.items(), 1):
        title = (body.split("\n", 1)[0] if body else "").strip() or "(title unavailable)"
        lines.append(f"[{i}]: PMID {pmid} | {title}")
    if "Educational summary for ECHO discussion" not in answer:
        lines.append("")
        lines.append("Educational summary for ECHO discussion; not clinical advice or a medical record.")
    return "\n".join(lines).strip() + "\n"


def _generate_one(qi: int, question: str, prefix: str = "S") -> dict | None:
    qsearch = search_query_for_question(question)
    pmids = pubmed_search(qsearch, retmax=3)
    if len(pmids) < 2:
        pmids = pubmed_search(
            "medication for opioid use disorder[Title/Abstract] AND buprenorphine[Title/Abstract]",
            retmax=3,
        )
    abstracts = fetch_abstracts(pmids)
    abstracts = {p: t for p, t in abstracts.items() if len(t) >= 40}
    if not abstracts:
        print(f"skip {prefix}{qi:02d}: no abstracts")
        return None
    raw = draft_answer(question, abstracts)
    answer = format_answer_with_refs(raw, abstracts)
    row = {
        "synth_id": f"{prefix}{qi:02d}",
        "question_type": "literature",
        "standalone_question": question,
        "original_chat_question": question,
        "answer": answer,
        "pmids": list(abstracts.keys()),
        "setting_for_grader": (
            "MOUD literature / education question for Project ECHO. "
            "Judge using the question and the PubMed abstracts shown."
        ),
        "session_id": "synthetic",
    }
    print(f"ok {row['synth_id']} pmids={row['pmids']} ans_len={len(answer)}")
    time.sleep(0.2)
    return row


def main() -> None:
    import sys

    # Default: append EXTRA only (keeps existing S01–S16). Pass --all to regenerate everything.
    do_all = "--all" in sys.argv
    existing: list[dict] = []
    if OUT.exists() and not do_all:
        for line in OUT.open():
            line = line.strip()
            if line:
                existing.append(json.loads(line))
    rows: list[dict] = list(existing) if not do_all else []
    seen_q = {re.sub(r"\s+", " ", (r.get("standalone_question") or "").lower()) for r in rows}

    if do_all:
        for qi, question in enumerate(SEED_QUESTIONS, 1):
            row = _generate_one(qi, question)
            if row:
                rows.append(row)
                seen_q.add(re.sub(r"\s+", " ", question.lower()))
        next_id = len(SEED_QUESTIONS) + 1
    else:
        next_id = 1
        for r in rows:
            m = re.match(r"S(\d+)$", str(r.get("synth_id") or ""))
            if m:
                next_id = max(next_id, int(m.group(1)) + 1)

    for question in EXTRA_SEED_QUESTIONS:
        key = re.sub(r"\s+", " ", question.lower())
        if key in seen_q:
            continue
        row = _generate_one(next_id, question)
        if row:
            rows.append(row)
            seen_q.add(key)
            next_id += 1

    with OUT.open("w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} pairs → {OUT}")


if __name__ == "__main__":
    main()
