# Recorded no-frame visual-guard walkthrough

Offline package of the paired zero-frame visual study: 35 synthetic slide questions, each answered once with the visual guard enabled and once with it disabled. Open `index.html` in a browser to compare conditions; the page is self-contained and makes no network requests.

The answers are archived execution records from the original paired run, not freshly generated text. In the source logs, guard ON is labeled `baseline` and guard OFF `treatment`; those labels are preserved. No case has an attached frame, so the package shows missing-visual-evidence behavior rather than with-frame grounding quality.

## CPU verification

```sh
python verify_paired_replay.py
```

Expected: 35 complete pairs; guard ON abstains 33/35; guard OFF abstains 3/35; 31 ON-only, 1 OFF-only, 2 both, 1 neither. The verifier checks code revision, question text, guard configuration, and frame counts against the archived files.

## Contents

| File | Role |
| --- | --- |
| `paired_runs_n35.jsonl` | Full run records and answers |
| `paired_runs_n35_labels.csv` | Outcome labels and latency excerpts |
| `paired_cases.json` | Input questions |
| `provenance.json` | Git blob IDs and SHA-256 checksums |
| `build_viewer.py` | Rebuilds the HTML viewer from the JSONL |

Localhost endpoints in the metadata identify the original capture host; the viewer does not contact them. Regenerating model responses still requires the original model services. This study does not provide claim-level correctness ratings.

## Optional multimodal capture (producer script)

`capture_multimodal.py` can record a slide/speech/literature fixture against a live replay API and write a second HTML page. That capture is not included here yet; the script is a producer, not archived evidence.

```sh
python capture_multimodal.py \
  --base-url http://127.0.0.1:3000 \
  --manifest /path/to/meeting-bot/demo_replay/manifest.json \
  --local-frame /path/to/meeting-bot/demo_replay/fixtures/slide.jpg \
  --server-frame-path /path/to/meeting-bot/demo_replay/fixtures/slide.jpg \
  --output new_multimodal_capture
```

Use identical image bytes on client and server. Capture needs model services; the resulting HTML does not.
