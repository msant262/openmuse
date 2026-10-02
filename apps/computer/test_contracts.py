"""Real local helper/job tests and injected firewall contracts, never host firewall writes."""
import importlib.util
import http.client
import threading
from http.server import ThreadingHTTPServer
import json
import os
import tempfile
import time
import wave
from types import SimpleNamespace
import unittest
from unittest.mock import patch

BASE = os.path.dirname(__file__)
def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(BASE, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
files, runtime, gateway, media = [load(name) for name in ("files", "runtime", "gateway", "media")]


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = files.Workspace(self.temp.name)
    def tearDown(self):
        self.temp.cleanup()
    def test_binary_and_text_roundtrip(self):
        self.workspace.handle({"operation":"mkdir","path":"/workspace/notes"})
        self.workspace.handle({"operation":"write","path":"/workspace/notes/hello.txt","text":"Olá ✓"})
        self.assertEqual(self.workspace.handle({"operation":"read","path":"/workspace/notes/hello.txt"})["text"],"Olá ✓")
        self.workspace.handle({"operation":"write_binary","path":"/workspace/office.docx","base64":"AAECAw=="})
        self.assertEqual(self.workspace.handle({"operation":"read_binary","path":"/workspace/office.docx"})["base64"],"AAECAw==")
    def test_traversal_links_special_and_limits(self):
        for path in ("/workspace/../escape", "/workspace-other/file", "/etc/passwd"):
            with self.assertRaises(ValueError):
                self.workspace.parts(path)
        os.symlink("/etc", os.path.join(self.temp.name,"escape"))
        os.symlink("/etc/passwd", os.path.join(self.temp.name,"linked"))
        os.mkfifo(os.path.join(self.temp.name,"fifo"))
        for path in ("/workspace/escape/passwd","/workspace/linked","/workspace/fifo"):
            with self.assertRaises((OSError,ValueError)):
                self.workspace.open_read(path)
        with self.assertRaises(ValueError):
            self.workspace.write_bytes("/workspace/linked",b"bad")
        with self.assertRaises(ValueError):
            self.workspace.handle({"operation":"write","path":"/workspace/large","text":"x"*(files.LIMIT+1)})
        with self.assertRaises(ValueError):
            self.workspace.handle({"operation":"write_pdf","path":"/workspace/bad.pdf","base64":"AAECAw=="})


class JobsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.jobs = runtime.Jobs(workspace=files.Workspace(self.temp.name),state_dir=os.path.join(self.temp.name,"state"),home=self.temp.name)
    def tearDown(self):
        self.jobs.stop()
        self.temp.cleanup()
    def submit(self, command, id="a"*64, **kwargs):
        return self.jobs.submit({"id":id,"command":command,"timeoutMs":1000,"background":True,**kwargs})
    def wait(self,id):
        deadline = time.monotonic()+8
        while self.jobs.get(id)["status"] == "running" and time.monotonic()<deadline:
            time.sleep(.02)
        return self.jobs.get(id)
    def test_command_receipt_no_inherited_secrets_and_idempotency(self):
        os.environ["COMPUTER_TOKEN"]="must-not-enter-command"
        os.environ["OPENAI_API_KEY"]="must-not-enter-command"
        self.submit("printf 'ok'; test -z \"$COMPUTER_TOKEN$OPENAI_API_KEY\"")
        receipt = self.wait("a"*64)
        self.assertEqual(receipt["status"],"succeeded")
        self.assertEqual(receipt["stdout"],"ok")
        self.assertEqual(self.submit("printf 'ok'; test -z \"$COMPUTER_TOKEN$OPENAI_API_KEY\"")["id"],receipt["id"])
        with self.assertRaises(ValueError):
            self.submit("printf different")
    def test_timeout_cancel_and_output_limit(self):
        self.submit("sleep 10")
        self.assertEqual(self.wait("a"*64)["status"],"timed_out")
        self.submit("sleep 10",id="b"*64)
        self.jobs.cancel("b"*64)
        self.assertEqual(self.wait("b"*64)["status"],"interrupted")
        self.submit("python3 -c 'print(\"x\"*300000)'",id="c"*64)
        receipt = self.wait("c"*64)
        self.assertEqual(receipt["status"],"succeeded")
        self.assertTrue(receipt["truncated"])
        self.assertLessEqual(len(receipt["stdout"])+len(receipt["stderr"]),runtime.MAX_OUTPUT)
    def test_restart_marks_unknown_without_rerun_and_bounds(self):
        with self.assertRaises(ValueError):
            self.submit("true",timeoutMs=1800001)
        self.submit("true")
        receipt = self.wait("a"*64)
        receipt.update(status="running",binding=self.jobs.receipts["a"*64]["binding"])
        self.jobs.save(receipt)
        restored = runtime.Jobs(workspace=self.jobs.workspace,state_dir=self.jobs.directory,home=self.temp.name)
        self.assertEqual(restored.get("a"*64)["status"],"interrupted")
        self.assertEqual(restored.submit({"id":"a"*64,"command":"true","timeoutMs":1000,"background":True})["status"],"interrupted")
    def test_completion_is_not_visible_before_process_cleanup(self):
        entered, release = threading.Event(), threading.Event()
        def cleanup():
            entered.set()
            return release.wait(3)
        self.jobs.sweep = cleanup  # Trusted injected fixture; never host process scanning.
        server = None
        thread = None
        try:
            self.submit("printf done")
            self.assertTrue(entered.wait(3))
            self.assertEqual(self.jobs.get("a"*64)["status"], "running")
            with self.assertRaisesRegex(ValueError,"busy"):
                self.submit("true",id="b"*64)
            server = ThreadingHTTPServer(("127.0.0.1",0),runtime.handler(self.jobs))
            thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            connection = http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=3)
            try:
                connection.request("POST","/rpc/jobs",json.dumps({"id":"c"*64,"command":"true","timeoutMs":1000,"background":True}),{"Content-Type":"application/json"})
                response = connection.getresponse()
                payload = json.loads(response.read())
                self.assertEqual(response.status,409)
                self.assertEqual(payload["code"],"busy")
                self.assertTrue(payload["notDispatched"])
                self.assertNotIn("c"*64,self.jobs.receipts)
            finally:
                connection.close()
        finally:
            release.set()
            if server:
                server.shutdown();server.server_close();thread.join()
        self.assertEqual(self.wait("a"*64)["status"],"succeeded")
    def test_unconfirmed_cleanup_quarantines_and_never_claims_success(self):
        def failed_cleanup():
            raise OSError("injected cleanup failure")
        self.jobs.sweep = failed_cleanup
        try:
            self.submit("true")
            receipt = self.wait("a"*64)
            self.assertEqual(receipt["status"],"interrupted")
            self.assertTrue(self.jobs.quarantined)
            self.assertFalse(self.jobs.enabled)
            with self.assertRaises(ValueError):
                self.submit("true",id="b"*64)
            server = ThreadingHTTPServer(("127.0.0.1",0),runtime.handler(self.jobs))
            thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            connection = http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=3)
            try:
                connection.request("GET","/health")
                self.assertEqual(json.loads(connection.getresponse().read()),{"ready":False})
            finally:
                connection.close();server.shutdown();server.server_close();thread.join()
        finally:
            self.jobs.sweep = lambda: True  # Fixture teardown only.


