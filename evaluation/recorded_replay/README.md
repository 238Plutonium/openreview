# Recorded visual-guard walkthrough (no GPUs)

Download this directory and open **index.html** in a browser. The page embeds all
70 complete saved responses for the 35 paired synthetic no-frame questions. It
works offline, makes no requests, and requires no model services or installation.
Select any of the recorded questions to compare both conditions and inspect the
original run metadata. The interactive selector only selects recorded outputs.

This is genuine saved execution data recovered from the archived paired study,
not newly generated answers, a simulated model, or independent validation. The
original files call guard ON `baseline` and guard OFF `treatment`. Labels are
preserved. None of these cases has an attached frame; this package demonstrates
recorded missing-visual-evidence behavior, not with-frame visual grounding.

## Recompute on a CPU

```sh
python verify_paired_replay.py
```

Expected counts: 35 complete pairs; guard ON 33/35 abstentions; OFF 3/35;
31 ON-only, 1 OFF-only, 2 both, 1 neither. The verifier checks code-revision,
question, guard-configuration and frame-count consistency using the original data.

## Files

- `paired_runs_n35.jsonl`: full original run records, including complete answers.
- `paired_runs_n35_labels.csv`: archived outcome labels and latency excerpts.
- `paired_cases.json`: original input questions.
- `provenance.json`: original Git blob IDs and local SHA-256 checksums.
- `build_viewer.py`: rebuilds the self-contained viewer from those files.

The original endpoint was localhost on the lab machine. It is metadata, not a
service that this viewer contacts. Exact regeneration of model responses still
requires the original model services; CPU verification recomputes recorded outcomes.
No claim-level correctness rating is provided by this study.

## Capture the full slide/speech/literature fixture on the lab machine

`capture_multimodal.py` runs the existing manifest against the real replay API,
saves the input frame, transcript and complete responses, and produces a second
self-contained HTML page. This script is a producer, not pre-recorded evidence:
the three-step replay has **not** been captured in this directory yet.

```sh
python capture_multimodal.py --base-url http://127.0.0.1:3000 --manifest /path/to/meeting-bot/demo_replay/manifest.json --local-frame /path/to/meeting-bot/demo_replay/fixtures/slide.jpg --server-frame-path /path/to/meeting-bot/demo_replay/fixtures/slide.jpg --output new_multimodal_capture
```

Use the same image bytes on the client and bot server. Capturing requires model
services; opening the resulting HTML afterward requires neither GPUs nor a server.
Preserve failures and check attached frames before treating the recording as a
successful multimodal demonstration. Review all outputs before any public release.
