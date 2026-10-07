"""Host control is injected; real files/GNU tar. Actual age/Bao proofs run separately."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import backup_receive
import hybrid_backup
import install_native
import verify_hybrid
from test_deployment_backup import FakeDeployment


class FakeHybrid(hybrid_backup.HybridBackup,FakeDeployment):
    def __init__(self,directory):
        FakeDeployment.__init__(self,directory)
        self.mode="hybrid-vps";self.roots=hybrid_backup.VPS_ROOTS
        self.config={"recipient":"age1"+"q"*58,"requirePeerSnapshot":False}
        self.restore_directory=Path(directory)/"isolated"
        self.busy=False;self.encryption_failure=False;self.peer_failure=False
        self.states["openbao"]={"Id":"openbao","Config":{"Image":"openbao/openbao:2.7.1"},
            "State":{"Running":True,"Status":"running","ExitCode":0},
            "Mounts":[{"Type":"volume","Name":"vault","Destination":"/openbao/data"}]}
        (self.secrets/"openbao-unseal.key").write_bytes(b"SEAL-KEY-NOT-IN-ARCHIVE".ljust(32,b"x"))
        (self.secrets/"openbao-unseal.key").chmod(0o440)
        (self.secrets/"native-executors.json").write_text('{"owner":"fixture"}')
        (self.secrets/"native-executors.json").chmod(0o600)
    run=FakeDeployment.run
    def preflight(self):
        if self.busy:raise ValueError("Backup deferred")
        return {"revision":7,"paused":True}
    def peer_snapshot(self,batch):
        if self.peer_failure:raise RuntimeError("Peer snapshot unavailable")
        return True
    def raft_snapshot(self,context,target):target.write_bytes(b"fixture raft snapshot");target.chmod(0o600)
    def encrypt(self,source,target):
        if self.encryption_failure:raise ValueError("Encryption failed")
        # Control-only fixture; the separate real-tool tests prove encryption.
        target.write_bytes(b"age-encryption.org/v1\n"+source.read_bytes());target.chmod(0o600)
    def resume(self,context):hybrid_backup.HybridBackup.resume(self,context)


class HybridBackupContracts(unittest.TestCase):
    def test_raft_tmpfs_snapshot_stream_is_private_and_failed_copy_still_cleans_up(self):
        for failed_read in (False,True):
            with tempfile.TemporaryDirectory() as directory:
                backup=FakeHybrid(directory)
                token=Path(directory)/"snapshot-token";token.write_text("fixture-secret-token");token.chmod(0o600)
                backup.config["vaultBackupTokenFile"]=str(token)
                target=Path(directory)/"snapshot";namespace={};cleaned=[]
                def run(argv,**kwargs):
                    self.assertNotIn("fixture-secret-token"," ".join(argv))
                    if argv[:2]==["docker","cp"]:
                        raise subprocess.CalledProcessError(1,argv,stderr=b"tmpfs not visible to archive API")
                    if "sh" in argv:
                        self.assertEqual(kwargs["input"],b"fixture-secret-token\n")
                        namespace[argv[-1].split()[-1]]=b"private raft snapshot bytes"
                    elif "cat" in argv:
                        self.assertEqual(target.stat().st_mode & 0o777,0o600)
                        kwargs["stdout"].write(namespace[argv[-1]])
                        if failed_read:raise subprocess.CalledProcessError(1,argv)
                    elif "rm" in argv:
                        cleaned.append(namespace.pop(argv[-1]))
                    else:self.fail("Unexpected snapshot command")
                backup.run=run
                if failed_read:
                    with self.assertRaises(subprocess.CalledProcessError):
                        hybrid_backup.HybridBackup.raft_snapshot(backup,{},target)
                else:
                    hybrid_backup.HybridBackup.raft_snapshot(backup,{},target)
                    self.assertEqual(target.read_bytes(),b"private raft snapshot bytes")
                self.assertEqual(cleaned,[b"private raft snapshot bytes"])
                self.assertEqual(namespace,{})

    def test_native_frozen_writers_stop_under_closed_gate_and_resume_paused(self):
        for fail_stop in (False,True):
            backup=object.__new__(hybrid_backup.HybridBackup)
            backup.mode="native";backup.config={"executorId":"fixture"}
            backup.units=["okami-executor@fixture.service","okami-session@fixture.service"]
            calls=[];frozen={"account":True,"session":True};active={unit:True for unit in backup.units}
            def action(name,value):
                calls.append(name)
                if name=="thaw-account":frozen["account"]=False
                if name=="thaw-session":frozen["session"]=False
                if name=="freeze-account":frozen["account"]=True
                if name=="freeze-session":frozen["session"]=True
                return True
            backup.native_admin=SimpleNamespace(
                gate=lambda executor,closed:action("close-gate",closed),
                resume_account=lambda executor:action("thaw-account",executor),
                resume_session=lambda executor:action("thaw-session",executor),
                contain_account=lambda executor:action("freeze-account",executor),
                contain_session=lambda executor:action("freeze-session",executor))
            def run(argv,**kwargs):
                verb,unit=argv[1:];calls.append(verb+":"+unit)
                if verb=="stop" and unit==backup.units[1]:
                    if any(frozen.values()) or fail_stop:raise subprocess.CalledProcessError(1,argv)
                if verb=="start" and unit==backup.units[0]:self.assertTrue(all(frozen.values()))
                active[unit]=verb=="start"
            backup.run=run
            backup.output=lambda argv:"ActiveState=inactive\nSubState=dead\nMainPID=0\nResult=success\nExecMainCode=1\nExecMainStatus=0"
            context={"running":list(backup.units)}
            if fail_stop:
                with self.assertRaises(subprocess.CalledProcessError):backup.stop(context)
            else:backup.stop(context)
            backup.resume(context)
            self.assertTrue(all(active.values()));self.assertTrue(all(frozen.values()))
            self.assertEqual(calls[:4],["close-gate","stop:"+backup.units[0],"thaw-account","thaw-session"])
            self.assertEqual(calls[-3:],["freeze-session","freeze-account","start:"+backup.units[0]])

    def test_native_accepts_confirmed_sigterm_but_rejects_kill_oom_core_or_remaining_writer(self):
        backup=object.__new__(hybrid_backup.HybridBackup)
        backup.mode="native";backup.config={"executorId":"fixture"}
        backup.units=["okami-executor@fixture.service","okami-session@fixture.service"]
        backup.native_admin=SimpleNamespace(gate=lambda *args:True,resume_account=lambda *args:None,resume_session=lambda *args:None)
        backup.run=lambda *args,**kwargs:None
        clean={"ActiveState":"inactive","SubState":"dead","MainPID":"0","Result":"success","ExecMainCode":"2","ExecMainStatus":"15"}
        backup.output=lambda argv:"\n".join(key+"="+value for key,value in clean.items())
        backup.stop({"running":backup.units})
        for changes in ({"ExecMainStatus":"9"},{"ExecMainCode":"3"},{"Result":"oom-kill"},
                        {"Result":"timeout"},{"MainPID":"1234"},{"ActiveState":"active"},
                        {"ExecMainCode":"1","ExecMainStatus":"1"}):
            dirty={**clean,**changes}
            backup.output=lambda argv:"\n".join(key+"="+value for key,value in dirty.items())
            with self.assertRaisesRegex(ValueError,"clean stop"):backup.stop({"running":backup.units})

    def test_native_home_links_restore_inside_new_root_without_following_host_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);home=root/"home";home.mkdir()
            (home/"settings").mkdir();(home/"settings/value").write_text("preserved")
            (home/"absolute").symlink_to(home/"settings/value")
            (home/"relative").symlink_to("settings/value")
            external=root/"outside-secret";external.write_text("MUST-NOT-COPY")
            (home/"external").symlink_to(external)
            (home/"snap-link").symlink_to("/snap/gtk-common-themes/current")
            (home/"relative-external").symlink_to("../outside-secret")
            os.mkfifo(home/"runtime-pipe")
            state=root/"native-state";state.mkdir();(state/"receipt").write_text("durable")
            config=root/"native-config";config.mkdir();(config/"private").write_text("scoped")
            staging=root/"staging";staging.mkdir()
            backup=object.__new__(hybrid_backup.HybridBackup)
            backup.mode="native";backup.roots=hybrid_backup.NATIVE_ROOTS
            backup.account={"home":str(home)};backup.config={"nativeState":str(state),"nativeConfig":str(config)}
            archive=backup.archive({},staging,{"format":1})
            target=root/"restored";target.mkdir()
            with tarfile.open(archive,"r:gz") as bundle:
                bundle.extractall(target,filter="data")
            self.assertEqual((target/"home/absolute").read_text(),"preserved")
            self.assertEqual((target/"home/relative").read_text(),"preserved")
            self.assertFalse(os.path.isabs(os.readlink(target/"home/absolute")))
            manifest=json.loads((target/"manifest.json").read_text())
            omitted={row["path"] for row in manifest["omittedNativeEntries"]}
            self.assertEqual(omitted,{"home/external","home/snap-link","home/relative-external","home/runtime-pipe"})
            for path in omitted:self.assertFalse(os.path.lexists(target/path))
            self.assertEqual(external.read_text(),"MUST-NOT-COPY")

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.deployment=FakeHybrid(self.temp.name)
    def test_selective_real_archive_excludes_seal_key_and_preserves_existing_computer(self):
        target=self.deployment.backup(14)
        self.assertEqual(target.stat().st_mode&0o777,0o600)
        self.assertTrue(self.deployment.states["computer"]["State"]["Running"])
        self.assertTrue(self.deployment.states["openbao"]["State"]["Running"])
        self.assertEqual([call[-1] for call in self.deployment.calls if "stop" in call],["server","browser"])
        with tarfile.open(fileobj=io.BytesIO(target.read_bytes().split(b"\n",1)[1]),mode="r:gz") as bundle:
            names=bundle.getnames()
            self.assertIn("vault.snap",names)
            self.assertFalse(any("unseal.key" in name for name in names))
            manifest=json.load(bundle.extractfile("manifest.json"))
            self.assertFalse(manifest["restoreStartsServices"])
            self.assertTrue(manifest["peerSnapshotConfirmed"])
            self.assertEqual(manifest["pause"],{"revision":7,"paused":True})
    def test_busy_and_unreachable_peer_stop_no_writer(self):
        for attr in ("busy","peer_failure"):
            setattr(self.deployment,attr,True)
            with self.assertRaises((ValueError,RuntimeError)):self.deployment.backup(14)
            setattr(self.deployment,attr,False)
        self.assertFalse(any("stop" in call for call in self.deployment.calls))
    def test_encrypt_copy_and_dirty_shutdown_failures_resume_without_completed_copy(self):
        for attr,value in (("encryption_failure",True),("fail_copy",True),("dirty",{"ExitCode":137,"OOMKilled":True})):
            setattr(self.deployment,attr,value)
            if attr=="dirty":
                # FakeDeployment's old computer dirty case is irrelevant; model
                # the actual hybrid browser's dirty receipt explicitly.
                self.deployment.states["browser"]["State"]["ExitCode"]=137
            with self.assertRaises((ValueError,subprocess.SubprocessError)):self.deployment.backup(14)
            self.assertTrue(self.deployment.states["server"]["State"]["Running"])
            self.assertTrue(self.deployment.states["browser"]["State"]["Running"])
            self.assertFalse(list(self.deployment.directory.glob("*.age")))
            setattr(self.deployment,attr,False if attr!="dirty" else None)
            self.deployment.states["browser"]["State"]["ExitCode"]=0


class QuiescenceContracts(unittest.TestCase):
    def fixture(self,paused=False,busy=False):
        service=object.__new__(hybrid_backup.HybridBackup)
        pause={"paused":paused,"revision":11};calls=[];active={"id":None};busy_state={"busy":busy}
        def api(path="/api/deployment/status",body=None):
            calls.append((path,body))
            if path.endswith("maintenance"):
                active["id"]=body["id"] if body["operation"]!="finish" else None
                return {"active":active["id"] is not None}
            if path.endswith("runtime-pause"):
                if body["expectedRevision"]!=pause["revision"]:
                    import urllib.error
                    raise urllib.error.HTTPError("http://fixture",409,"changed",{},None)
                pause.update(paused=body["paused"],revision=pause["revision"]+1);return dict(pause)
            return {"format":1,"readyForStoppedWriterBackup":not busy_state["busy"],"pause":dict(pause),
                "maintenance":{"id":active["id"]}}
        service.api=api
        return service,pause,calls,active,busy_state
    def test_backup_owned_pause_is_cas_restored_and_prior_user_pause_is_preserved(self):
        for already_paused in (False,True):
            service,pause,calls,active,_=self.fixture(already_paused)
            with service.snapshot_window(True,1) as result:self.assertTrue(result["paused"])
            self.assertEqual(pause["paused"],already_paused)
            self.assertIsNone(active["id"])
            self.assertEqual(sum(path.endswith("runtime-pause") for path,_ in calls),0 if already_paused else 2)
    def test_user_pause_revision_after_snapshot_is_never_undone(self):
        service,pause,_,active,_=self.fixture()
        with service.snapshot_window(True,1):pause.update(paused=True,revision=pause["revision"]+1)
        self.assertTrue(pause["paused"]);self.assertIsNone(active["id"])
    def test_native_containment_failure_retains_coordinator_pause_and_stopped_supervisor(self):
        service,pause,calls,active,_=self.fixture()
        native=object.__new__(hybrid_backup.HybridBackup)
        native.mode="native";native.config={"executorId":"fixture"}
        native.units=["okami-executor@fixture.service","okami-session@fixture.service"]
        commands=[]
        native.run=lambda argv,**kwargs:commands.append(argv)
        native.native_admin=SimpleNamespace(contain_session=lambda executor:False,
            contain_account=lambda executor:True)
        with self.assertRaisesRegex(RuntimeError,"containment failed"):
            with service.snapshot_window(True,1):
                native.resume({"running":native.units,"nativeThawed":True})
        self.assertTrue(pause["paused"]);self.assertIsNone(active["id"])
        self.assertEqual(commands,[["systemctl","start",native.units[1]]])
        self.assertEqual(sum(path.endswith("runtime-pause") for path,_ in calls),1)
    def test_failed_drain_releases_maintenance_and_never_pauses_or_kills_work(self):
        service,pause,calls,active,_=self.fixture(busy=True)
        with patch("hybrid_backup.time.monotonic",side_effect=[0,2]):
            with self.assertRaisesRegex(ValueError,"timed out"):
                with service.snapshot_window(True,1):self.fail("Must not snapshot")
        self.assertFalse(pause["paused"]);self.assertIsNone(active["id"])
        self.assertFalse(any(path.endswith("runtime-pause") for path,_ in calls))


class ReceiverContracts(unittest.TestCase):
    def test_retry_repairs_archive_only_crash_state_and_rejects_bad_sidecar(self):
        with tempfile.TemporaryDirectory() as directory:
            payload=b"age-encryption.org/v1\n"+b"fixture encrypted bytes"
            digest=hashlib.sha256(payload).hexdigest()
            name="okami-vps-20261003T010203Z-abcdef12.tar.gz.age"
            target=Path(directory)/name;target.write_bytes(payload);target.chmod(0o600)
            metadata=target.with_name(name+".sha256")
            self.assertFalse(metadata.exists())
            self.assertEqual(backup_receive.receive(directory,name,digest,io.BytesIO(payload)),target)
            self.assertEqual(metadata.read_text(),digest+"\n")
            self.assertEqual(metadata.stat().st_mode&0o777,0o600)
            metadata.write_text("0"*64+"\n")
            with self.assertRaisesRegex(ValueError,"checksum conflicts"):
                backup_receive.receive(directory,name,digest,io.BytesIO(payload))
            metadata.unlink();metadata.symlink_to(target)
            with self.assertRaises(OSError):backup_receive.receive(directory,name,digest,io.BytesIO(payload))
            self.assertEqual(target.read_bytes(),payload)

    def test_retry_after_interrupted_sidecar_publication_is_restorable(self):
        with tempfile.TemporaryDirectory() as directory:
            payload=b"age-encryption.org/v1\n"+b"fixture encrypted bytes"
            digest=hashlib.sha256(payload).hexdigest()
            name="okami-vps-20261003T010203Z-abcdef12.tar.gz.age"
            with patch.object(backup_receive,"ensure_checksum",side_effect=OSError("injected crash")):
                with self.assertRaises(OSError):backup_receive.receive(directory,name,digest,io.BytesIO(payload))
            target=Path(directory)/name
            self.assertTrue(target.exists())
            backup_receive.receive(directory,name,digest,io.BytesIO(payload))
            self.assertEqual(target.with_name(name+".sha256").read_text(),digest+"\n")
            with self.assertRaisesRegex(ValueError,"quota"):
                backup_receive.receive(directory,name,digest,io.BytesIO(payload),max_bytes=22)
            with self.assertRaisesRegex(ValueError,"checksum mismatch"):
                backup_receive.receive(directory,name,digest,io.BytesIO(b"bad copy"))

    def test_encrypted_receiver_checks_digest_size_identity_and_never_replaces(self):
        with tempfile.TemporaryDirectory() as temp:
            directory=Path(temp)/"inbox";payload=b"age-encryption.org/v1\nfixture-encrypted-envelope"
            name="okami-vps-20261003T120000Z-abcdef12.tar.gz.age";digest=hashlib.sha256(payload).hexdigest()
            target=backup_receive.receive(directory,name,digest,io.BytesIO(payload))
            self.assertEqual(target.read_bytes(),payload)
            backup_receive.receive(directory,name,digest,io.BytesIO(payload))
            with self.assertRaises(ValueError):backup_receive.receive(directory,name,"0"*64,io.BytesIO(payload))
            self.assertEqual(target.read_bytes(),payload)
            with self.assertRaises(ValueError):backup_receive.receive(directory,name.replace("abcdef12","abcdef13"),digest,io.BytesIO(payload),max_bytes=24)
            with self.assertRaises(ValueError):backup_receive.receive(directory,"../plaintext.tar.gz",digest,io.BytesIO(payload))
            self.assertEqual(len(list(directory.glob("*.age"))),1)


class BudgetContracts(unittest.TestCase):
    def test_measured_hermes_plus_os_and_recovery_caps_fit_actual_ram_and_swap_is_not_ram(self):
        compose={"services":{name:{"mem_limit":cap,"memswap_limit":cap} for name,cap in
            (("server","2g"),("browser","2g"),("openbao","256m"))}}
        compose["services"]["computer"]={"mem_limit":"2944m","memswap_limit":"2944m","profiles":["legacy-computer"]}
        mem={"MemTotal":8*1024**3,"MemAvailable":6*1024**3,"SwapTotal":4*1024**3}
        hermes={"active":True,"current":2163306496,"peak":2295918592}
        report=verify_hybrid.vps_budget(compose,mem,hermes)
        self.assertTrue(report["ready"]);self.assertEqual(report["budgetBytes"],8053063680)
        self.assertFalse(verify_hybrid.vps_budget(compose,{**mem,"MemTotal":7*1024**3},hermes)["ready"])
        self.assertTrue(verify_hybrid.vps_budget(compose,{**mem,"SwapTotal":4*1024**3-4096},hermes)["ready"])
        self.assertFalse(verify_hybrid.vps_budget(compose,{**mem,"SwapTotal":4*1024**3-1024**2},hermes)["ready"])
        self.assertFalse(verify_hybrid.vps_budget(compose,mem,{**hermes,"peak":3*1024**3})["ready"])
        self.assertFalse(verify_hybrid.vps_budget(compose,mem,hermes,True)["ready"])
        no_ram={**mem,"MemAvailable":3*1024**3,"SwapTotal":64*1024**3}
        self.assertFalse(verify_hybrid.vps_budget(compose,no_ram,hermes)["ready"])
        warm={**mem,"MemAvailable":2*1024**3}
        self.assertFalse(verify_hybrid.vps_budget(compose,warm,hermes)["ready"])
        self.assertTrue(verify_hybrid.vps_budget(compose,warm,hermes,allocated={"server":2*1024**3,"browser":2*1024**3})["ready"])


class BrowserPolicyContracts(unittest.TestCase):
    def test_private_umask_does_not_hide_runtime_modules_or_change_link_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);code=root/"runtime";external=root/"secret"
            external.write_text("protected");external.chmod(0o600)
            prior=os.umask(0o077)
            try:
                module=code/"desktop"/"broker.py";module.parent.mkdir(mode=0o755,parents=True)
                module.write_text("# source");executable=code/"tool";executable.write_text("#!python");executable.chmod(0o700)
                (code/"external").symlink_to(external)
            finally:os.umask(prior)
            self.assertEqual(module.parent.stat().st_mode&0o777,0o700)
            install_native.publish_runtime_permissions(code)
            self.assertEqual(code.stat().st_mode&0o777,0o755)
            self.assertEqual(module.parent.stat().st_mode&0o777,0o755)
            self.assertEqual(module.stat().st_mode&0o777,0o644)
            self.assertEqual(executable.stat().st_mode&0o777,0o755)
            self.assertEqual(external.stat().st_mode&0o777,0o600)

    def test_scoped_userns_exception_names_only_the_protected_browser_executable(self):
        path="/opt/okami-computer/playwright-browsers/chromium-1234/chrome-linux64/chrome"
        profile=install_native.browser_userns_profile(path)
        self.assertIn("profile okami-chromium "+path+" flags=(unconfined)",profile)
        self.assertIn("userns,",profile)
        self.assertNotIn("**",profile)
        self.assertNotIn("no-sandbox",profile)
        for invalid in ("/home/okami-bot/chrome","/opt/okami-computer/playwright-browsers/../chrome",path+"*",path+"\nuserns,"):
            with self.assertRaises(ValueError):install_native.browser_userns_profile(invalid)


class InstallPlanContracts(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        base=Path(self.temp.name);self.source=base/"source";self.inputs=base/"inputs"
        self.inputs.mkdir(mode=0o700);self.source.mkdir(mode=0o700)
        repo=Path(__file__).resolve().parents[1]
        for name in ("apps/computer","apps/worker/src","packages/domain/src","scripts","deploy","infra/systemd"):
            shutil.copytree(repo/name,self.source/name,ignore=shutil.ignore_patterns("__pycache__","node_modules"))
        for name in ("package.json","package-lock.json","tsconfig.json","tsconfig.native.json"):shutil.copyfile(repo/"apps/worker"/name,self.source/"apps/worker"/name)
        shutil.copyfile(repo/"LICENSE",self.source/"LICENSE")
        shutil.copyfile(repo/"package.json",self.source/"package.json")
        # Current milestone branch predates root's M11 merge. The installer refuses
        # that incomplete source; this fixture supplies only the required entrypoint.
        (self.source/"apps/computer/media_job.py").write_text("# reviewed M11 entrypoint fixture\n")
        self.account={"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot",
            "workspace":"/home/okami-bot/workspace","trustMode":"full-trust","hostId":"lenovo",
            "desktop":{"sessionId":"2a4e756e-5074-4738-9343-2c36dfb1cf85","display":71,"profileId":"personal","proxyPort":18777},
            "network":{"dns":["1.1.1.1"],"administrativeRepliesVerified":True}}
        values={"users.json":{"lenovo-okami":self.account},"apps.json":{},"lenovo-okami.json":{
            "executorId":"lenovo-okami","hostId":"lenovo","serverOrigin":"http://100.113.59.40:8787"},
            "lenovo-okami.credential.json":{"token":"PRIVATE-NODE-TOKEN-FIXTURE-CANARY".ljust(32,"x")}}
        for name,value in values.items():(self.inputs/name).write_text(json.dumps(value));(self.inputs/name).chmod(0o600)
        self.lookup=lambda _:SimpleNamespace(pw_uid=1003,pw_gid=1004,pw_dir="/home/okami-bot")
    def plan(self):return install_native.build_plan(self.source,self.inputs,16*1024**3,user_lookup=self.lookup)
    def test_plan_pins_dependencies_layout_and_omits_secrets_without_downloading_model(self):
        plan=self.plan();text=json.dumps(plan)
        self.assertNotIn("PRIVATE-NODE-TOKEN",text)
        self.assertFalse(plan["asrModel"]["download"]);self.assertFalse(plan["containmentGuaranteed"])
        self.assertIn("packages/domain/src/browser-payment.ts",plan["sourceHashes"])
        self.assertIn("repository/native-dist/apps/worker/src/native.js",plan["units"]["okami-session@lenovo-okami.service"])
        self.assertIn("NoNewPrivileges=no",plan["units"]["okami-session@lenovo-okami.service"])
        self.assertIn("libreoffice-writer",plan["packages"])
        self.assertIn("ffmpeg",plan["packages"])
        self.assertIn("PLAYWRIGHT_BROWSERS_PATH=/opt/okami-computer/playwright-browsers",plan["units"]["okami-session@lenovo-okami.service"])
        self.assertIn("--browser-channel chromium",plan["units"]["okami-session@lenovo-okami.service"])
        self.assertIn("--browser-proxy-port 18777",plan["units"]["okami-session@lenovo-okami.service"])
        self.assertIn("tcp sport 18777 ct direction reply ct state established accept",plan["firewall"])
        self.assertIn("soak_hybrid.py",plan["units"]["okami-soak@.service"])
    def test_incompatible_python_fails_before_package_or_service_mutation(self):
        plan=self.plan();calls=[]
        def fail_probe(argv,**kwargs):
            calls.append(argv)
            if "--dry-run" in argv:raise subprocess.CalledProcessError(1,argv)
        with patch.object(install_native,"root_path",lambda path,**_:Path(path)),patch.object(
            install_native.subprocess,"run",return_value=SimpleNamespace(stdout="inactive")),patch.object(
            install_native,"execute",side_effect=fail_probe):
            with self.assertRaises(subprocess.CalledProcessError):install_native.prepare(plan)
        self.assertEqual(len(calls),2)
        self.assertIn("--only-binary=:all:",calls[-1])
        self.assertFalse(any(argv[0] in ("apt-get","systemctl","npm") for argv in calls))
    def test_missing_media_changed_identity_unverified_admin_and_symlink_sources_fail_closed(self):
        with patch.object(self,"lookup",lambda _:SimpleNamespace(pw_uid=2000,pw_gid=1004,pw_dir="/home/okami-bot")):
            with self.assertRaisesRegex(ValueError,"UID"):self.plan()
        (self.source/"apps/computer/media_job.py").unlink()
        with self.assertRaisesRegex(ValueError,"media"):self.plan()
        (self.source/"apps/computer/media_job.py").symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):self.plan()
        self.account["network"]["administrativeRepliesVerified"]=False
        (self.inputs/"users.json").write_text(json.dumps({"lenovo-okami":self.account}))
        with self.assertRaisesRegex(ValueError,"administrative"):self.plan()


if __name__=="__main__":unittest.main()