class FirewallTests(unittest.TestCase):
    def controller(self):
        state = {}
        def runner(argv):
            tool, _, _, operation, chain, *rule = argv
            key=(tool,chain)
            if operation == "-P": state[key]=[["-P",chain,*rule]]
            elif operation == "-F": state[key]=state[key][:1]
            elif operation == "-A": state[key].append(["-A",chain,*rule])
            elif operation == "-S": return "\n".join(" ".join(r) for r in state[key])+"\n"
            return ""
        policy=gateway.Firewall("172.30.88.2","1.0.0.1",runner)
        policy.install()
        return policy,state
    def test_real_rule_spec_covers_host_private_metadata_and_ipv6(self):
        policy,state=self.controller()
        self.assertTrue(policy.verify())
        for ip in ("1.0.0.1","10.1.2.3","172.30.88.2","192.168.0.1","100.100.100.200","169.254.169.254","168.63.129.16","127.0.0.11","::1","fd00::1","2606:4700:4700::1111"):
            self.assertFalse(policy.permits(ip),ip)
        self.assertTrue(policy.permits("8.8.4.4"))
        self.assertEqual(state[("ip6tables","OUTPUT")],[["-P","OUTPUT","DROP"]])
        state[("iptables","OUTPUT")].append(["-A","OUTPUT","-j","ACCEPT"])
        with self.assertRaises(RuntimeError): policy.verify()
    def test_missing_ipv6_and_host_ip_fail_closed(self):
        for ips in ("","192.168.1.1","invalid"):
            with self.assertRaises(ValueError): gateway.Firewall("172.30.88.2",ips)
        policy,state=self.controller()
        state[("ip6tables","OUTPUT")]=[["-P","OUTPUT","ACCEPT"]]
        with self.assertRaises(RuntimeError): policy.verify()
    def test_proxy_never_dispatches_without_actual_guard_or_rpc_readiness(self):
        policy,state=self.controller()
        token="x"*32
        probes=[]
        def ready():
            probes.append(True)
            return False
        server=ThreadingHTTPServer(("127.0.0.1",0),gateway.handler(policy,token,ready))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def call(auth=True,path="/rpc/jobs"):
            connection=http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=3)
            try:
                connection.request("POST",path,body="{}",headers={"Authorization":"Bearer "+token} if auth else {})
                result=connection.getresponse();result.read();return result.status
            finally: connection.close()
        try:
            self.assertEqual(call(False),401);self.assertEqual(probes,[])
            self.assertEqual(call(True,"/arbitrary/proxy"),404);self.assertEqual(probes,[])
            self.assertEqual(call(),503);self.assertEqual(len(probes),1)
            state[("iptables","OUTPUT")]=[["-P","OUTPUT","ACCEPT"]]
            self.assertEqual(call(),503);self.assertEqual(len(probes),1)
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_runtime_rejects_host_root_boot(self):
        # main has explicit nonroot + Docker-init/PID-namespace prerequisites;
        # constructor injection used above intentionally does not prove them.
        with patch.object(runtime.os,"getuid",return_value=0), self.assertRaisesRegex(RuntimeError,"nonroot"):
            runtime.main()
        with patch.object(runtime.os,"getuid",return_value=1000), patch.object(runtime.os,"getppid",return_value=25), self.assertRaisesRegex(RuntimeError,"PID namespace"):
            runtime.main()


