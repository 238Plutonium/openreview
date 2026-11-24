#!/usr/bin/env python3
"""Run paired speech-recall input-selection ablations on real replay deployments."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import statistics
import time
import urllib.request

ROOT=Path(__file__).resolve().parent
CONTROLS=['vlmModel','vlmMaxTokens','ragVlmMaxTokens','answerLlmEnabled','answerLlmModel','answerLlmMaxTokens',
 'answerLlmMaxChars','ragAnswerLlmMaxTokens','ragAnswerLlmMaxChars','literatureAnswerMaxTokens','literatureAnswerMaxChars',
 'answerStyle','contextMode','screenShareEnabled','screenShareMaxImages','screenShareMemoryLimit','screenShareMaxImageBytes','noFrameFixedReply']

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def request(base,path,body=None,timeout=180):
    headers={'Accept':'application/json','Content-Type':'application/json'}
    if os.environ.get('ECHO_REPLAY_AUTH_TOKEN'):headers['Authorization']='Bearer '+os.environ['ECHO_REPLAY_AUTH_TOKEN']
    req=urllib.request.Request(base.rstrip('/')+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
    with urllib.request.urlopen(req,timeout=timeout) as response:data=json.load(response)
    if data.get('ok') is False:raise RuntimeError(data.get('error','Backend failure'))
    return data

def validate_health(on,off):
    if not on.get('enabled') or not off.get('enabled'):raise ValueError('Enable DEMO_REPLAY_ENABLED on both isolated deployments')
    a,b=on['ai'],off['ai']
    if a.get('speechRecallWithholdFrames') is not True or b.get('speechRecallWithholdFrames') is not False:
        raise ValueError('Patched health flags must confirm withheld=true vs included=false')
    for key in CONTROLS:
        if key not in a or key not in b or a[key]!=b[key]:raise ValueError('Control mismatch or missing field: '+key)
    if not a['enabled'] or not b['enabled'] or not a['screenShareEnabled'] or a['screenShareMaxImages']<1:raise ValueError('Both AI and screen input must be enabled')
    return {key:a[key] for key in CONTROLS}

def contains(answer,value):
    return bool(re.search(r'(?<!\w)'+re.escape(value)+r'(?!\w)',answer,re.I))

def run(args):
    cases=[json.loads(x) for x in Path(args.cases).read_text().splitlines() if x.strip()]
    if len({c['id'] for c in cases})!=len(cases) or not cases:raise ValueError('Empty or duplicate case IDs')
    out=Path(args.output)
    if out.exists():raise ValueError('Output already exists; use a new run name')
    bases={'withheld':args.withheld_url,'included':args.included_url}
    health={k:request(v,'/demo/replay/health') for k,v in bases.items()}
    controls=validate_health(health['withheld'],health['included'])
    # Hash the two actual local source files from the lab checkout, not credentials.
    bot=Path(args.bot_root)
    code={name:sha(bot/name) for name in ['src/meetingAi.ts','src/server.ts']}
    jobs=[(c,arm,r) for c in cases for r in range(args.repeats) for arm in bases]
    random.Random(args.seed).shuffle(jobs)
    out.parent.mkdir(parents=True,exist_ok=True)
    meta={'status':'real_model_run','started_at_unix':time.time(),'cases_sha256':sha(args.cases),
      'source_sha256':code,'controls':controls,'seed':args.seed,'repeats':args.repeats,
      'policy':'Frame attachment differs; the speech-only instruction is retained in both arms.',
      'scoring':'Automatic token-presence probes only; use blinded human labels for source attribution.'}
    Path(str(out)+'.manifest.json').write_text(json.dumps(meta,indent=2)+'\n')
    with out.open('x') as stream:
        for c,arm,repeat in jobs:
            sid='speech-ablation-'+hashlib.sha256(f'{c["id"]}-{arm}-{repeat}-{time.time_ns()}'.encode()).hexdigest()[:20]
            fixture=Path(args.cases).resolve().parent/c['fixture']
            # Replay API only accepts paths under demo_replay/, data/rtms/, or echo-screens/
            # relative to the bot cwd (absolute paths outside those roots are rejected).
            if args.server_fixture_dir:
                server_file=Path(args.server_fixture_dir)/fixture.name
                parts=server_file.resolve().parts
                if 'demo_replay' in parts:
                    server_path=str(Path(*parts[parts.index('demo_replay'):]))
                else:
                    server_path='demo_replay/fixtures/'+fixture.name
            else:
                server_path=str(fixture)
            row={'case_id':c['id'],'family':c['family'],'arm':arm,'repeat':repeat,'question':c['question'],
                 'spoken_value':c['spoken_value'],'slide_only_value':c['slide_only_value'],'fixture_sha256':sha(fixture),
                 'started_at_unix':time.time(),'status':'error'}
            try:
                base=bases[arm];request(base,'/demo/replay/reset',{'streamId':sid},args.timeout)
                now=int(time.time()*1000)
                request(base,'/demo/replay/frame',{'streamId':sid,'meetingUuid':sid,'filePath':server_path,'frameId':1,'uniqueFrameId':1,'timestamp':now-2000},args.timeout)
                request(base,'/demo/replay/transcript',{'streamId':sid,'meetingUuid':sid,'baseTimestamp':now-10000,'segments':c['transcript']},args.timeout)
                start=time.perf_counter()
                raw=request(base,'/demo/replay/ask',{'streamId':sid,'question':c['question'],'askedAt':now,'allowPrivateIndex':False,'senderName':'synthetic-experiment'},args.timeout)
                row['latency_ms']=(time.perf_counter()-start)*1000;row['raw_response']=raw
                row['answer']=raw.get('finalAnswer') or raw.get('answer') or ''
                if not row['answer']:raise ValueError('Empty model answer')
                row['frames_used']=len(raw.get('screenShareFramesUsed',[]))
                if row['frames_used']!=(0 if arm=='withheld' else 1):
                    row['status']='protocol_violation';row['error']='Actual frame count does not match assigned arm; inspect load/fallback events'
                else:
                    row['status']='ok';row['spoken_token_present']=contains(row['answer'],c['spoken_value'])
                    row['slide_token_present']=contains(row['answer'],c['slide_only_value'])
            except Exception as exc:row['error']=str(exc)
            stream.write(json.dumps(row,ensure_ascii=False)+'\n');stream.flush()
            print(c['id'],arm,repeat,row['status'],flush=True)

def summarize(args):
    rows=[json.loads(x) for x in Path(args.input).read_text().splitlines() if x.strip()]
    if not rows:raise ValueError('No real run records; no results will be manufactured')
    seen=set();result={'status':'model_token_probes_not_human_attribution','input_sha256':sha(args.input),'arms':{}}
    for r in rows:
        k=(r['case_id'],r['arm'],r['repeat'])
        if k in seen:raise ValueError('Duplicate case/arm/repeat')
        seen.add(k)
    percase={}
    for arm in ['withheld','included']:
        subset=[r for r in rows if r['arm']==arm];ok=[r for r in subset if r['status']=='ok']
        grouped={c:[r for r in ok if r['case_id']==c] for c in sorted({r['case_id'] for r in ok})}
        values={metric:{c:statistics.mean(r[metric] for r in rs) for c,rs in grouped.items()} for metric in ['spoken_token_present','slide_token_present']}
        percase[arm]=values
        result['arms'][arm]={'attempted':len(subset),'successful':len(ok),'errors':sum(r['status']=='error' for r in subset),
          'protocol_violations':sum(r['status']=='protocol_violation' for r in subset),'n_successful_cases':len(grouped),
          'case_mean_token_rates':{m:statistics.mean(v.values()) if v else None for m,v in values.items()}}
    result['paired_withheld_minus_included']={}
    for metric in ['spoken_token_present','slide_token_present']:
        a,b=percase['withheld'][metric],percase['included'][metric];ids=sorted(set(a)&set(b))
        delta=[a[k]-b[k] for k in ids]
        result['paired_withheld_minus_included'][metric]={'n_cases':len(ids),'mean':statistics.mean(delta) if delta else None}
    result['interpretation']='Token mentions are lexical probes, not correctness: a slide-only term can appear in a negation. Review paired outputs independently. Failed/mismatched arms remain counted.'
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    a=sub.add_parser('run');a.add_argument('--withheld-url',required=True);a.add_argument('--included-url',required=True)
    a.add_argument('--cases',default=str(ROOT/'cases.jsonl'));a.add_argument('--bot-root',required=True);a.add_argument('--server-fixture-dir')
    a.add_argument('--output',required=True);a.add_argument('--repeats',type=int,default=3);a.add_argument('--seed',type=int,default=2026);a.add_argument('--timeout',type=float,default=180);a.set_defaults(fn=run)
    a=sub.add_parser('summarize');a.add_argument('--input',required=True);a.add_argument('--output',required=True);a.set_defaults(fn=summarize)
    args=p.parse_args()
    if hasattr(args,'repeats') and args.repeats<1:p.error('repeats must be positive')
    args.fn(args)
