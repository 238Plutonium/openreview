"""Create a condition-label-blinded sheet from actual run outputs."""
import argparse
import csv
import json
from pathlib import Path
import random

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--runs',required=True);p.add_argument('--cases',required=True);p.add_argument('--output',required=True);p.add_argument('--seed',type=int,default=2026);args=p.parse_args()
    rows=[json.loads(x) for x in Path(args.runs).read_text().splitlines() if x.strip()]
    cases={c['id']:c for c in [json.loads(x) for x in Path(args.cases).read_text().splitlines() if x.strip()]}
    rows=[r for r in rows if r['status']=='ok']
    if not rows:raise ValueError('No successful real run outputs')
    random.Random(args.seed).shuffle(rows);out=Path(args.output);out.mkdir(parents=True,exist_ok=False)
    fields=['answer_id','case_id','question','transcript','frame_fixture','answer','rater_id','correct_spoken_recall_0or1','slide_attributed_as_speech_0or1','inappropriate_refusal_0or1','notes']
    key=[]
    with (out/'review.csv').open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
        for i,r in enumerate(rows,1):
            c=cases[r['case_id']];rid=f'A{i:04d}'
            w.writerow({'answer_id':rid,'case_id':c['id'],'question':c['question'],
                'transcript':'\n'.join(t['text'] for t in c['transcript']),'frame_fixture':c['fixture'],'answer':r['answer']})
            key.append({'answer_id':rid,'case_id':c['id'],'arm':r['arm'],'repeat':r['repeat']})
    (out/'PRIVATE_key.json').write_text(json.dumps(key,indent=2)+'\n')
    print(out/'review.csv')

if __name__=='__main__':main()