class MediaTests(unittest.TestCase):
    def test_srt_rounding_and_hours(self):
        self.assertEqual(media.timestamp(59.9996),"00:01:00,000")
        self.assertEqual(media.timestamp(3600.001),"01:00:00,001")
        self.assertEqual(media.timestamp(-1),"00:00:00,000")
    def test_transcription_fixed_local_cpu_contract_and_real_srt_files(self):
        with tempfile.TemporaryDirectory() as root:
            workspace=files.Workspace(root)
            workspace.write_bytes("/workspace/source.mp4",b"fixture")
            model_dir=os.path.join(root,"model");os.makedirs(model_dir)
            with open(os.path.join(model_dir,"model.bin"),"wb") as model: model.write(b"stub")
            invocations=[]
            def decode(argv,**kwargs):
                self.assertEqual(argv[argv.index("-protocol_whitelist")+1],"file,pipe")
                self.assertTrue(argv[argv.index("-i")+1].startswith("/proc/self/fd/"))
                self.assertEqual(len(kwargs["pass_fds"]),1)
                with wave.open(argv[-1],"wb") as decoded:
                    decoded.setnchannels(1);decoded.setsampwidth(2);decoded.setframerate(16000);decoded.writeframes(b"\x00\x00"*32000)
            class Model:
                def transcribe(self,path,**kwargs):
                    invocations.append(kwargs)
                    return iter([SimpleNamespace(start=0,end=1,text=" Olá ")]),SimpleNamespace(language="pt",language_probability=.99)
            def factory(path,**kwargs):
                self.assertEqual(path,model_dir)
                self.assertEqual(kwargs,{"device":"cpu","compute_type":"int8","cpu_threads":2,"num_workers":1,"local_files_only":True})
                return Model()
            with patch.object(media.subprocess,"run",decode):
                for language in ("auto","pt","en","de"):
                    result=media.transcribe({"path":"/workspace/source.mp4","language":language,"textPath":"/workspace/result.txt","srtPath":"/workspace/result.srt"},workspace=workspace,model_path=model_dir,model_factory=factory)
                    self.assertEqual(result["text"],"Olá")
                    self.assertEqual(result["duration"],2)
                    self.assertEqual(invocations[-1]["language"],None if language=="auto" else language)
            self.assertEqual(workspace.handle({"operation":"read","path":"/workspace/result.txt"})["text"],"Olá")
            self.assertIn("00:00:00,000 --> 00:00:01,000",workspace.handle({"operation":"read","path":"/workspace/result.srt"})["text"])

    def test_missing_model_and_language_are_not_downloaded(self):
        with tempfile.TemporaryDirectory() as root:
            workspace=files.Workspace(root)
            with self.assertRaisesRegex(ValueError,"offline Whisper"):
                media.transcribe({"path":"/workspace/a.mp3"},workspace=workspace,model_path=root)
            with self.assertRaisesRegex(ValueError,"Language"):
                media.transcribe({"path":"/workspace/a.mp3","language":"bad"},workspace=workspace,model_path=root)


if __name__ == "__main__":
    unittest.main()
