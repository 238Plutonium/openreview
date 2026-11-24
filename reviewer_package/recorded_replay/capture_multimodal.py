#!/usr/bin/env python3
"""Capture the three-step fixture replay on a lab host, then produce offline HTML.

No answers are included or generated until this script contacts the real replay API.
"""
import argparse
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import time
import urllib.request

def post(base,path,data):
    headers={'Content-Type':'application/json'}
    if os.environ.get('ECHO_REPLAY_AUTH_TOKEN'):headers['Authorization']='Bearer '+os.environ['ECHO_REPLAY_AUTH_TOKEN']
    req=urllib.request.Request(base.rstrip('/')+path,data=json.dumps(data).encode(),headers=headers)
    with urllib.request.urlopen(req,timeout=180) as r:payload=json.load(r)
    if not payload.get('ok'):raise RuntimeError(payload.get('error','Replay call failed'))
    return payload

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--base-url',required=True);p.add_argument('--manifest',required=True)
    p.add_argument('--local-frame',required=True);p.add_argument('--server-frame-path',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    manifest=json.loads(Path(args.manifest).read_text());frame=Path(args.local_frame);out=Path(args.output)
    if out.exists():raise ValueError('Use a new capture directory')
    out.mkdir(parents=True);shutil.copyfile(frame,out/frame.name);shutil.copyfile(args.manifest,out/'input_manifest.json')
    sid='saved-multimodal-'+str(time.time_ns());now=int(time.time()*1000)
    post(args.base_url,'/demo/replay/reset',{'streamId':sid})
    post(args.base_url,'/demo/replay/frame',{'streamId':sid,'meetingUuid':sid,'filePath':args.server_frame_path,'frameId':1,'uniqueFrameId':1,'timestamp':now-15000})
    transcript=manifest.get('transcript',[])
    post(args.base_url,'/demo/replay/transcript',{'streamId':sid,'meetingUuid':sid,'baseTimestamp':now-(len(transcript)+2)*5000,'segments':transcript})
    records=[]
    with (out/'recorded_outputs.jsonl').open('x') as stream:
        for item in manifest['questions']:
            record={'question_id':item.get('id'),'question':item['question'],'utc_unix':time.time(),
              'fixture_sha256':hashlib.sha256(frame.read_bytes()).hexdigest(),'status':'error'}
            try:
                start=time.perf_counter()
                response=post(args.base_url,'/demo/replay/ask',{'streamId':sid,'question':item['question'],'allowPrivateIndex':item.get('allowPrivateIndex',False),'askedAt':now,'senderName':'fixture-capture'})
                record.update(status='ok',latency_ms=(time.perf_counter()-start)*1000,response=response)
            except Exception as exc:record['error']=str(exc)
            stream.write(json.dumps(record,ensure_ascii=False)+'\n');stream.flush();records.append(record)
    mime='image/png' if frame.suffix.lower()=='.png' else 'image/jpeg'
    image=f'data:{mime};base64,'+base64.b64encode(frame.read_bytes()).decode()
    cards=''.join('<section><h2>'+html.escape(r['question'])+'</h2><pre>'+html.escape(json.dumps(r,indent=2,ensure_ascii=False))+'</pre></section>' for r in records)
    doc='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ECHO-AI recorded multimodal replay</title><style>body{font:16px/1.6 system-ui;max-width:1050px;margin:32px auto;padding:0 20px;color:#172b42;background:#f7f9fc}section{background:white;border:1px solid #ccd9e6;border-radius:12px;padding:22px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%}</style><h1>Recorded multimodal replay</h1><p>Real saved API outputs from a lab execution. This page performs no inference or network requests. Inspect failures as well as successes; it is not live generation.</p><section><h2>Original input frame</h2><img alt="Captured replay fixture" src="'+image+'"><h2>Transcript fixture</h2><pre>'+html.escape(json.dumps(transcript,indent=2,ensure_ascii=False))+'</pre></section>'+cards
    (out/'index.html').write_text(doc)
    print(out/'index.html')

if __name__=='__main__':main()
