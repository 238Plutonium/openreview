"""Create neutral synthetic conflict fixtures and an opt-in backend patch."""
from pathlib import Path
import argparse
import difflib
import hashlib
import json
from PIL import Image,ImageDraw,ImageFont

ROOT=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--bot-root',type=Path,required=True,help='Matching unpatched meeting-bot checkout')
args=parser.parse_args()
SOURCE=args.bot_root/'src'
(ROOT/'fixtures').mkdir(exist_ok=True)

def replace_once(text,old,new):
    if text.count(old)!=1:raise ValueError('Source changed; inspect patch anchor: '+old[:70])
    return text.replace(old,new,1)

meeting=(SOURCE/'meetingAi.ts').read_text();server=(SOURCE/'server.ts').read_text()
expected={'meetingAi.ts':'f627a2224a4264b39fcb0a83e331c1d4269f3caaf8b15dae66c34adfa6b8b337',
          'server.ts':'658e897eecf9089642881b928d0a66b225aded9cf8a8057f53b04bb02c813754'}
for filename,text in [('meetingAi.ts',meeting),('server.ts',server)]:
    if hashlib.sha256(text.encode()).hexdigest()!=expected[filename]:raise ValueError('Source revision mismatch: '+filename)
m=replace_once(meeting,'  noFrameFixedReply: boolean;','  noFrameFixedReply: boolean;\n  /** Experiment-only switch; omitted/true preserves normal speech-frame withholding. */\n  speechRecallWithholdFrames?: boolean;')
m=replace_once(m,'function shouldWithholdScreenShare(question: string, focus: QuestionFocus): boolean {\n  return focus === "speech" || looksLikeSelfIdentityQuestion(question);\n}',
'''function shouldWithholdScreenShare(
  question: string,
  focus: QuestionFocus,
  withholdSpeechFrames = true,
): boolean {
  return (withholdSpeechFrames && focus === "speech") || looksLikeSelfIdentityQuestion(question);
}''')
m=replace_once(m,'      noFrameFixedReply: this.config.noFrameFixedReply,','      noFrameFixedReply: this.config.noFrameFixedReply,\n      speechRecallWithholdFrames: this.config.speechRecallWithholdFrames !== false,')
m=replace_once(m,'      question.question,\n      focus,\n    )\n      ? []','      question.question,\n      focus,\n      this.config.speechRecallWithholdFrames !== false,\n    )\n      ? []')
s=replace_once(server,'      noFrameFixedReply: parseBoolean(\n        process.env.ECHO_NO_FRAME_FIXED_REPLY,\n        true,\n      ),','''      noFrameFixedReply: parseBoolean(
        process.env.ECHO_NO_FRAME_FIXED_REPLY,
        true,
      ),
      speechRecallWithholdFrames: parseBoolean(
        process.env.ECHO_SPEECH_RECALL_WITHHOLD_FRAMES,
        true,
      ),''')
patch=''.join(difflib.unified_diff(meeting.splitlines(True),m.splitlines(True),fromfile='a/src/meetingAi.ts',tofile='b/src/meetingAi.ts'))
patch+=''.join(difflib.unified_diff(server.splitlines(True),s.splitlines(True),fromfile='a/src/server.ts',tofile='b/src/server.ts'))
(ROOT/'speech_frame_policy.patch').write_text(patch)
font='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
title=ImageFont.truetype(font,30);body=ImageFont.truetype(font,48);small=ImageFont.truetype(font,20)
rooms=['Cedar','Maple','Birch','Willow','Aspen','Juniper','Oak','Pine','Elm','Spruce','Alder','Cypress','Poplar','Hazel','Walnut']
cases=[]
for i in range(30):
    kind='room' if i<15 else 'time'
    j=i%15
    spoken=rooms[j] if kind=='room' else f'{8+j//4:02d}:{(j%4)*15:02d}'
    foil=rooms[(j+7)%15] if kind=='room' else f'{13+j//4:02d}:{(j%4)*15:02d}'
    noun='room' if kind=='room' else 'start time'
    case_id=f'SPEECH-{i+1:02d}'
    transcript=f'The {noun} for the next teaching session is {spoken}. Please use that {noun} in the session invitation.'
    question=f'What {noun} did the facilitator say to use for the next teaching session?'
    image=Image.new('RGB',(960,540),'#F3F7FC');draw=ImageDraw.Draw(image)
    draw.rectangle((0,0,960,90),fill='#173B61');draw.text((44,28),'Next teaching session',font=title,fill='white')
    draw.text((44,180),noun.upper(),font=title,fill='#536C83');draw.text((44,240),foil,font=body,fill='#18364F')
    draw.text((44,465),'Synthetic scheduling slide | no patient information',font=small,fill='#536C83')
    filename=case_id+'.png';image.save(ROOT/'fixtures'/filename)
    cases.append({'id':case_id,'family':kind,'question':question,'transcript':[{'userName':'Facilitator','text':transcript}],
                  'fixture':'fixtures/'+filename,'spoken_value':spoken,'slide_only_value':foil,
                  'status':'synthetic_conflict_stress_test_not_real_meeting'})
(ROOT/'cases.jsonl').write_text(''.join(json.dumps(c)+'\n' for c in cases))
(ROOT/'source_manifest.json').write_text(json.dumps({'status':'prepared_not_executed','source_repository':'238Plutonium/echo-ai-naacl-submission',
 'original_blobs':{'src/meetingAi.ts':'01ea6be9103c97cd16115adea244fce55747be55','src/server.ts':'5c4943c2372dac6718235c56b805d5c93539899a'},
 'original_sha256':{'src/meetingAi.ts':hashlib.sha256(meeting.encode()).hexdigest(),'src/server.ts':hashlib.sha256(server.encode()).hexdigest()},
 'patched_sha256':{'src/meetingAi.ts':hashlib.sha256(m.encode()).hexdigest(),'src/server.ts':hashlib.sha256(s.encode()).hexdigest()},
 'cases':30,'generation':'Deterministic neutral room/time conflicts; not clinical material'},indent=2)+'\n')
print(ROOT/'speech_frame_policy.patch')
