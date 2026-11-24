# GPU-free recorded outputs and the next paired experiment

## Available now

Open `recorded_replay/index.html` after downloading this folder. The viewer embeds
all 70 complete real saved responses from the existing 35-case no-frame study,
including both arms and original metadata. It performs no network requests.
Run `python recorded_replay/verify_paired_replay.py` to recompute the archived counts
on a CPU. This supports output inspection, not regeneration of new model answers.

The bundle covers missing-frame abstention. It does not contain a newly captured
with-frame slide/speech/literature demonstration. `capture_multimodal.py` provides
the producer for that recording on the lab machine.

## Prepared, not yet run on real models

`../eval/speech_recall_ablation/` contains 30 synthetic room/time conflicts, images,
an opt-in backend patch, a controlled paired runner, frame-count validation,
summary tools and blinded human-review export. See that folder's README.
The public PubMed web endpoint cannot run this experiment: its replay route is
not exposed. A reachable lab replay deployment or execution on the lab host is
still needed. No ablation outcome has been added to the manuscript.

## Access scope

These additions are saved to the private working repository. Before submission,
the intended reviewer-facing bundle needs to be made available through an
accessible supplement or release. Private GitHub links are not reviewer access.
