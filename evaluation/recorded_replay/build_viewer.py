"""Build a self-contained viewer from archived real inputs/outputs; no inference."""
from pathlib import Path
import csv
import hashlib
import html as escape_html
import json

ROOT=Path(__file__).resolve().parent
runs=[json.loads(x) for x in (ROOT/'paired_runs_n35.jsonl').read_text().splitlines() if x.strip()]
with (ROOT/'paired_runs_n35_labels.csv').open(newline='') as f:labels=list(csv.DictReader(f))
by_key={(r['case_id'],r['condition']):r for r in labels}
for r in runs:r['archived_label']=by_key[r['case_id'],r['condition']]['label']
payload=json.dumps(runs,ensure_ascii=False).replace('</','<\\/')
html='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ECHO-AI | Recorded visual-guard walkthrough</title>
<style>
:root{color-scheme:light;--ink:#172b42;--muted:#566c80;--line:#d3dfe9;--blue:#2468ae;--teal:#117f77}
*{box-sizing:border-box}body{margin:0;background:#f5f8fc;color:var(--ink);font:16px/1.55 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:32px 24px 56px}h1{font-size:clamp(28px,4vw,42px);line-height:1.15;margin:14px 0}h2{font-size:21px;margin:0 0 16px}.eyebrow{font-size:12px;letter-spacing:.12em;font-weight:750;color:var(--teal)}.muted{color:var(--muted)}.notice{padding:15px 18px;background:#e8f2fc;border-left:4px solid var(--blue);border-radius:4px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}.stat,.card{border:1px solid var(--line);background:white;border-radius:12px;padding:22px}.stat strong{display:block;font-size:28px}.toolbar{margin:28px 0 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}select,button{font:inherit;background:white;border:1px solid #9ab0c4;border-radius:6px;padding:10px}.question{padding:20px;border-radius:10px;background:#eaf0f8;margin:12px 0 20px;font-size:19px}.arms{display:grid;grid-template-columns:1fr 1fr;gap:20px}.on{border-top:4px solid var(--teal)}.off{border-top:4px solid #b97122}.answer{white-space:pre-wrap;overflow-wrap:anywhere;min-height:140px}.tag{font-size:13px;color:var(--muted);margin:8px 0 18px}details{margin-top:18px}pre{font:12px/1.5 ui-monospace,monospace;overflow:auto;max-height:320px;padding:16px;background:#f4f7fb}footer{margin-top:32px;font-size:14px;color:var(--muted)}a{color:#185b9a}.links{display:flex;gap:16px;flex-wrap:wrap}.links a{padding:8px 0}@media(max-width:650px){.stats,.arms{grid-template-columns:1fr}.stat{padding:14px 18px}.stat strong{font-size:24px}main{padding:24px 16px}}
</style><main><div class="eyebrow">ECHO-AI / RECORDED OUTPUTS / GPU-FREE</div>
<h1>Inspect what changes when the visual guard is disabled.</h1>
<p class="muted">35 matched synthetic questions, 70 complete archived responses. Compare the same question under guard ON and guard OFF.</p>
<div class="notice"><strong>Recorded playback, not live generation.</strong> This page makes no network requests. You can inspect every saved case and recompute its counts on a CPU. It does not generate answers to new questions or demonstrate with-frame slide grounding.</div>
<div class="stats"><div class="stat"><strong>33 / 35</strong>Guard ON abstentions</div><div class="stat"><strong>3 / 35</strong>Guard OFF abstentions</div><div class="stat"><strong>+85.7 pp</strong>Paired abstention difference</div></div>
<div class="toolbar"><label for="case">Recorded question</label><select id="case"></select><button id="prev" type="button">Previous</button><button id="next" type="button">Next</button></div>
<div id="question" class="question"></div><div class="arms"><article class="card on"><h2>Guard ON</h2><div id="onmeta" class="tag"></div><div id="onanswer" class="answer"></div><details><summary>Original run metadata and response</summary><pre id="onraw"></pre></details></article><article class="card off"><h2>Guard OFF</h2><div id="offmeta" class="tag"></div><div id="offanswer" class="answer"></div><details><summary>Original run metadata and response</summary><pre id="offraw"></pre></details></article></div>
<footer><p><strong>Evidence scope.</strong> Every case has zero attached frames. The saved labels describe abstention, not clinical correctness. Two guarded cases did not abstain. Guard ON was called “baseline” and OFF “treatment” in the original files; the labels are mapped explicitly here.</p><div class="links"><a href="paired_runs_n35.jsonl">Full original outputs</a><a href="paired_runs_n35_labels.csv">Archived labels</a><a href="paired_cases.json">Input questions</a><a href="README.md">Verification instructions</a><a href="provenance.json">Provenance</a></div><p>CPU verification: <code>python verify_paired_replay.py</code>. No model installation, API key, lab GPU, Zoom account, or server is needed to view this page.</p></footer></main>
<script id="records" type="application/json">__PAYLOAD__</script><script>
'use strict';const records=JSON.parse(document.getElementById('records').textContent);const ids=[...new Set(records.map(r=>r.case_id))].sort();const select=document.getElementById('case');for(const id of ids){const option=document.createElement('option');option.value=id;option.textContent=id;select.append(option)}
function show(){const pair=records.filter(r=>r.case_id===select.value);document.getElementById('question').textContent=pair[0].question;for(const [key,condition] of [['on','baseline'],['off','treatment']]){const r=pair.find(r=>r.condition===condition);document.getElementById(key+'answer').textContent=r.answer;document.getElementById(key+'meta').textContent=`Archived label: ${r.archived_label} | Frames: ${r.frames_used} | ${r.result.latency_ms.toFixed(1)} ms | ${r.utc}`;document.getElementById(key+'raw').textContent=JSON.stringify(r,null,2)}}
select.addEventListener('change',show);for(const [name,delta] of [['prev',-1],['next',1]])document.getElementById(name).addEventListener('click',()=>{select.selectedIndex=(select.selectedIndex+delta+ids.length)%ids.length;show()});show();
</script></html>'''.replace('__PAYLOAD__',payload)
first=[r for r in runs if r['case_id']=='VIS-ZERO-01']
options=''.join('<option value="'+escape_html.escape(i)+'">'+escape_html.escape(i)+'</option>' for i in sorted({r['case_id'] for r in runs}))
html=html.replace('<select id="case"></select>','<select id="case">'+options+'</select>')
html=html.replace('<div id="question" class="question"></div>','<div id="question" class="question">'+escape_html.escape(first[0]['question'])+'</div>')
for key,condition in [('on','baseline'),('off','treatment')]:
    r=next(r for r in first if r['condition']==condition)
    html=html.replace(f'<div id="{key}answer" class="answer"></div>',f'<div id="{key}answer" class="answer">'+escape_html.escape(r['answer'])+'</div>')
html=html.replace("for(const id of ids){const option=document.createElement('option');option.value=id;option.textContent=id;select.append(option)}",'')
(ROOT/'index.html').write_text(html)
sources={
 'paired_runs_n35.jsonl':'5ff3910f8572c4fc7fd3b85b9de833d0f348e4c7',
 'paired_runs_n35_labels.csv':'c317c784b42ced1c525ee51bac5f53881e7a32e0',
 'paired_cases.json':'5f22bb07777af09467746aedb57fa0c24bdefcd1',
 'verify_paired_replay.py':'a03381f606908407a410347d9cd3a6416fe1961f'}
manifest={'status':'archived_real_outputs_not_new_inference','origin_repository':'238Plutonium/echo-ai-demo-paper',
 'origin_commit':'3dff3d1005684dbd51d659d17aade90d0dc1e30a',
 'origin_directory':'archive/public-submission-2026-11-24/current-files/reviewer_package/eval/',
 'files':[{ 'file':name,'source_git_blob_sha':sha,'local_sha256':hashlib.sha256((ROOT/name).read_bytes()).hexdigest()} for name,sha in sources.items()],
 'transfer_note':'Text line endings normalized to LF; run content and archived labels unchanged',
 'n_pairs':35,'n_responses':70,'scope':'No-frame visual safeguard; with-frame multimodal replay outputs have not been captured in this bundle.'}
(ROOT/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(ROOT/'index.html')
