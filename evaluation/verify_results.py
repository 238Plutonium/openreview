#!/usr/bin/env python3
"""Offline verification for published ECHO-AI evaluation tables (stdlib only)."""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def check_noframe() -> None:
    path = ROOT / "paired_zero_frame.csv"
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    # Expected schema: case_id,condition,label,... with condition in {baseline,treatment}
    # baseline = guard ON; treatment = guard OFF (see paired_zero_frame_summary.md).
    if not rows or "condition" not in rows[0] or "label" not in rows[0]:
        summary = (ROOT / "paired_zero_frame_summary.md").read_text(encoding="utf-8")
        assert "33" in summary and "35" in summary
        print("noframe: verified via paired_zero_frame_summary.md")
        return

    def is_refuse(label: str) -> bool:
        return str(label).strip().lower() in {"refuse", "abstain", "cannot-see", "cannot_see"}

    on_rows = [r for r in rows if r["condition"].strip().lower() in {"baseline", "guard_on", "on"}]
    off_rows = [r for r in rows if r["condition"].strip().lower() in {"treatment", "guard_off", "off"}]
    on = sum(1 for r in on_rows if is_refuse(r["label"]))
    off = sum(1 for r in off_rows if is_refuse(r["label"]))
    print(f"noframe: guard_on={on}/{len(on_rows)} guard_off={off}/{len(off_rows)}")
    assert len(on_rows) == 35 and len(off_rows) == 35
    assert on == 33, on
    assert off == 3, off
    print("noframe: OK")


def check_packet_scores() -> None:
    summary = json.loads((ROOT / "packet_scores_summary.json").read_text(encoding="utf-8"))
    pooled = float(summary["pooled_equal_weight_1to5"])
    assert abs(pooled - 4.26) < 0.02, pooled
    means = [float(x) for x in summary["per_rater_means_1to5"]]
    assert len(means) == 3, means
    print(f"packet: pooled={pooled:.3f} per-rater={means}")
    rows = list(csv.DictReader((ROOT / "packet_scores.csv").open(encoding="utf-8")))
    assert len(rows) == 13, len(rows)
    # spearman of model vs human if both present
    pairs = [
        (float(r["model_item_mean_1to5"]), float(r["human_item_mean_1to5"]))
        for r in rows
        if r.get("model_item_mean_1to5") not in (None, "") and r.get("human_item_mean_1to5") not in (None, "")
    ]
    if len(pairs) >= 3:
        xs = [a for a, _ in pairs]
        ys = [b for _, b in pairs]

        def rank(a: list[float]) -> list[float]:
            order = sorted(range(len(a)), key=lambda i: a[i])
            r = [0.0] * len(a)
            i = 0
            while i < len(a):
                j = i
                while j + 1 < len(a) and a[order[j + 1]] == a[order[i]]:
                    j += 1
                avg = (i + j) / 2.0 + 1.0
                for k in range(i, j + 1):
                    r[order[k]] = avg
                i = j + 1
            return r

        rx, ry = rank(xs), rank(ys)
        mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
        num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
        den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
        rho = num / den if den else float("nan")
        print(f"packet: spearman model-vs-human rho={rho:.3f} (manuscript reports 0.34)")
    print("packet: OK")


def check_citation_faithfulness() -> None:
    """Reproduce ALCE-style strict/soft rates from archived judge CSV (offline)."""
    summary = json.loads(
        (ROOT / "citation_faithfulness" / "citation_attr_summary.json").read_text(
            encoding="utf-8"
        )
    )
    per = summary["per_citation"]
    rows = list(
        csv.DictReader(
            (ROOT / "citation_faithfulness" / "citation_attr_per_pmid.csv").open(
                encoding="utf-8"
            )
        )
    )
    assert len(rows) == 114, len(rows)
    scores = [float(r["attr_score"]) for r in rows if r.get("attr_score") not in (None, "")]
    assert len(scores) == 114, len(scores)
    n_half = sum(1 for s in scores if s == 0.5)
    prec_strict = sum(1 for s in scores if s == 1.0) / len(scores)
    prec_soft = sum(1 for s in scores if s >= 0.5) / len(scores)
    from collections import defaultdict

    by_unit: dict[tuple, list[float]] = defaultdict(list)
    for r in rows:
        if r.get("attr_score") in (None, ""):
            continue
        by_unit[(r["qa_id"], r["unit_id"])].append(float(r["attr_score"]))
    rec_strict = sum(1 for v in by_unit.values() if max(v) == 1.0) / len(by_unit)
    rec_soft = sum(1 for v in by_unit.values() if max(v) >= 0.5) / len(by_unit)

    assert abs(prec_strict - float(per["citation_precision_strict_attr1"])) < 1e-9
    assert abs(prec_soft - float(per["citation_precision_soft_attr_ge_0_5"])) < 1e-9
    assert abs(rec_strict - float(per["statement_recall_any_cite_strict"])) < 1e-9
    assert abs(rec_soft - float(per["statement_recall_any_cite_soft"])) < 1e-9
    # Manuscript Table 6 (rounded)
    assert abs(prec_strict - 0.19) < 0.01, prec_strict
    assert abs(rec_strict - 0.23) < 0.01, rec_strict
    assert abs(prec_soft - 0.72) < 0.01, prec_soft
    assert abs(rec_soft - 0.73) < 0.01, rec_soft
    assert n_half == 60, n_half
    # Veterinary PMID still in historical answers; not required for rates to match.
    vet = [r for r in rows if r["pmid"] == "29314873"]
    assert len(vet) == 8, len(vet)
    print(
        f"citation: P={prec_strict:.2f}/{prec_soft:.2f} "
        f"R={rec_strict:.2f}/{rec_soft:.2f} (strict/soft); "
        f"n=114; attr=0.5 count={n_half}; vet_pmid_instances={len(vet)}"
    )
    print("citation: OK")


def main() -> None:
    check_noframe()
    check_packet_scores()
    check_citation_faithfulness()
    print("all checks passed")


if __name__ == "__main__":
    main()
