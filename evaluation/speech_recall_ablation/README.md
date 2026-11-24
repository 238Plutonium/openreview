# Speech-recall frame withholding

Paired experiment measuring what happens when a speech-recall question receives a conflicting slide image versus when that image is withheld.

**Recorded outcome (180/180 calls).** With frames withheld: spoken token 90/90, slide-only token 0/90. With frames included: spoken 56/90, slide-only 34/90. Artifacts: `runs/speech_run_acceptance.jsonl`, `runs/speech_summary.json`. Scoring uses lexical probes only; this package does not include human attribution ratings.

## Experiment design

Thirty synthetic scheduling scenarios (15 room values, 15 start times) place a spoken fact in the transcript and a different value on the slide. The question asks what the facilitator *said*. Both arms receive the same transcript and the same slide; only frame attachment for speech focus changes. Contexts are short enough that image and text prompt clipping do not differ between arms. No patient material is used.

Each case is run three times (180 calls total). Order is shuffled with seed 2026, and state is reset for every case/arm/repetition. Generation settings, frame limit, retrieval configuration, and model endpoints are held fixed. The included-frame arm keeps the speech-only instruction, so the contrast isolates input withholding rather than prompt strength.

This is a narrow conflict stress test on template questions. It does not measure clinical correctness or general routing accuracy.

## Reproducing the contrast

Apply `speech_frame_policy.patch` to a `meeting-bot` checkout whose source hashes match `source_manifest.json`, then build:

```sh
git apply --check speech_frame_policy.patch
git apply speech_frame_policy.patch
npm run build
```

Start two replay instances against the same model services:

| Arm | Setting | Frames for speech asks |
| --- | --- | --- |
| Withheld (system policy) | `ECHO_SPEECH_RECALL_WITHHOLD_FRAMES=true` | 0 |
| Included (control) | `ECHO_SPEECH_RECALL_WITHHOLD_FRAMES=false` | 1 |

Both instances need `DEMO_REPLAY_ENABLED=true`. The withholding flag defaults to true.

```sh
python run.py run \
  --withheld-url http://127.0.0.1:3000 \
  --included-url http://127.0.0.1:3001 \
  --bot-root /path/to/patched/meeting-bot \
  --output runs/speech_run.jsonl
python run.py summarize --input runs/speech_run.jsonl --output runs/speech_summary.json
```

Remote runners can pass reachable URLs and `--server-fixture-dir` so the bot host sees the same PNGs. Optional bearer auth uses `ECHO_REPLAY_AUTH_TOKEN` (not written to outputs). The runner rejects mismatched health flags and counts returned frames; unreadable images are protocol violations, not valid included-frame answers.

## Scoring and optional human review

The summary reports whether each answer contains the spoken value and/or the slide-only value. A negated mention of the slide value is not automatically an error.

`review.py` builds a shuffled, condition-blind rating sheet from transcript and slide. Raters mark correct spoken recall, slide content attributed as speech, and inappropriate refusal. This release contains no completed human ratings; model-generated scores must not be reported as human review.

## Local software checks

```sh
python -m unittest -v test_run.py
```

Mock outputs exercise the protocol only. `prepare.py --bot-root /path/to/unpatched/meeting-bot` regenerates fixtures and the patch from the pinned source revision (Pillow required); normal reproduction uses the included PNGs and patch.
