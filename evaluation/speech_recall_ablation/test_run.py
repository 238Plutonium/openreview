import argparse
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import run

def health(flag):
    return {'ok':True,'enabled':True,'ai':dict({key:1 for key in run.CONTROLS},enabled=True,speechRecallWithholdFrames=flag,screenShareEnabled=True)}

class TestRun(unittest.TestCase):
    def test_policy_flag_must_actually_differ(self):
        with self.assertRaisesRegex(ValueError,'health flags'):run.validate_health(health(True),health(True))
    def test_model_control_mismatch_fails(self):
        b=health(False);b['ai']['vlmModel']='another checkpoint'
        with self.assertRaisesRegex(ValueError,'Control mismatch'):run.validate_health(health(True),b)
    def test_word_probe_does_not_match_substrings(self):
        self.assertTrue(run.contains('The room is Cedar.','Cedar'))
        self.assertFalse(run.contains('The room is Cedarwood.','Cedar'))
    def test_frame_protocol_is_verified_on_mock_api(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps(health(self.server.withheld)).encode())
            def do_POST(self):
                data=json.loads(self.rfile.read(int(self.headers['Content-Length'])));result={'ok':True}
                if self.path.endswith('/ask'):
                    # Deliberately wrong included count: confirm it is never scored as a valid arm.
                    result.update(answer='Cedar',screenShareFramesUsed=[])
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps(result).encode())
        servers=[]
        try:
            for flag in [True,False]:
                s=ThreadingHTTPServer(('127.0.0.1',0),Handler);s.withheld=flag
                threading.Thread(target=s.serve_forever,daemon=True).start();servers.append(s)
            with tempfile.TemporaryDirectory() as tmp,contextlib.redirect_stdout(io.StringIO()):
                root=Path(tmp);(root/'src').mkdir();(root/'src/meetingAi.ts').write_text('test');(root/'src/server.ts').write_text('test')
                (root/'frame.png').write_bytes(b'fixture bytes for mock only')
                case={'id':'mock','family':'room','question':'What room did the facilitator say?','transcript':[{'text':'Cedar'}],
                      'fixture':'frame.png','spoken_value':'Cedar','slide_only_value':'Maple'}
                (root/'cases.jsonl').write_text(json.dumps(case)+'\n')
                args=argparse.Namespace(cases=root/'cases.jsonl',output=root/'runs.jsonl',bot_root=root,withheld_url=f'http://127.0.0.1:{servers[0].server_port}',
                    included_url=f'http://127.0.0.1:{servers[1].server_port}',seed=2026,repeats=1,server_fixture_dir=None,timeout=2)
                run.run(args)
                rows=[json.loads(x) for x in args.output.read_text().splitlines()]
                self.assertEqual({r['arm']:r['status'] for r in rows},{'withheld':'ok','included':'protocol_violation'})
                with self.assertRaisesRegex(ValueError,'already exists'):run.run(args)
        finally:
            for s in servers:s.shutdown();s.server_close()

if __name__=='__main__':unittest.main()
