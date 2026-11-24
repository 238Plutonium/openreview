"""Recompute the published zero-frame results from the archived outputs and labels."""

import csv
import json
from collections import Counter
from pathlib import Path
from statistics import mean, median


root = Path(__file__).resolve().parent
arms = {"baseline": "guard on", "treatment": "guard off"}
with (root / "paired_runs_n35.jsonl").open(encoding="utf-8") as stream:
    runs = [json.loads(line) for line in stream if line.strip()]
with (root / "paired_runs_n35_labels.csv").open(encoding="utf-8", newline="") as stream:
    labels = list(csv.DictReader(stream))

runs_by_key = {(row["case_id"], row["condition"]): row for row in runs}
labels_by_key = {(row["case_id"], row["condition"]): row for row in labels}
if len(runs_by_key) != len(runs) or len(labels_by_key) != len(labels):
    raise ValueError("Duplicate case/condition record")
cases = sorted({case_id for case_id, _ in runs_by_key})
expected = {(case_id, arm) for case_id in cases for arm in arms}
if len(cases) != 35 or runs_by_key.keys() != expected or labels_by_key.keys() != expected:
    raise ValueError("Expected 35 complete pairs with one label per run")
if len({row["code_sha"] for row in runs}) != 1:
    raise ValueError("Paired runs must use the same code revision")

paired = Counter()
latencies = {arm: [] for arm in arms}
for case_id in cases:
    runs_for_case = [runs_by_key[case_id, arm] for arm in arms]
    if len({row["question"] for row in runs_for_case}) != 1:
        raise ValueError(f"Prompt differs across arms for {case_id}")
    refused = []
    for arm, row in zip(arms, runs_for_case):
        label = labels_by_key[case_id, arm]
        flag_value = "true" if arm == "baseline" else "false"
        if not row["configuration"].startswith(f"ECHO_NO_FRAME_FIXED_REPLY={flag_value} "):
            raise ValueError(f"Unexpected guard configuration for {case_id}, {arm}")
        if row["frames_used"] != 0 or int(label["frames_used"]) != 0:
            raise ValueError(f"Unexpected attached frame for {case_id}, {arm}")
        refused.append(label["label"] == "refuse")
        latencies[arm].append(row["result"]["latency_ms"])
    paired[tuple(refused)] += 1

both, on_only, off_only, neither = (paired[key] for key in ((True, True), (True, False), (False, True), (False, False)))
print(f"Both abstain: {both}; guard on only: {on_only}; guard off only: {off_only}; neither: {neither}")
for arm, count in zip(arms, (both + on_only, both + off_only)):
    times = latencies[arm]
    print(f"{arms[arm]}: {count}/{len(cases)} abstain, mean {mean(times):.1f} ms, median {median(times):.1f} ms")
print(f"Paired change: {100 * (on_only - off_only) / len(cases):+.1f} percentage points")
