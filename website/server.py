#!/usr/bin/env python3
"""Serve the ECHO website and proxy /api/ask to the local Zoom-bot AI stack."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
ECHO_API = os.environ.get("ECHO_API_BASE", "http://127.0.0.1:3000").rstrip("/")
PORT = int(os.environ.get("PORT", "8080"))
ASK_TIMEOUT = float(os.environ.get("ASK_TIMEOUT", "180"))
# Default off so the public literature page matches the paper (plain PubMed path).
# Set ECHO_WEB_MOUD_BIAS=1 to re-enable addiction-domain PubMed concept hints.
WEB_MOUD_BIAS = os.environ.get("ECHO_WEB_MOUD_BIAS", "0").strip() in {
    "1",
    "true",
    "True",
    "yes",
}
FEEDBACK_DIR = ROOT / "feedback_submissions"
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_MOUD_DOMAIN = re.compile(
    r"\b("
    r"moud|oud|opioid(?:s)?|opiate(?:s)?|buprenorphine|suboxone|subutex|sublocade|"
    r"methadone|naltrexone|vivitrol|naloxone|narcan|fentanyl|heroin|"
    r"withdrawal|craving(?:s)?|overdose|harm\s*reduction|"
    r"medication(?:s)?\s+for\s+opioid|opioid\s+use\s+disorder|"
    r"addiction|substance\s+use|sud\b|mmt\b|mot\b"
    r")\b",
    re.I,
)
_MED_CONCEPTS = (
    (re.compile(r"\b(buprenorphine|suboxone|subutex|sublocade)\b", re.I), "buprenorphine"),
    (re.compile(r"\b(methadone|mmt|mot)\b", re.I), "methadone"),
    (re.compile(r"\b(naltrexone|vivitrol)\b", re.I), "naltrexone"),
    (re.compile(r"\b(naloxone|narcan)\b", re.I), "naloxone"),
)
_FOOT_RE = re.compile(
    r"^\[(\d+)\]:\s*PMID\s+(\d+)\s*\|?\s*(.*)$",
    re.I | re.M,
)
_DISCLAIMER_RE = re.compile(
    r"(?im)^Educational summary for ECHO discussion;.*$",
)


def enrich_web_question_for_moud_pubmed(question: str) -> str:
    """Bias PubMed toward on-topic MOUD evidence for addiction-domain asks."""
    if not WEB_MOUD_BIAS or not _MOUD_DOMAIN.search(question):
        return question
    meds = [name for rx, name in _MED_CONCEPTS if rx.search(question)]
    topics: list[str] = []
    ql = question.lower()
    if re.search(r"\bchronic pain|pain manage|analges", ql):
        topics.append("chronic pain")
    if re.search(r"\binitiation|induct", ql):
        topics.append("initiation")
    if re.search(r"\bmaintenance|mmt|mot\b", ql):
        topics.append("maintenance therapy")
    concepts_raw = ["opioid use disorder", "MOUD", *meds, *topics]
    concepts: list[str] = []
    seen: set[str] = set()
    for c in concepts_raw:
        key = c.lower()
        if key not in seen:
            seen.add(key)
            concepts.append(c)
    concept_line = "; ".join(concepts)
    med_clause = (
        f"Cite papers about {', '.join(meds)}"
        if meds
        else "Cite papers about the medications and indication named in the question"
    )
    hint = (
        f"{med_clause}; do not substitute a different MOUD drug. "
        f"Prefer Humans clinical literature. Concepts: {concept_line}."
    )
    if "Concepts:" in question and "MOUD" in question:
        return question
    return f"{question.rstrip()}\n\n{hint}"


def _question_required_meds(question: str) -> list[str]:
    return [name for rx, name in _MED_CONCEPTS if rx.search(question)]


def fetch_pubmed_summaries(pmids: list[str]) -> dict[str, dict]:
    """Fetch title/date/type for PMIDs (best-effort; empty on failure)."""
    if not pmids:
        return {}
    ids = ",".join(dict.fromkeys(pmids))
    url = (
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
        f"?db=pubmed&retmode=json&id={urllib.parse.quote(ids)}"
    )
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        result = data.get("result") or {}
        out: dict[str, dict] = {}
        for pmid in pmids:
            rec = result.get(pmid) or {}
            if rec and not rec.get("error"):
                out[pmid] = rec
        return out
    except Exception:  # noqa: BLE001
        return {}


def format_web_answer(answer: str, question: str = "") -> str:
    """Clean spacing, rebuild full PMID footnotes, drop dangling/off-topic cites."""
    if not answer:
        return answer

    text = answer.replace("\r\n", "\n").strip()
    disclaimer_m = _DISCLAIMER_RE.search(text)
    disclaimer = disclaimer_m.group(0).strip() if disclaimer_m else ""
    if disclaimer_m:
        text = (text[: disclaimer_m.start()] + text[disclaimer_m.end() :]).strip()

    feet = list(_FOOT_RE.finditer(text))
    pmid_by_n: dict[int, str] = {}
    for m in feet:
        pmid_by_n[int(m.group(1))] = m.group(2)

    body = _FOOT_RE.sub("", text).strip()
    body = re.sub(r"[ \t]+\n", "\n", body)
    body = re.sub(r"\n{3,}", "\n\n", body)
    # Drop truncation ellipsis glued to the end of the body.
    body = re.sub(r"\s*\.\.\.\s*$", "", body).strip()

    required = _question_required_meds(question)
    summaries = fetch_pubmed_summaries(list(pmid_by_n.values()))

    keep_nums: set[int] = set()
    for n, pmid in pmid_by_n.items():
        rec = summaries.get(pmid) or {}
        title = str(rec.get("title") or "").lower()
        # Fall back to original footnote blob if NCBI failed.
        if not title:
            for m in feet:
                if int(m.group(1)) == n:
                    title = (m.group(3) or "").lower()
                    break
        if required:
            if any(med.lower() in title for med in required):
                keep_nums.add(n)
        else:
            keep_nums.add(n)

    if pmid_by_n and required and not keep_nums:
        body = re.sub(r"\s*\[(\d+)\]", "", body)
        body = re.sub(r"\n{3,}", "\n\n", body).strip()
        note = (
            "Retrieved PubMed hits did not closely match the medication named "
            "in the question; treat the summary as provisional and uncited."
        )
        parts = [body, note]
        if disclaimer:
            parts.append(disclaimer)
        return "\n\n".join(p for p in parts if p)

    if not pmid_by_n:
        body = re.sub(r"\s*\[(\d+)\]", "", body)
        parts = [body]
        if disclaimer:
            parts.append(disclaimer)
        return "\n\n".join(p for p in parts if p).strip()

    # Keep only footnotes that survive topical filter; rebuild from NCBI.
    def body_keep(m: re.Match[str]) -> str:
        return m.group(0) if int(m.group(1)) in keep_nums else ""

    body = re.sub(r"\[(\d+)\]", body_keep, body)
    body = re.sub(r"[ \t]{2,}", " ", body)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()

    foot_lines: list[str] = []
    for n in sorted(keep_nums):
        pmid = pmid_by_n[n]
        rec = summaries.get(pmid) or {}
        title = str(rec.get("title") or "").strip() or "PubMed article"
        pubdate = str(rec.get("pubdate") or "").strip()
        pubtypes = rec.get("pubtype") or []
        pubtype = pubtypes[0] if isinstance(pubtypes, list) and pubtypes else ""
        bits = [f"PMID {pmid}", title]
        if pubdate:
            bits.append(pubdate)
        if pubtype:
            bits.append(str(pubtype))
        foot_lines.append(f"[{n}]: " + " | ".join(bits))

    parts = [body]
    if foot_lines:
        parts.append("\n".join(foot_lines))
    if disclaimer:
        parts.append(disclaimer)
    return "\n\n".join(parts).strip()


def fetch_json(url: str, timeout: float = 8.0) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        # Zoom RTMS webhooks + OAuth must reach the bot through the public ngrok
        # tunnel (which currently fronts this website on :8080).
        if path == "/zoom/webhooks" or path.startswith("/oauth"):
            return self._proxy_echo(method="GET")
        # Do not expose scored CSVs or raw feedback dumps on the public demo.
        blocked_prefixes = (
            "/ECHO_AI_ratings",
            "/echo_only_collected",
            "/facilitator_grading_sheet_filled",
            "/feedback_submissions",
            "/feedbacks_extracted",
            "/collect",
            "/facilitator_collect",
            "/facilitator_ratings",
            "/facilitator_packet",
        )
        if any(
            path == p or path.startswith(p + ".") or path.startswith(p + "/")
            for p in blocked_prefixes
        ):
            self.send_error(404, "Not Found")
            return
        if path == "/api/status":
            return self._status()
        if path in ("/chat", "/chat/"):
            self.path = "/chat.html"
        lowered = path.lower()
        if lowered.endswith(".csv") or lowered.startswith("/feedback_submissions"):
            return self.send_error(404, "Not Found")
        if lowered in (
            "/echo_ai_ratings.csv",
            "/echo_ai_ratings_13.csv",
            "/clinician_ratings.csv",
            "/facilitator_grading_sheet_filled.csv",
            "/feedbacks_m13_unified.csv",
        ):
            return self.send_error(404, "Not Found")
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/zoom/webhooks" or path.startswith("/oauth"):
            return self._proxy_echo(method="POST")
        if path == "/api/ask":
            return self._ask()
        if path == "/api/feedback":
            # Disabled on the public reviewer surface.
            self.send_error(404, "Not Found")
            return
        self.send_error(404, "Not Found")

    def _proxy_echo(self, method: str = "GET") -> None:
        """Forward Zoom webhook/OAuth traffic to the local bot API unchanged."""
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        target = f"{ECHO_API}{self.path}"
        headers = {
            "Accept": self.headers.get("Accept") or "*/*",
            "Content-Type": self.headers.get("Content-Type") or "application/json",
        }
        # Preserve Zoom signature headers for RTMS webhook verification.
        for key in (
            "x-zm-signature",
            "x-zm-request-timestamp",
            "x-zm-trackingid",
            "authorization",
            "user-agent",
        ):
            value = self.headers.get(key)
            if value:
                headers[key] = value
        req = urllib.request.Request(
            target,
            data=raw if method.upper() != "GET" else None,
            headers=headers,
            method=method.upper(),
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                self.send_response(resp.status)
                content_type = resp.headers.get("Content-Type")
                if content_type:
                    self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as exc:
            body = exc.read()
            self.send_response(exc.code)
            content_type = exc.headers.get("Content-Type") if exc.headers else None
            if content_type:
                self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:  # noqa: BLE001
            return self._json(502, {"ok": False, "error": f"echo proxy failed: {exc}"})

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _status(self):
        # Public status: readiness only (no internal URLs / model dump).
        out = {
            "ok": True,
            "website": True,
            "ready": False,
            "bot": None,
            "detail": "",
        }
        try:
            bot = fetch_json(f"{ECHO_API}/health", timeout=5)
            out["bot"] = {"ok": bool(bot.get("ok")), "state": bot.get("state")}
        except Exception as exc:  # noqa: BLE001
            out["detail"] = "bot unreachable"
            return self._json(200, out)

        try:
            ai = fetch_json(f"{ECHO_API}/ai/health", timeout=8)
            enabled = bool((ai.get("ai") or {}).get("enabled", ai.get("ok")))
            out["ready"] = bool(ai.get("ok")) and enabled
            if not out["ready"]:
                out["detail"] = "AI stack not ready"
        except Exception:  # noqa: BLE001
            out["detail"] = "AI health failed"
        return self._json(200, out)

    def _ask(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return self._json(400, {"ok": False, "error": "invalid JSON"})

        question = str(payload.get("question") or "").strip()
        if not question:
            return self._json(400, {"ok": False, "error": "question is required"})
        if len(question) > 2000:
            return self._json(400, {"ok": False, "error": "question too long"})

        upstream_question = enrich_web_question_for_moud_pubmed(question)
        body = json.dumps(
            {
                "question": upstream_question,
                "senderName": "web-visitor",
                "replyType": "manual",
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            f"{ECHO_API}/ai/ask",
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=ASK_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                data = json.loads(exc.read().decode("utf-8"))
            except Exception:  # noqa: BLE001
                data = {"ok": False, "error": f"upstream HTTP {exc.code}"}
            return self._json(
                502, data if isinstance(data, dict) else {"ok": False, "error": str(data)}
            )
        except Exception as exc:  # noqa: BLE001
            return self._json(
                503,
                {
                    "ok": False,
                    "error": (
                        f"AI backend unavailable ({exc}). "
                        "The answer LLM / VLM services may still be starting."
                    ),
                },
            )

        answer = (
            data.get("finalAnswer")
            or data.get("answer")
            or data.get("reply")
            or data.get("text")
            or ""
        )
        if isinstance(answer, str) and answer:
            answer = format_web_answer(answer, question)
        return self._json(
            200,
            {
                "ok": bool(data.get("ok", True)) and bool(answer),
                "answer": answer,
                "error": data.get("error") or ("" if answer else "empty answer"),
                "latencyMs": data.get("latencyMs") or data.get("elapsedMs"),
                "rawKeys": sorted(list(data.keys()))[:24],
            },
        )

    def _feedback(self):
        """Collect facilitator rating submissions (JSON) into feedback_submissions/."""
        length = int(self.headers.get("Content-Length") or 0)
        if length > 2_000_000:
            return self._json(413, {"ok": False, "error": "payload too large"})
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return self._json(400, {"ok": False, "error": "invalid JSON"})
        if not isinstance(payload, dict):
            return self._json(400, {"ok": False, "error": "expected object"})

        rater = str(payload.get("rater_name") or "").strip()
        ratings = payload.get("ratings")
        if not rater:
            return self._json(400, {"ok": False, "error": "rater_name is required"})
        if len(rater) > 120:
            return self._json(400, {"ok": False, "error": "rater_name too long"})
        if not isinstance(ratings, list) or not ratings:
            return self._json(400, {"ok": False, "error": "ratings list is required"})
        if len(ratings) > 80:
            return self._json(400, {"ok": False, "error": "too many ratings"})

        FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)
        safe = _SAFE_NAME.sub("_", rater).strip("._-") or "rater"
        stamp = time.strftime("%Y%m%dT%H%M%S")
        sid = f"{stamp}_{safe}_{os.getpid()}"
        out_path = FEEDBACK_DIR / f"{sid}.json"
        record = {
            "ok": True,
            "id": sid,
            "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "remote": self.client_address[0] if self.client_address else "",
            "submission": payload,
        }
        out_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return self._json(200, {"ok": True, "id": sid, "saved": out_path.name})

    def log_message(self, fmt: str, *args):
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(
        f"ECHO website + /api/ask proxy on http://0.0.0.0:{PORT} -> {ECHO_API}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
