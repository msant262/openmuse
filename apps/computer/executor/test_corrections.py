"""Review regressions use real files/SQLite and complete service replies."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from .files import Workspace, LIMIT, digest
from .supervisor import Journal, Supervisor
from .job_runtime import HostBudget, JobRuntime


class CorrectionContracts(unittest.TestCase):
    def test_completed_command_is_published_before_the_next_idle_long_poll(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);workspace=Workspace(root/"workspace",root/"state")
            self.addCleanup(workspace.close)
            calls=[]
            def request(route,body):
                calls.append((route,body))
                if route=="claim":
                    return {"pause":{"paused":False,"revision":0},"operations":[]}
                return {"sequence":body.get("sequence",1)}
            supervisor,_=self.supervisor(root,workspace,transport=SimpleNamespace(request=request))
            operation=self.operation("finished-command","command",{"command":"python compute.py"})
            supervisor.journal.receive(operation)
            supervisor.journal.receipt(operation["id"],{"status":"running"})
            active={operation["id"]:operation}
            supervisor.runtime=SimpleNamespace(active=active,
                inspect=lambda _: {"status":"failed","exitCode":1,"cleanupConfirmed":True},
                output=lambda _: {"stderr":"KeyError: 'top'"},
                release=lambda id:active.pop(id))
            supervisor.tick()
            completed=[i for i,(route,body) in enumerate(calls)
                if route=="receipt" and body["receipt"]["status"]=="failed"]
            claim=next(i for i,(route,_) in enumerate(calls) if route=="claim")
            self.assertEqual(len(completed),1)
            self.assertLess(completed[0],claim)
            self.assertEqual(calls[claim][1]["waitMs"],15000)
            self.assertEqual(active,{})

    def test_a_running_command_is_polled_without_the_idle_queue_delay(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);workspace=Workspace(root/"workspace",root/"state")
            self.addCleanup(workspace.close)
            calls=[]
            def request(route,body):
                calls.append((route,body))
                if route=="claim":return {"pause":{"paused":False,"revision":0},"operations":[]}
                return {"sequence":body.get("sequence",1)}
            supervisor,_=self.supervisor(root,workspace,transport=SimpleNamespace(request=request))
            operation=self.operation("running-command","command",{"command":"python compute.py"})
            supervisor.journal.receive(operation)
            supervisor.journal.receipt(operation["id"],{"status":"running"})
            supervisor.runtime=SimpleNamespace(active={operation["id"]:operation},
                inspect=lambda _: {"status":"running"})
            supervisor.tick()
            claim=next(body for route,body in calls if route=="claim")
            self.assertEqual(claim["waitMs"],1000)
            self.assertEqual(supervisor.journal.get(operation["id"])["receipt"]["status"],"running")

    def operation(self, operation_id, kind="file", args=None, executor_id="node"):
        return {"id":operation_id,"executorId":executor_id,"kind":kind,"args":args or {},
                "taskId":"task","bindingHash":hashlib.sha256(operation_id.encode()).hexdigest(),
                "executorEpoch":1,"resourceFence":1,"resourceKey":"file:node:note",
                "expiresAt":"2999-01-01T00:00:00Z","createdAt":"2026-10-02T00:00:00Z",
                "capability":"files","capabilityVersion":1,"inspection":False,"revision":0}

    def supervisor(self, root, workspace, journal=None, budget=None, executor_id="node", transport=None):
        account={"trustMode":"full-trust","uid":1003,"gid":1004,"user":"okami-bot",
                 "home":str(root),"workspace":str(getattr(workspace,"root",root/"workspace"))}
        sessions=SimpleNamespace(account=lambda _:account,registry={executor_id:account},preflight=lambda _:{"state":"ready"},
                                 slice=lambda _:"okami-bots-u1003.slice")
        runtime=JobRuntime(sessions,runner=lambda _:"LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nControlGroup=\n",cgroup_root=root/"cgroups")
        helper=SimpleNamespace(gate=lambda *_:True,contain_account=lambda _:True,contain_session=lambda _:True)
        journal=journal or Journal(root/(executor_id+"-journal.sqlite"));self.addCleanup(journal.close)
        budget=budget or HostBudget(16*1024**3);self.addCleanup(budget.close)
        now=[100.0]
        supervisor=Supervisor({"executorId":executor_id,"hostId":"lenovo"},sessions,runtime,workspace,journal,
            transport or SimpleNamespace(request=lambda route,body:{"sequence":body.get("sequence",1)}),helper,
            clock=lambda:now[0],resource_snapshot=lambda _:{"memoryTotalBytes":16*1024**3,"memoryAvailableBytes":12*1024**3,"botsMaxBytes":12*1024**3},budget=budget)
        supervisor.gate.handshake(1,{"paused":False,"revision":0},40);supervisor.gate.reconciled()
        return supervisor,now

    def test_trash_preserves_oversized_nonregular_and_quota_failure_replacements(self):
        for replacement in ("oversized","symlink","directory","full-recovery"):
            with self.subTest(replacement=replacement),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);workspace=Workspace(root/"workspace",root/"state")
                with contextlib.closing(workspace):
                    artifact=workspace.write("/workspace/note.bin",b"original")
                    real_rename=os.rename
                    human=b"human replacement"+(b"x"*(LIMIT+1) if replacement=="oversized" else b"")
                    def race(src,dst,*args,**kwargs):
                        if src=="note.bin" and dst.startswith(".okami-trash-"):
                            target=workspace.root/"note.bin";target.unlink()
                            if replacement=="symlink":
                                (root/"outside").write_bytes(human);target.symlink_to(root/"outside")
                            elif replacement=="directory":
                                target.mkdir();(target/"human.txt").write_bytes(human)
                            else:target.write_bytes(human)
                            result=real_rename(src,dst,*args,**kwargs)
                            if replacement=="full-recovery":
                                target.write_bytes(b"later human edit");workspace.max_version_bytes=0
                            return result
                        return real_rename(src,dst,*args,**kwargs)
                    with patch("executor.files.os.rename",race),self.assertRaises((ValueError,OSError)):
                        workspace.trash(artifact["artifactId"],artifact["version"],"task")
                    entries=list(workspace.root.iterdir())
                    displaced=[entry for entry in entries if entry.name=="note.bin" or entry.name.startswith(".okami-trash-")]
                    self.assertTrue(displaced,"verification failure must preserve the displaced inode")
                    if replacement=="symlink":self.assertTrue(any(entry.is_symlink() for entry in displaced))
                    elif replacement=="directory":self.assertTrue(any(entry.is_dir() and (entry/"human.txt").read_bytes()==human for entry in displaced))
                    else:self.assertTrue(any(entry.is_file() and entry.read_bytes()==human for entry in displaced))
                    self.assertEqual(workspace.versions(artifact["artifactId"])[0]["size"],len(b"original"))

    def test_restore_and_trash_stop_after_pause_or_watchdog_during_capture(self):
        for action in ("restore","trash"):
            for closure in ("pause","watchdog"):
                with self.subTest(action=action,closure=closure),tempfile.TemporaryDirectory() as temp:
                    root=Path(temp);workspace=Workspace(root/"workspace",root/"state");self.addCleanup(workspace.close)
                    first=workspace.write("/workspace/note.txt",b"original")
                    changed=workspace.write("/workspace/note.txt",b"bad",expected_version=first["version"])
                    original=workspace.versions(first["artifactId"])[0]
                    supervisor,now=self.supervisor(root,workspace)
                    capture=workspace.capture_at;acks=[]
                    def capture_then_close(*args,**kwargs):
                        saved=capture(*args,**kwargs)
                        if closure=="pause":acks.append(supervisor.gate.pause({"paused":True,"revision":1}))
                        else:now[0]+=41;supervisor.gate.watchdog()
                        return saved
                    workspace.capture_at=capture_then_close
                    args={"operation":"restore","versionId":original["id"],"expectedCurrentVersion":changed["version"]} if action=="restore" else {"operation":"trash","artifactId":changed["artifactId"],"expectedVersion":changed["version"]}
                    operation=self.operation("recovery-race","file-version",args)
                    supervisor.perform(operation)
                    self.assertEqual(workspace.read("/workspace/note.txt"),b"bad")
                    self.assertEqual(supervisor.journal.get(operation["id"])["receipt"]["status"],"outcome_unknown")
                    if closure=="pause":self.assertTrue(acks[0]["contained"])
                    self.assertFalse(supervisor.gate.open)

    def test_containment_ack_waits_for_the_local_destructive_safe_point(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);workspace=Workspace(root/"workspace",root/"state");self.addCleanup(workspace.close)
            artifact=workspace.write("/workspace/note.txt",b"original")
            supervisor,_=self.supervisor(root,workspace);acks=[];real_rename=os.rename
            def pause_at_rename(src,dst,*args,**kwargs):
                if src=="note.txt" and dst.startswith(".okami-trash-"):
                    acks.append(supervisor.gate.pause({"paused":True,"revision":1}))
                return real_rename(src,dst,*args,**kwargs)
            with patch("executor.files.os.rename",pause_at_rename):
                supervisor.perform(self.operation("trash-safe-point","file-version",{"operation":"trash","artifactId":artifact["artifactId"],"expectedVersion":artifact["version"]}))
            self.assertFalse(acks[0]["contained"],"the supervisor mutator is not frozen with the managed UID")
            self.assertTrue(supervisor.gate.pause({"paused":True,"revision":1})["contained"])
            self.assertEqual(workspace.read("/workspace/note.txt"),b"original")

    def test_conflicted_publication_survives_restart_without_blocking_inspection_or_unrelated_work(self):
        for change in ("edit","delete"):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);workspace=Workspace(root/"workspace",root/"state");self.addCleanup(workspace.close)
                artifact=workspace.write("/workspace/note.txt",b"agent")
                calls=[]
                inspection=self.operation("inspect-current",args={"operation":"stat" if change=="edit" else "list","path":"/workspace/note.txt" if change=="edit" else "/workspace"});inspection["inspection"]=True
                unrelated=self.operation("unrelated",args={"operation":"write","path":"/workspace/other.txt","text":"unrelated"})
                queued=[inspection,unrelated]
                def transport(route,body):
                    calls.append(route)
                    if route=="claim":return {"pause":{"paused":False,"revision":0},"operations":[queued.pop(0)] if queued else []}
                    if route=="artifact":return {key:body[key] for key in ("artifactId","version","sha256","generation","versionId")}
                    return {"sequence":body.get("sequence",1)}
                supervisor,_=self.supervisor(root,workspace,transport=SimpleNamespace(request=transport))
                if change=="edit":(workspace.root/"note.txt").write_bytes(b"human edit")
                else:(workspace.root/"note.txt").unlink()
                for _ in range(3):supervisor.tick()
                self.assertEqual(calls.count("claim"),3)
                self.assertEqual(workspace.read("/workspace/other.txt"),b"unrelated")
                conflicts=workspace.publication_conflicts()
                self.assertEqual(len(conflicts),1);self.assertEqual(conflicts[0]["sha256"],artifact["sha256"])
                self.assertFalse(supervisor.gate.needs_reconciliation)
                self.assertEqual(supervisor.journal.get("inspect-current")["receipt"]["status"],"succeeded")
                reopened=Workspace(workspace.root,workspace.state_root);self.addCleanup(reopened.close)
                self.assertEqual(reopened.publication_conflicts(),conflicts)
                self.assertEqual(supervisor.readiness()["publicationConflicts"],conflicts)

    def test_conflict_backlog_drains_only_after_durable_bound_ack(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            workspace=Workspace(root/"workspace",root/"state")
            for index in range(101):
                artifact=workspace.write("/workspace/f%03d.txt"%index,b"agent")
                (workspace.root/("f%03d.txt"%index)).write_bytes(b"human edit")
                workspace.publication_conflict(artifact,ValueError("Origin changed"))
            first=workspace.publication_conflicts()
            self.assertEqual(len(first),100)
            self.assertEqual(first[0]["path"],"/workspace/f000.txt")
            workspace.close()
            with contextlib.closing(Workspace(root/"workspace",root/"state")) as reopened:
                self.assertEqual(reopened.publication_conflicts(),first,"lost response must replay same batch")
                forged={**first[0],"sha256":"0"*64}
                reopened.acknowledge_publication_conflicts([forged])
                self.assertEqual(reopened.publication_conflicts(),first)
                reopened.acknowledge_publication_conflicts(first)
                last=reopened.publication_conflicts()
                self.assertEqual([c["path"] for c in last],["/workspace/f100.txt"])
                reopened.acknowledge_publication_conflicts(first)
                self.assertEqual(reopened.publication_conflicts(),last)
                def transport(route,body):
                    self.assertEqual(route,"heartbeat")
                    self.assertEqual(body["readiness"]["publicationConflicts"],last)
                    return {"epoch":1,"pause":{"paused":False,"revision":0},"watchdogMs":40000,
                            "publicationConflictAcks":body["readiness"]["publicationConflicts"]}
                supervisor,_=self.supervisor(root,reopened,transport=SimpleNamespace(request=transport))
                with patch.object(supervisor.stop_event,"wait",side_effect=[False,True]):
                    supervisor.heartbeat()
                self.assertEqual(reopened.publication_conflicts(),[])
                self.assertEqual(reopened.pending_publications(),[],"ACK must retain conflict and never retry stale bytes")
                self.assertEqual(reopened.db.execute("SELECT COUNT(*) FROM publication_conflicts").fetchone()[0],101)
            with contextlib.closing(Workspace(root/"workspace",root/"state")) as reopened:
                self.assertEqual(reopened.publication_conflicts(),[])
                self.assertEqual(reopened.pending_publications(),[])

    def test_actual_absent_unit_defaults_never_count_as_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);supervisor,_=self.supervisor(root,SimpleNamespace())
            operation=self.operation("okami-m6-unexecuted-proof","command",{"command":"true"})
            runtime=supervisor.runtime
            actual=subprocess.run(["systemctl","show",runtime.unit(operation["id"]),"--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ControlGroup"],text=True,capture_output=True,check=True).stdout
            self.assertIn("LoadState=not-found",actual)
            runtime.runner=lambda _:actual;runtime.adopt(operation)
            receipt=runtime.inspect(operation["id"])
            self.assertEqual(receipt["status"],"outcome_unknown")
            self.assertTrue(receipt["cleanupConfirmed"]);self.assertNotIn("exitCode",receipt)

    def test_retained_exit_result_is_collected_before_unit_release(self):
        replies={
            "success":"LoadState=loaded\nActiveState=active\nSubState=exited\nResult=success\nExecMainCode=1\nExecMainStatus=0\nExecMainStartTimestampMonotonic=1\nExecMainExitTimestampMonotonic=2\nControlGroup=\n",
            "nonzero":"LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=exit-code\nExecMainCode=1\nExecMainStatus=7\nExecMainStartTimestampMonotonic=1\nExecMainExitTimestampMonotonic=2\nControlGroup=\n",
            "never-started":"LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainCode=0\nExecMainStatus=0\nExecMainStartTimestampMonotonic=0\nExecMainExitTimestampMonotonic=0\nControlGroup=\n"}
        for name,reply in replies.items():
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);supervisor,_=self.supervisor(root,SimpleNamespace());calls=[]
                runtime=supervisor.runtime;runtime.runner=lambda argv:calls.append(argv) or reply
                operation=self.operation("retained-"+name,"command",{"command":"true","timeoutMs":1000})
                runtime.launch(operation)
                self.assertIn("--property=RemainAfterExit=yes",calls[0]);self.assertIn("--property=Type=exec",calls[0])
                receipt=runtime.inspect(operation["id"])
                self.assertEqual(receipt["status"],"succeeded" if name=="success" else "failed" if name=="nonzero" else "outcome_unknown")
                self.assertTrue(receipt["cleanupConfirmed"])
                supervisor.journal.receive(operation);supervisor.journal.receipt(operation["id"],{"status":receipt["status"],"data":receipt})
                runtime.release(operation["id"])
                self.assertTrue(any(argv[:2]==["systemctl","stop"] for argv in calls))
                self.assertEqual(supervisor.journal.get(operation["id"])["receipt"]["data"],receipt)

    def test_terminal_budget_handoff_recovers_without_releasing_other_or_unresolved_reservations(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/"host-budget.sqlite"
            budget=HostBudget(16*1024**3,state_path=path)
            for operation_id,heavy in (("finished",True),("unfinished",False),("other-node",False)):
                budget.admit(operation_id,1024**3,heavy,12*1024**3)
            journal=Journal(root/"node-journal.sqlite")
            finished={**self.operation("finished","command",{"command":"true"}),"resourceBudget":{"memoryBytes":1024**3,"heavy":True}}
            journal.receive(finished);terminal=journal.receipt("finished",{"status":"succeeded","data":{"cleanupConfirmed":True}})
            journal.acknowledge("finished",terminal["sequence"])
            unfinished={**finished,"id":"unfinished","bindingHash":"b"*64,"resourceBudget":{"memoryBytes":1024**3,"heavy":False}}
            journal.receive(unfinished);journal.receipt("unfinished",{"status":"outcome_unknown","data":{"cleanupConfirmed":False}})
            journal.close();budget.close()
            other_budget=HostBudget(16*1024**3,state_path=path);other_journal=Journal(root/"other-journal.sqlite")
            other={**unfinished,"id":"other-node","executorId":"other","bindingHash":"c"*64}
            other_journal.receive(other);other_journal.receipt("other-node",{"status":"running"})
            other_supervisor,_=self.supervisor(root,SimpleNamespace(),journal=other_journal,budget=other_budget,executor_id="other")
            budget=HostBudget(16*1024**3,state_path=path);journal=Journal(root/"node-journal.sqlite")
            supervisor,_=self.supervisor(root,SimpleNamespace(),journal=journal,budget=budget)
            self.assertNotIn("finished",budget.jobs)
            self.assertNotIn("finished",supervisor.runtime.active)
            self.assertIn("unfinished",budget.jobs);self.assertIn("other-node",budget.jobs)
            self.assertTrue(budget.jobs["unfinished"]["frozen"])
            self.assertEqual(budget.jobs["unfinished"]["executorId"],"node")
            self.assertEqual(budget.jobs["other-node"]["executorId"],"other")
            self.assertIn("other-node",other_supervisor.runtime.active)
            budget.admit("next-heavy",1024**3,True,12*1024**3,executor_id="node")
            self.assertEqual(other_budget.heavy_owner,"next-heavy")

    def test_owned_terminal_cleanup_cannot_release_a_foreign_budget_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);budget=HostBudget(16*1024**3,state_path=root/"host-budget.sqlite")
            budget.admit("collision",1024**3,True,12*1024**3,executor_id="other")
            journal=Journal(root/"node-journal.sqlite")
            operation={**self.operation("collision","command",{"command":"true"}),"resourceBudget":{"memoryBytes":1024**3,"heavy":True}}
            journal.receive(operation);journal.receipt("collision",{"status":"succeeded","data":{"cleanupConfirmed":True}})
            with self.assertRaisesRegex(ValueError,"another executor"):
                self.supervisor(root,SimpleNamespace(),journal=journal,budget=budget)
            self.assertEqual(budget.heavy_owner,"collision")
            self.assertEqual(budget.jobs["collision"]["executorId"],"other")
