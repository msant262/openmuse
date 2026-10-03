"""Native executor contracts: local files/SQLite and injected system commands only."""
import hashlib
import importlib
import json
import os
from pathlib import Path
import sqlite3
import http.client
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import threading
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def module(test, name):
    try:
        return importlib.import_module("executor." + name)
    except ModuleNotFoundError:
        test.fail("Native executor feature is absent: " + name)


class FileContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.files = module(self, "files").Workspace(
            Path(self.temp.name) / "workspace", Path(self.temp.name) / "state",
            max_version_bytes=1024 * 1024)
        self.addCleanup(self.files.close)

    def test_binary_uuid_receipt_and_duplicate_binding_survive_restart(self):
        request_id = "2a4e756e-5074-4738-9343-2c36dfb1cf85"
        first = self.files.write("/workspace/attachment.bin", b"\x00\xff", operation_id=request_id)
        self.assertEqual(first["sha256"], "06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8")
        same = self.files.write("/workspace/attachment.bin", b"\x00\xff", operation_id=request_id)
        self.assertEqual(same, first)
        with self.assertRaisesRegex(ValueError, "binding"):
            self.files.write("/workspace/attachment.bin", b"different", operation_id=request_id)
        restored = module(self, "files").Workspace(self.files.root, self.files.state_root)
        self.addCleanup(restored.close)
        self.assertEqual(restored.write("/workspace/attachment.bin", b"\x00\xff", operation_id=request_id), first)

    def test_versions_trash_and_human_edit_restore_as_copy(self):
        first = self.files.write("/workspace/note.txt", b"good")
        bad = self.files.write("/workspace/note.txt", b"bad", expected_version=first["version"])
        original = self.files.versions(first["artifactId"])[0]
        self.assertEqual(original["sha256"], first["sha256"])
        self.files.write("/workspace/note.txt", b"human", expected_version=bad["version"])
        restored = self.files.restore(original["id"], bad["version"])
        self.assertTrue(restored["restoredAsCopy"])
        self.assertEqual(self.files.read("/workspace/note.txt"), b"human")
        self.assertEqual(self.files.read(restored["path"]), b"good")
        trash = self.files.trash(first["artifactId"], hashlib.sha256(b"human").hexdigest(), task_id="task")
        with self.assertRaises(FileNotFoundError):
            self.files.read("/workspace/note.txt")
        recovered = self.files.restore(trash["id"], None)
        self.assertEqual(self.files.read(recovered["path"]), b"human")
        self.assertNotEqual(recovered["version"], trash["id"])

    def test_existing_file_cancel_and_disk_budget_preserve_original(self):
        first = self.files.write("/workspace/a", b"original")
        with self.assertRaisesRegex(ValueError, "version"):
            self.files.write("/workspace/a", b"accidental")
        with self.assertRaisesRegex(ValueError, "cancel"):
            self.files.write("/workspace/a", b"bad", expected_version=first["version"], cancelled=lambda: True)
        self.assertEqual(self.files.read("/workspace/a"), b"original")

        self.files.max_version_bytes = 1
        with self.assertRaisesRegex(ValueError, "space|budget"):
            self.files.write("/workspace/a", b"bad", expected_version=first["version"])
        self.assertEqual(self.files.read("/workspace/a"), b"original")

    def test_first_controlled_edit_captures_an_existing_human_file(self):
        path=self.files.root/"human.txt"
        path.write_bytes(b"human original");path.chmod(0o600)
        envelope={"id":"controlled-existing","taskId":"task","kind":"file",
            "args":{"operation":"write","path":"/workspace/human.txt","text":"controlled edit","captureCurrent":True}}
        result=self.files.handle(envelope)
        self.assertEqual(self.files.read(result["path"]),b"controlled edit")
        versions=self.files.versions(result["artifactId"])
        self.assertEqual(len(versions),1)
        self.assertEqual(versions[0]["sha256"],hashlib.sha256(b"human original").hexdigest())
        restored=self.files.restore(versions[0]["id"],result["version"])
        self.assertEqual(self.files.read(restored["path"]),b"human original")

    def test_symlink_swapped_parent_cannot_publish_outside_workspace(self):
        self.files.mkdir("/workspace/sub")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        swapped = False
        def progress(done, total):
            nonlocal swapped
            if not swapped:
                (self.files.root / "sub").rename(self.files.root / "old-sub")
                (self.files.root / "sub").symlink_to(outside, target_is_directory=True)
                swapped = True
        with self.assertRaisesRegex(ValueError, "changed|symlink"):
            self.files.write("/workspace/sub/result", b"data", progress=progress)
        self.assertEqual(list(outside.iterdir()), [])
        with self.assertRaises((ValueError, OSError)):
            self.files.read("/workspace/sub/result")

    def test_crash_after_capture_preserves_recovery_and_no_publication(self):
        first = self.files.write("/workspace/result.txt", b"before")
        def crash(done, total):
            raise OSError("Wi-Fi interrupted")
        with self.assertRaisesRegex(OSError, "Wi-Fi"):
            self.files.write("/workspace/result.txt", b"after", expected_version=first["version"], progress=crash)
        self.assertEqual(self.files.read("/workspace/result.txt"), b"before")
        self.assertEqual(len(self.files.versions(first["artifactId"])), 1)
        self.assertEqual(self.files.pending_publications()[0]["version"], first["version"])
        with self.assertRaisesRegex(ValueError, "ACK"):
            self.files.acknowledge(first["artifactId"], first["version"], "0" * 64)
        self.files.acknowledge(first["artifactId"], first["version"], first["sha256"])
        self.assertEqual(self.files.pending_publications(), [])

    def test_source_modified_during_read_is_not_returned_as_a_verified_transfer(self):
        native=module(self,"files")
        artifact=self.files.write("/workspace/source.bin",b"before")
        original=native.os.fdopen
        class ChangedReader:
            def __init__(self,stream):self.stream=stream
            def __enter__(self):return self
            def __exit__(self,*args):return self.stream.__exit__(*args)
            def fileno(self):return self.stream.fileno()
            def read(self,*args):
                value=self.stream.read(*args)
                (self.files.root/"source.bin").write_bytes(b"human changed")
                return value
        def fdopen(fd,mode,*args,**kwargs):
            stream=original(fd,mode,*args,**kwargs)
            reader=ChangedReader(stream);reader.files=self.files
            return reader if mode=="rb" else stream
        with patch.object(native.os,"fdopen",side_effect=fdopen),self.assertRaisesRegex(ValueError,"changed"):
            self.files.read(artifact["path"])

    def test_human_edit_after_receipt_is_not_published_with_the_old_hash(self):
        artifact=self.files.write("/workspace/pending.bin",b"verified result")
        (self.files.root/"pending.bin").write_bytes(b"human later")
        with self.assertRaisesRegex(ValueError,"changed"):
            self.files.verify_publication(artifact)
        self.assertFalse(self.files.artifact(artifact["artifactId"])["published"])

    def test_real_disk_insufficiency_preserves_original_and_a_new_executor_has_scoped_ids(self):
        native=module(self,"files")
        first=self.files.write("/workspace/source.bin",b"before")
        from types import SimpleNamespace
        with patch.object(native.shutil,"disk_usage",return_value=SimpleNamespace(free=0)),self.assertRaisesRegex(ValueError,"space"):
            self.files.write(first["path"],b"after",expected_version=first["version"])
        self.assertEqual(self.files.read(first["path"]),b"before")
        scoped=native.Workspace(Path(self.temp.name)/"other-workspace",Path(self.temp.name)/"other-state",artifact_namespace="other-executor")
        self.addCleanup(scoped.close)
        self.assertNotEqual(scoped.write(first["path"],b"before")["artifactId"],first["artifactId"])

    def test_human_file_survives_symlink_swap_and_another_edit_at_atomic_publication(self):
        first=self.files.write("/workspace/destination",b"before")
        self.files.acknowledge(first["artifactId"],first["version"],first["sha256"])
        original=self.files.exchange
        raced=False
        def race(parent,stage,name):
            nonlocal raced
            if raced:return original(parent,stage,name)
            raced=True
            target=self.files.root/name
            target.unlink();target.symlink_to(Path(self.temp.name)/"outside")
            original(parent,stage,name)
            target.unlink();target.write_bytes(b"human after")
        with patch.object(self.files,"exchange",side_effect=race),self.assertRaises((ValueError,OSError)):
            self.files.write(first["path"],b"controlled",expected_version=first["version"])
        self.assertEqual(self.files.read(first["path"]),b"human after")
        self.assertEqual(self.files.pending_publications(),[])

    def test_stage_edit_replacement_and_nonregular_entry_never_publish_a_false_hash(self):
        original=self.files.verify_parent
        for mode in ("edit","replace","symlink","directory"):
            with self.subTest(mode=mode):
                path="/workspace/stage-"+mode
                first=self.files.write(path,b"human original")
                self.files.acknowledge(first["artifactId"],first["version"],first["sha256"])
                corrupted=False
                def corrupt(logical,parent,root):
                    nonlocal corrupted
                    original(logical,parent,root)
                    if corrupted:return
                    corrupted=True
                    stage=next(self.files.root.glob(".okami-stage-*"))
                    if mode=="edit":stage.write_bytes(b"concurrent edit")
                    elif mode=="replace":stage.unlink();stage.write_bytes(b"concurrent replacement")
                    elif mode=="symlink":stage.unlink();stage.symlink_to(self.files.root/"outside")
                    else:stage.unlink();stage.mkdir()
                with patch.object(self.files,"verify_parent",side_effect=corrupt),self.assertRaises((ValueError,OSError)):
                    self.files.write(path,b"planned bytes",expected_version=first["version"],operation_id="stage-"+mode)
                self.assertEqual(self.files.read(path),b"human original")
                self.assertFalse(any(item["path"]==path for item in self.files.pending_publications()))
                for stage in self.files.root.glob(".okami-stage-*"):
                    if stage.is_dir() and not stage.is_symlink():stage.rmdir()
                    else:stage.unlink()

    def test_workspace_constructor_rejects_intermediate_symlink_before_creating_or_chowning(self):
        native=module(self,"files")
        home=Path(self.temp.name)/"home";home.mkdir()
        outside=Path(self.temp.name)/"outside";outside.mkdir()
        (home/"projects").symlink_to(outside,target_is_directory=True)
        with self.assertRaises((ValueError,OSError)):
            native.Workspace(home/"projects"/"workspace",Path(self.temp.name)/"other-state")
        self.assertEqual(list(outside.iterdir()),[])

    def test_workspace_anchor_rejects_later_intermediate_symlink_swap(self):
        native=module(self,"files")
        home=Path(self.temp.name)/"home";workspace=home/"projects"/"workspace"
        files=native.Workspace(workspace,Path(self.temp.name)/"other-state");self.addCleanup(files.close)
        outside=Path(self.temp.name)/"outside";(outside/"workspace").mkdir(parents=True)
        (home/"projects").rename(home/"old-projects");(home/"projects").symlink_to(outside,target_is_directory=True)
        with self.assertRaises((ValueError,OSError)):
            files.write("/workspace/probe.txt",b"data")
        self.assertEqual(list((outside/"workspace").iterdir()),[])


class SupervisorContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 0.0
        self.effects = []
        self.contained = True
        self.revocations = []
        supervisor = module(self, "supervisor")
        self.journal = supervisor.Journal(Path(self.temp.name) / "journal.sqlite")
        self.addCleanup(self.journal.close)
        self.gate = supervisor.Gate(
            self.journal, clock=lambda: self.now,
            contain=lambda reason: self.revocations.append(reason) or self.contained)
        self.gate.handshake(2, {"paused": False, "revision": 0}, 40)

    def operation(self, **patch):
        return {"id": "f" * 64, "taskId": "task", "revision": 4,
                "bindingHash": "b" * 64, "executorId": "lenovo-okami",
                "executorEpoch": 2, "resourceFence": 9, "capability": "command",
                "resourceKey":"cpu-heavy:lenovo",
                "capabilityVersion": 1, "expiresAt": "2999-01-01T00:00:00Z",
                "kind": "command", "args": {"command": "printf ok", "cwd": "/workspace"}, **patch}

    def test_gate_starts_closed_reconciliation_required_and_boot_epoch_fenced(self):
        gate = module(self, "supervisor").Gate(self.journal, clock=lambda: self.now, contain=lambda _: True)
        with self.assertRaisesRegex(ValueError, "closed|reconcil"):
            gate.check(self.operation())
        self.gate.reconciled()
        self.gate.check(self.operation())
        with self.assertRaisesRegex(ValueError, "epoch"):
            self.gate.check(self.operation(executorEpoch=1))
        self.gate.check(self.operation(resourceFence=10))
        with self.assertRaisesRegex(ValueError, "fence"):
            self.gate.check(self.operation(resourceFence=9))
        with self.assertRaisesRegex(ValueError, "expired"):
            self.gate.check(self.operation(expiresAt="2000-01-01T00:00:00Z", resourceFence=10))

    def test_suspend_clock_watchdog_live_old_process_and_quarantine(self):
        self.gate.reconciled()
        self.now = 41  # CLOCK_BOOTTIME includes time while the machine slept.
        self.assertFalse(self.gate.watchdog())
        self.assertEqual(self.revocations, ["watchdog"])
        with self.assertRaisesRegex(ValueError, "closed"):
            self.gate.check(self.operation())
        self.contained = False
        self.gate.handshake(3, {"paused": False, "revision": 1}, 40)
        self.gate.reconciled()
        self.gate.suspend()
        self.assertTrue(self.gate.quarantined)
        with self.assertRaisesRegex(ValueError, "quarant"):
            self.gate.reconciled()

    def test_pause_revision_persists_and_resume_requires_explicit_new_handshake(self):
        self.gate.reconciled()
        ack = self.gate.pause({"paused": True, "revision": 2})
        self.assertEqual(ack, {"epoch": 2, "revision": 2, "contained": True, "guaranteed": True})
        self.assertEqual(self.journal.state("pause"), {"paused": True, "revision": 2})
        self.gate.pause({"paused": False, "revision": 1})
        with self.assertRaisesRegex(ValueError, "paused"):
            self.gate.check(self.operation())
        self.gate.check(self.operation(kind="cancel",args={"operationId":"a"*64}),containment=True)
        with self.assertRaisesRegex(ValueError,"fixed"):
            self.gate.check(self.operation(kind="command"),containment=True)
        self.gate.pause({"paused": False, "revision": 3})
        with self.assertRaisesRegex(ValueError, "reconcil|closed"):
            self.gate.check(self.operation())
        self.gate.handshake(2, {"paused": False, "revision": 3}, 40)
        self.gate.reconciled()
        self.gate.check(self.operation())

    def test_journal_terminal_wins_old_receipt_restart_never_reruns_unknown(self):
        operation = self.operation()
        self.assertTrue(self.journal.receive(operation))
        self.assertFalse(self.journal.receive(operation))
        self.journal.receipt(operation["id"], {"status": "running"})
        final = self.journal.receipt(operation["id"], {"status": "succeeded", "data": {"stdout": "ok"}})
        old = self.journal.receipt(operation["id"], {"status": "running"})
        self.assertEqual(old, final)
        self.assertEqual(final["sequence"], 2)
        with self.assertRaisesRegex(ValueError, "binding"):
            self.journal.receive(self.operation(bindingHash="c" * 64))
        unknown = self.operation(id="e" * 64)
        self.journal.receive(unknown)
        self.journal.recover()
        self.assertEqual(self.journal.get(unknown["id"])["receipt"]["status"], "outcome_unknown")
        self.assertFalse(self.journal.receive(unknown))
        self.journal.acknowledge(operation["id"], 1)
        self.assertIn(operation["id"], [item["operationId"] for item in self.journal.unacknowledged()])
        self.journal.acknowledge(operation["id"], 2)
        self.assertNotIn(operation["id"], [item["operationId"] for item in self.journal.unacknowledged()])
        self.assertNotIn(operation["id"],[item["operationId"] for item in self.journal.manifest()])
        self.assertFalse(self.journal.receive(operation))

    def test_full_trust_cannot_claim_mutable_failover_containment(self):
        gate = module(self, "supervisor").Gate(self.journal, clock=lambda: self.now,
            contain=lambda _: True, trust_mode="full-trust")
        gate.handshake(2, {"paused": False, "revision": 0}, 40)
        self.assertFalse(gate.pause({"paused": True, "revision": 1})["guaranteed"])

    def test_real_http_transport_scopes_auth_serializes_json_and_rejects_redirect(self):
        native=module(self,"supervisor")
        received=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*_):
                pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append((self.path,self.headers.get("Authorization"),body))
                if self.path.endswith("/claim"):
                    self.send_response(302);self.send_header("Location","http://elsewhere/");self.end_headers();return
                self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(b'{"epoch":1}')
        server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            transport=native.NodeTransport("http://100.113.59.40:8787","lenovo-okami","s"*32)
            transport.origin="http://127.0.0.1:"+str(server.server_port)  # Local HTTP fixture only; constructor tailnet policy remains tested.
            self.assertEqual(transport.request("register",{"bootId":"fixture"}),{"epoch":1})
            self.assertEqual(received[0],("/executor/lenovo-okami/register","Bearer "+"s"*32,{"bootId":"fixture"}))
            with self.assertRaisesRegex(ValueError,"redirect"):
                transport.request("claim",{"epoch":1})
            for origin in ["http://127.0.0.1:8787","http://example.com","http://100.113.59.40/other","http://secret@100.113.59.40"]:
                with self.assertRaises(ValueError):
                    native.NodeTransport(origin,"lenovo-okami","s"*32)
        finally:
            server.shutdown();server.server_close();worker.join()

    def test_connected_runtime_uses_authoritative_budget_and_keeps_second_heavy_queued(self):
        native=module(self,"supervisor")
        files=module(self,"files").Workspace(Path(self.temp.name)/"workspace",Path(self.temp.name)/"files")
        self.addCleanup(files.close)
        account={"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot","workspace":"/home/okami-bot/workspace","trustMode":"full-trust"}
        class Sessions:
            def account(self,_):return account
        launches=[]
        class Runtime:
            active={}
            def contain(self,*_,**__):return True
            def adopt(self,_):pass
            def launch(self,operation):launches.append(operation)
        class Helper:
            def gate(self,*_):return True
            def contain_session(self,*_):return True
        snapshot=lambda _: {"memoryTotalBytes":16*1024**3,"memoryAvailableBytes":12*1024**3,"botsMaxBytes":13*1024**3}
        supervisor=native.Supervisor({"executorId":"lenovo-okami","hostId":"lenovo","reserveBytes":3*1024**3},Sessions(),Runtime(),files,self.journal,None,Helper(),clock=lambda:self.now,resource_snapshot=snapshot)
        supervisor.gate.handshake(2,{"paused":False,"revision":0},40);supervisor.gate.reconciled()
        first=self.operation(resourceBudget={"memoryBytes":9*1024**3,"heavy":True})
        supervisor.perform(first)
        self.assertEqual(launches[0]["args"]["memoryMaxBytes"],9*1024**3)
        second=self.operation(id="3"*64,resourceBudget={"memoryBytes":1024**3,"heavy":True})
        supervisor.perform(second)
        self.assertEqual(len(launches),1)
        self.assertEqual(self.journal.get(second["id"])["receipt"]["status"],"rejected_not_dispatched")
        self.assertEqual(supervisor.budget.reserved_bytes,9*1024**3)

    def test_cleanup_confirmation_updates_unknown_receipt_without_claiming_effect_success(self):
        operation=self.operation()
        self.journal.receive(operation)
        self.journal.receipt(operation["id"],{"status":"outcome_unknown","data":{"cleanupConfirmed":False}})
        final=self.journal.receipt(operation["id"],{"status":"outcome_unknown","data":{"cleanupConfirmed":True}})
        self.assertEqual(final["sequence"],2)
        self.assertTrue(final["receipt"]["data"]["cleanupConfirmed"])
        self.assertEqual(self.journal.receipt(operation["id"],{"status":"running"}),final)

    def test_resource_fences_are_per_resource_and_expiry_uses_server_clock(self):
        self.gate.handshake(2,{"paused":False,"revision":0},40,"2998-12-31T23:59:50Z")
        self.gate.reconciled()
        self.gate.check(self.operation(resourceKey="file:lenovo:a",resourceFence=80))
        self.gate.check(self.operation(resourceKey="file:lenovo:b",resourceFence=1))
        self.now=11
        with self.assertRaisesRegex(ValueError,"expired"):
            self.gate.check(self.operation(resourceKey="file:lenovo:b",resourceFence=1))

    def test_sleep_control_requires_root_and_confirms_containment_before_ack(self):
        native=module(self,"supervisor")
        class Instance:
            gate=self.gate
        with self.assertRaisesRegex(ValueError,"root"):
            native.control_request(Instance(),1003,{"operation":"prepare-sleep"})
        self.gate.reconciled()
        ack=native.control_request(Instance(),0,{"operation":"prepare-sleep"})
        self.assertTrue(ack["contained"])
        self.assertFalse(self.gate.open)
        self.assertTrue(self.gate.needs_reconciliation)
        self.contained=False
        self.assertFalse(native.control_request(Instance(),0,{"operation":"prepare-sleep"})["contained"])

    def test_private_unix_control_uses_actual_peer_credentials_and_socket_permissions(self):
        native=module(self,"supervisor")
        from types import SimpleNamespace
        ipc=Path(self.temp.name)/"private-control";ipc.mkdir(mode=0o700)
        instance=SimpleNamespace(gate=self.gate,stop_event=threading.Event())
        if os.getuid()!=0:
            with self.assertRaisesRegex(ValueError,"root-owned"):
                native.PrivateControl(instance,ipc/"node.sock")
            return
        control=native.PrivateControl(instance,ipc/"node.sock")
        thread=threading.Thread(target=control.serve,daemon=True);thread.start()
        try:
            self.gate.reconciled()
            native.prepare_sleep("node",ipc)
            self.assertFalse(self.gate.open)
            self.assertEqual((ipc/"node.sock").stat().st_mode&0o777,0o600)
        finally:
            instance.stop_event.set();control.close();thread.join(timeout=1)


