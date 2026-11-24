# Paired speech-recall routing ablation

**Status: executed on lab replay bots (2026-11-24).** Results in
`runs/speech_run_acceptance.jsonl` and `runs/speech_summary.json` (180/180 ok).
Lexical probes only---not human attribution. Withheld: spoken 90/90, slide-only
0/90; included control: spoken 56/90, slide-only 34/90.

## Design

- 30 short synthetic scheduling scenarios: 15 room values and 15 start times.
- Spoken transcript and displayed slide deliberately disagree on the requested
  fact. The question explicitly asks what the facilitator **said**.
- Both arms ingest the same transcript and one slide. Only speech-frame selection
  changes. All contexts are short enough to avoid the different image/text prompt
  clipping limits. No patient material or clinical recommendations are included.
- Three repetitions by default: 180 calls. Execution order is shuffled with seed
  2026; state resets for every case/arm/repetition.
- Checkpoint, response formatting, generation settings, frame limit, retrieval
  settings and hardware must remain fixed. Run both bot variants against the same
  model services. The backend uses temperature 0.2; no deterministic generation
  seed is added by this patch. Repetitions remain nested within cases.

The retained-frame control still has the speech-only instruction. This isolates
the additional effect of input withholding rather than comparing against a weaker
prompt. A null difference is informative and must be reported. This is a narrow,
template-derived conflict stress test, not evidence of clinical/general routing
accuracy. Do not tune on these cases and then call them held out.

## Backend switch (isolated experiment deployments only)

The patch targets the source blob IDs in `source_manifest.json`. In a matching
`meeting-bot` checkout:

```sh
git apply --check /path/to/speech_frame_policy.patch
git apply /path/to/speech_frame_policy.patch
npm run build
```

Launch two bot instances with separate ports/data directories but the same model
services and all other experimental controls:

| Instance | Environment setting | Expected frames used for speech |
| --- | --- | --- |
| Withheld (normal behavior) | `ECHO_SPEECH_RECALL_WITHHOLD_FRAMES=true` | 0 |
| Included (ablation control) | `ECHO_SPEECH_RECALL_WITHHOLD_FRAMES=false` | 1 |

Both require `DEMO_REPLAY_ENABLED=true`. The new setting defaults to true and is
exposed by health, so the normal deployed behavior is preserved if omitted. The
patch only permits speech frames through the existing selection stage; it leaves
the no-frame guard, speech-focus instruction and post-generation pipeline intact.
It is delivered as an unapplied patch, not a change to the running service.

## Run on the lab machine

Copy this folder, including `fixtures/`, to the lab. On the same host as both bots:

```sh
python run.py run --withheld-url http://127.0.0.1:3000 --included-url http://127.0.0.1:3001 --bot-root /path/to/patched/meeting-bot --output runs/speech_run.jsonl
python run.py summarize --input runs/speech_run.jsonl --output runs/speech_summary.json
python review.py --runs runs/speech_run.jsonl --cases cases.jsonl --output runs/blinded_review
```

If the runner is remote, use reachable replay URLs and `--server-fixture-dir` for
the directory containing the same PNGs on the bot server. `--bot-root` records the
hashes of the actual patched source checkout; it does not read `.env` or credentials.
Use matching code on both instances and retain the build/commit provenance.
Running on the lab host is the simplest route. Existing protected remote endpoints
can use `ECHO_REPLAY_AUTH_TOKEN` for a bearer token; it is not written to the output.

The runner refuses mismatched controls or missing/incorrect health flags. It
verifies actual returned frame counts, so unreadable images and text-only fallbacks
are **protocol violations**, not valid included-frame answers. Raw answers, response
metadata, errors, frame counts and latencies are preserved in every run.

## Scoring

The initial summary reports **lexical probes**: presence of the spoken value and
the slide-only value. A slide-only value mentioned in a negation is not necessarily
an error; do not relabel this rate as hallucination or source-confusion accuracy.

Use `review.py` to produce a shuffled, condition-label-blinded rating sheet. Give
reviewers each case's transcript and slide. Independently mark correct spoken
recall, attribution of slide-only content as speech, and inappropriate refusal.
Keep the condition key private; adjudicate disagreements. Report all attempts,
errors, violations and missing labels. Average repetitions/raters within each
case before paired case-level analysis. These files contain no completed human
ratings. No synthetic/model-generated rating should be reported as human review.

## Local verification

`python -m unittest -v test_run.py` tests protocol checks and a local mock API.
Mock outputs are only software tests; they are never experimental observations.
`python prepare.py --bot-root /path/to/unpatched/meeting-bot` regenerates fixtures
and the patch from the exact original source revision (Pillow required for fixture
rendering). It refuses changed source hashes. Normal experiment execution does
not need the generator or Pillow; the PNGs and patch are included.
