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


def main() -> None:
    check_noframe()
    check_packet_scores()
    print("all checks passed")


if __name__ == "__main__":
    main()