class NativeResourcesContracts(unittest.TestCase):
    def test_production_job_mounts_use_live_directory_anchors_and_reject_an_ancestor_swap(self):
        filesystem=module(self,"filesystem")
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);home=base/"home";workspace=home/"projects"/"workspace";workspace.mkdir(parents=True)
            account={"uid":1003,"gid":1004,"user":"okami-bot","home":str(home),"workspace":str(workspace),"trustMode":"full-trust"}
            calls=[];sessions=module(self,"user_session").UserSession({"node":account},runner=lambda argv:"")
            root_fd=filesystem.open_directory(workspace);home_fd=filesystem.open_directory(home)
            try:
                runtime=module(self,"job_runtime").JobRuntime(sessions,runner=lambda argv:calls.append(argv) or "",workspace_fd=root_fd,home_fd=home_fd,executor_id="node")
                request={"id":"anchor-job","executorId":"node","args":{"command":"true","cwd":"/workspace","timeoutMs":1000}}
                runtime.launch(request)
                self.assertIn(f"--property=BindPaths=/proc/{os.getpid()}/fd/{root_fd}:/workspace /proc/{os.getpid()}/fd/{home_fd}:{home}",calls[0])
                outside=base/"outside";(outside/"workspace").mkdir(parents=True)
                (home/"projects").rename(home/"old-projects");(home/"projects").symlink_to(outside,target_is_directory=True)
                with self.assertRaises((ValueError,OSError)):
                    runtime.launch({**request,"id":"changed-root"})
                self.assertEqual(len(calls),1)
            finally:os.close(root_fd);os.close(home_fd)
    def test_job_oom_is_service_scoped_and_uses_supported_oom_policy(self):
        sessions = module(self,"user_session").UserSession({"node":{"uid":1003,"gid":1004,"user":"okami-bot",
            "home":"/home/okami-bot","workspace":"/home/okami-bot/workspace","trustMode":"full-trust"}},runner=lambda argv:"")
        calls=[]
        runtime=module(self,"job_runtime").JobRuntime(sessions,runner=lambda argv:calls.append(argv) or
            "LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=oom-kill\nExecMainStatus=137\nExecMainCode=2\nExecMainStartTimestampMonotonic=1\nExecMainExitTimestampMonotonic=2\nControlGroup=\n")
        runtime.launch({"id":"a"*64,"executorId":"node","args":{"command":"true","cwd":"/workspace","timeoutMs":1000}})
        self.assertIn("--property=OOMPolicy=kill",calls[0])
        self.assertIn("--property=BindsTo=okami-executor@node.service",calls[0])
        self.assertNotIn("--property=MemoryOOMGroup=true",calls[0])
        result=runtime.inspect("a"*64)
        self.assertEqual(result["status"],"failed")
        self.assertTrue(result["cleanupConfirmed"])

    def test_cgroup_escapes_include_ssh_cron_user_manager_without_killing_them(self):
        sessions=module(self,"user_session")
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);home=base/"home";workspace=home/"workspace"
            workspace.mkdir(parents=True,mode=0o700);home.chmod(0o700)
            for pid,cgroup in [(41,"/user.slice/user-1003.slice/session.scope"),(42,"/okami.slice/okami-bots.slice/okami-bots-u1003.slice/okami-job.service")]:
                directory=base/"proc"/str(pid);directory.mkdir(parents=True)
                (directory/"status").write_text("Uid:\t1003\t1003\t1003\t1003\n")
                (directory/"cgroup").write_text("0::"+cgroup+"\n")
            session=sessions.UserSession({"node":{"uid":1003,"gid":1004,"user":"okami-bot","home":str(home),"workspace":str(workspace),"trustMode":"full-trust"}},runner=lambda argv:"")
            result=session.preflight("node",proc_root=base/"proc")
            self.assertEqual(result["escapePids"],[41])
            self.assertEqual(result["state"],"unavailable")

    def test_full_trust_preserves_existing_rdp_and_charges_unmanaged_memory(self):
        native=module(self,"user_session");runtime=module(self,"job_runtime")
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);home=base/"home";workspace=home/"workspace"
            workspace.mkdir(parents=True,mode=0o700);home.chmod(0o700)
            uid=max(1000,os.getuid());gid=max(1000,os.getgid())
            account={"uid":uid,"gid":gid,"user":"okami-bot","home":str(home),"workspace":str(workspace),"trustMode":"full-trust"}
            if os.getuid()==0:
                os.chown(home,uid,gid);os.chown(workspace,uid,gid)
            process=base/"proc"/"41";process.mkdir(parents=True)
            (process/"status").write_text(f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nVmRSS:\t3145728 kB\n")
            (process/"cgroup").write_text("0::/user.slice/user-1003.slice/session-rdp.scope\n")
            (process/"smaps_rollup").write_text("Pss:\t2097152 kB\n")
            calls=[];session=native.UserSession({"node":account},runner=lambda argv:calls.append(argv) or "")
            with patch.object(native.pwd,"getpwnam",return_value=SimpleNamespace(pw_uid=uid,pw_gid=gid,pw_dir=str(home))), patch.object(native.os,"getgrouplist",return_value=[gid]), patch.object(native.grp,"getgrgid",return_value=SimpleNamespace(gr_name="bot")):
                result=session.preflight("node",proc_root=base/"proc")
            self.assertEqual(result["state"],"ready")
            self.assertEqual(result["escapePids"],[41]);self.assertFalse(result["containmentGuaranteed"])
            self.assertIn("outside",result["limitation"]);self.assertEqual(calls,[])
            measured=runtime.unmanaged_memory([account],base/"proc")
            self.assertEqual(measured,2*1024**3)
            budget=runtime.HostBudget(16*1024**3,3*1024**3)
            with self.assertRaisesRegex(ValueError,"RAM|memory"):
                budget.admit("job",12*1024**3,memory_available_bytes=16*1024**3,unmanaged_bytes=measured)

    def test_deployment_renderer_calibrates_shared_slice_and_keeps_supervisor_outside(self):
        deployment=module(self,"deployment")
        units=deployment.render_units({"node":{"uid":1003,"gid":1004,"user":"okami-bot",
            "home":"/home/okami-bot","workspace":"/home/okami-bot/workspace","trustMode":"full-trust"}},16*1024**3,3*1024**3)
        self.assertEqual(units["okami-bots.slice"]["Slice"]["MemoryMax"],str(13*1024**3))
        self.assertEqual(units["okami-session@node.service"]["Service"]["Slice"],"okami-bots-u1003.slice")
        self.assertEqual(units["okami-executor@node.service"]["Service"]["Slice"],"system.slice")
        self.assertEqual(units["okami-bots-u1003.slice"]["Slice"]["MemoryMax"],"infinity")
        self.assertEqual(units["okami-executor@node.service"]["Service"]["ExecStopPost"],
            "/usr/bin/python3 -m executor.admin_helper contain-executor node")

    def test_account_plan_preserves_existing_native_identity_groups_permissions_and_sessions(self):
        from types import SimpleNamespace
        from deployment.users.provision import account_plan
        account={"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot",
            "workspace":"/home/okami-bot/workspace","trustMode":"full-trust"}
        users=SimpleNamespace(getpwnam=lambda _:SimpleNamespace(pw_uid=1003,pw_gid=1004,pw_dir=account["home"]))
        plan=account_plan(account,users=users)
        self.assertEqual(plan["commands"],[])
        self.assertTrue(plan["preserveExistingGroupsAndSudo"]);self.assertTrue(plan["preserveExistingSessions"])
        native=module(self,"user_session")
        for user in ("marcos","astrid","astride","root"):
            with self.assertRaisesRegex(ValueError,"Personal"):
                native.UserSession({"node":{**account,"user":user}})
        users.getpwnam=lambda _:SimpleNamespace(pw_uid=1004,pw_gid=1004,pw_dir=account["home"])
        with self.assertRaisesRegex(ValueError,"match"):
            account_plan(account,users=users)

    def test_initial_handshake_does_not_thaw_an_absent_registered_session(self):
        calls=[]
        helper=module(self,"admin_helper").AdminHelper({"node":{"uid":1003,"gid":1004,"user":"okami-bot",
            "home":"/home/okami-bot","workspace":"/home/okami-bot/workspace","trustMode":"full-trust"}},
            runner=lambda argv:calls.append(argv) or "LoadState=not-found\nActiveState=inactive\n")
        self.assertTrue(helper.resume_session("node"))
        self.assertEqual(len(calls),1);self.assertEqual(calls[0][1],"show")
    def test_aggregate_budget_allows_above_eight_gib_frozen_job_stays_counted(self):
        runtime = module(self, "job_runtime")
        budget = runtime.HostBudget(16 * 1024**3, reserve_bytes=3 * 1024**3)
        budget.admit("job-a", 9 * 1024**3, heavy=True, memory_available_bytes=12 * 1024**3)
        budget.freeze("job-a")
        self.assertEqual(budget.reserved_bytes, 9 * 1024**3)
        with self.assertRaisesRegex(ValueError, "heavy"):
            budget.admit("job-b", 1024**3, heavy=True, memory_available_bytes=12 * 1024**3)
        budget.release("job-a")
        budget.admit("job-b", 1024**3, heavy=True, memory_available_bytes=12 * 1024**3)
        with self.assertRaisesRegex(ValueError, "RAM|memory"):
            budget.admit("job-c", 9 * 1024**3, memory_available_bytes=4 * 1024**3)

    def test_managed_desktop_memory_is_reserved_alongside_job_peaks(self):
        runtime=module(self,"job_runtime")
        budget=runtime.HostBudget(16*1024**3,3*1024**3)
        budget.admit("job-a",9*1024**3,heavy=True,memory_available_bytes=16*1024**3,managed_session_bytes=3*1024**3)
        with self.assertRaisesRegex(ValueError,"RAM|memory"):
            budget.admit("small-job",2*1024**3,memory_available_bytes=16*1024**3,managed_session_bytes=3*1024**3)
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);group=base/"okami.slice"/"okami-bots.slice"
            session=group/"okami-bots-u1003.slice";session.mkdir(parents=True)
            (group/"memory.current").write_text(str(6*1024**3));(group/"memory.high").write_text(str(12*1024**3))
            (group/"memory.max").write_text(str(13*1024**3));(group/"memory.pressure").write_text("some avg10=0.00")
            job=session/("okami-job-"+"a"*64+".service");job.mkdir();(job/"memory.current").write_text(str(4*1024**3))
            meminfo=base/"meminfo";meminfo.write_text("MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\n")
            with patch.object(runtime,"unmanaged_memory",return_value=0):
                snapshot=runtime.host_snapshot("lenovo",cgroup_root=base,meminfo_path=meminfo,accounts=[{"uid":1003}])
            self.assertEqual(snapshot["managedSessionBytes"],2*1024**3)
    def test_host_safety_budget_is_shared_across_native_supervisors_and_restarts(self):
        native=module(self,"job_runtime")
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"budget.sqlite"
            first=native.HostBudget(16*1024**3,3*1024**3,state_path=path)
            second=native.HostBudget(16*1024**3,3*1024**3,state_path=path)
            self.addCleanup(second.close)
            first.admit("account-a",9*1024**3,heavy=True,memory_available_bytes=12*1024**3)
            first.freeze("account-a");first.close()
            with self.assertRaisesRegex(ValueError,"heavy"):
                second.admit("account-b",1024**3,heavy=True,memory_available_bytes=12*1024**3)
            self.assertEqual(second.reserved_bytes,9*1024**3)
            second.release("account-a")
            second.admit("account-b",1024**3,heavy=True,memory_available_bytes=12*1024**3)

    def test_registered_user_fixed_units_job_cancel_does_not_sweep_uid(self):
        sessions = module(self, "user_session")
        calls = []
        session = sessions.UserSession({"lenovo-okami": {"uid": 1003, "gid": 1004,
            "user": "okami-bot", "workspace": "/home/okami-bot/workspace",
            "home": "/home/okami-bot", "trustMode": "full-trust"}},
            runner=lambda argv: calls.append(argv) or "")
        session.start("lenovo-okami")
        with self.assertRaises(ValueError):
            session.start("marcos")
        runtime = module(self, "job_runtime").JobRuntime(session, runner=lambda argv: calls.append(argv) or "")
        operation = {"id": "d" * 64, "executorId": "lenovo-okami", "args": {
            "command": "printf ok", "cwd": "/workspace", "timeoutMs": 1000}}
        runtime.launch(operation)
        unit = runtime.unit(operation["id"])
        self.assertIn("--property=User=okami-bot", calls[-1])
        self.assertIn("--slice=okami-bots-u1003.slice", calls[-1])
        runtime.cancel(operation["id"])
        self.assertEqual(calls[-1], ["systemctl", "stop", unit])
        self.assertNotIn("killall", " ".join(" ".join(call) for call in calls))

    def test_uid_firewall_ipv4_ipv6_dns_proxy_and_full_trust_diagnostics(self):
        admin = module(self, "admin_helper")
        policy = admin.NetworkPolicy(1003, dns=["1.1.1.1"], exceptions=[{"address":"8.8.4.4", "port":443}])
        for address in ["127.0.0.1", "10.0.0.1", "100.91.96.14", "169.254.169.254", "::1", "fd00::1", "fe80::1", "224.0.0.1"]:
            self.assertFalse(policy.permits(address, 443), address)
        self.assertTrue(policy.permits("1.1.1.1", 53))
        self.assertFalse(policy.permits("1.1.1.1", 443))
        self.assertTrue(policy.permits("8.8.4.4", 443))
        self.assertTrue(policy.permits("2606:4700:4700::1111", 443))
        self.assertFalse(policy.permits("2606:4700:4700::1111", 53))
        self.assertFalse(policy.permits("8.8.4.4", 443, gate_open=False))
        calls = []
        helper = admin.AdminHelper({"lenovo-okami": {"uid":1003, "gid":1004, "user":"okami-bot",
            "home":"/home/okami-bot", "workspace":"/home/okami-bot/workspace", "trustMode":"full-trust"}},
            catalog={"editor": [["/usr/bin/true"]]}, runner=lambda argv: calls.append(argv) or "")
        helper.ensure_app("editor")
        self.assertEqual(calls, [["/usr/bin/true"]])
        for app in ["bash -c bad", "https://arbitrary/package", "not-registered"]:
            with self.assertRaises(ValueError):
                helper.ensure_app(app)

    def test_firewall_containment_rejects_a_missing_uid_chain_or_gate_hook(self):
        admin=module(self,"admin_helper")
        registry={"node":{"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot",
            "workspace":"/home/okami-bot/workspace","trustMode":"full-trust","network":{"dns":["1.1.1.1"],"administrativeRepliesVerified":True}}}
        expected=admin.ruleset([admin.NetworkPolicy(1003,["1.1.1.1"])])
        observed=[expected]
        def runner(argv):
            if argv[:4]==["nft","-n","list","table"]:return observed[0]
            return json.dumps({"nftables":[{"set":{"elem":[1003]}}]})
        helper=admin.AdminHelper(registry,runner=runner)
        self.assertTrue(helper.gate("node",True))
        observed[0]=expected.replace("meta skuid @closed_uids reject","")
        with self.assertRaisesRegex(ValueError,"policy|firewall"):
            helper.gate("node",True)
        observed[0]=expected.replace("meta skuid 1003 jump uid_1003","")
        with self.assertRaisesRegex(ValueError,"policy|firewall"):
            helper.preflight("node")

    def test_fixed_rdp_reply_catalog_preserves_admin_without_allowing_old_bot_sockets(self):
        admin=module(self,"admin_helper")
        policy=admin.NetworkPolicy(1003,["1.1.1.1"],admin_replies=[{"address":"100.113.59.40","sourcePort":3390}])
        self.assertTrue(policy.permits("100.113.59.40",49152,gate_open=False,source_port=3390,direction="reply",state="established"))
        for patch in [{"direction":"original"},{"state":"new"},{"source_port":443}]:
            args={"gate_open":False,"source_port":3390,"direction":"reply","state":"established",**patch}
            self.assertFalse(policy.permits("100.113.59.40",49152,**args))
        self.assertFalse(policy.permits("100.91.96.14",49152,gate_open=False,source_port=3390,direction="reply",state="established"))
        self.assertFalse(policy.permits("8.8.4.4",443,gate_open=False,source_port=49152,state="established"))
        rendered=admin.ruleset([policy])
        self.assertLess(rendered.index("tcp sport 3390 ct direction reply"),rendered.index("meta skuid @closed_uids reject"))
        self.assertIn("priority 100",rendered)
        self.assertNotIn("ct state established,related",rendered)
        calls=[]
        helper=admin.AdminHelper({"node":{"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot","workspace":"/home/okami-bot/workspace","trustMode":"full-trust","network":{"dns":["1.1.1.1"]}}},runner=lambda argv:calls.append(argv) or "")
        with self.assertRaisesRegex(ValueError,"verified"):
            helper.gate("node",True)
        self.assertEqual(calls,[])


from executor.test_corrections import CorrectionContracts


if __name__ == "__main__":
    unittest.main()
