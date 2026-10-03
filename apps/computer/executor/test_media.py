"""Native media contracts: real private files and the fixed systemd command boundary."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from .job_runtime import JobRuntime
from .user_session import UserSession

class NativeMediaTests(unittest.TestCase):
    def test_launch_uses_registered_uid_fixed_media_helper_and_owned_receipt(self):
        account={"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot","workspace":"/home/okami-bot/workspace","trustMode":"full-trust"}
        calls=[]
        def runner(args):
            calls.append(args)
            return 'OKAMI_MEDIA_RESULT:{"text":"Olá, hello, guten Tag","language":"pt","textPath":"/workspace/result.txt"}\n' if args[0]=='journalctl' else ''
        runtime=JobRuntime(UserSession({"node":account}),runner=runner)
        parameters={"path":"/workspace/voice; harmless.m4a","language":"auto","textPath":"/workspace/result.txt"}
        runtime.launch({"id":"media-one","executorId":"node","kind":"media","args":{"mediaKind":"transcribe","parameters":parameters,"memoryMaxBytes":3*1024**3,"timeoutMs":1800000}})
        argv=calls[0]
        self.assertIn('--property=User=okami-bot',argv)
        self.assertIn('--property=MemoryMax='+str(3*1024**3),argv)
        self.assertNotIn('/usr/bin/bash',argv)
        self.assertEqual(json.loads(base64.b64decode(argv[-1])),{"kind":"transcribe","parameters":parameters})
        self.assertEqual(runtime.output('media-one')['result']['text'],'Olá, hello, guten Tag')
        runtime.launch({"id":"media-one","executorId":"node","kind":"media","args":{"mediaKind":"transcribe","parameters":parameters}})
        self.assertEqual(sum(call[0]=='systemd-run' for call in calls),1)
    def test_output_publish_preserves_a_human_file_and_rejects_symlink(self):
        spec=importlib.util.spec_from_file_location('media_job',Path(__file__).parents[1]/'media_job.py')
        helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
        with tempfile.TemporaryDirectory() as directory:
            workspace=helper.NewOutputWorkspace(directory)
            workspace.write_bytes('/workspace/new.txt','Olá'.encode())
            with self.assertRaises(FileExistsError):workspace.write_bytes('/workspace/new.txt',b'overwrite')
            self.assertEqual((Path(directory)/'new.txt').read_text(),'Olá')
            (Path(directory)/'link').symlink_to(Path(directory)/'new.txt')
            with self.assertRaises(FileExistsError):workspace.write_bytes('/workspace/link',b'overwrite')
            self.assertEqual((Path(directory)/'new.txt').read_text(),'Olá')
            self.assertEqual(len(list(Path(directory).glob('.okami-media-*'))),0)
