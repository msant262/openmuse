"""MIT. Selectively quiesced, age-encrypted backups between the existing two hosts.

Optional maintenance closes admission and drains work before taking a reversible
owned pause. No task is killed and no restore starts an executor/API/cron.
"""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error
import uuid

from deployment_backup import Deployment,checksum,private_path,validate_archive

ENCRYPTED=re.compile(r"okami-(vps|lenovo)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.tar\.gz\.age")
VPS_ROOTS={"server","browser","vault.snap","deployment.env","deployment-secrets","manifest.json"}
NATIVE_ROOTS={"home","native-state","native-config","manifest.json"}


def portable_native_member(member, sources, omitted):
    """Do not follow home links or recreate host-external links during recovery."""
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        omitted.append({"path":member.name,"reason":"runtime-special-file"})
        return None
    if not member.issym():return member
    root,_,relative=member.name.partition("/")
    if root not in ("home","native-state"):
        raise ValueError("Configuration entries must not be links")
    original=member.linkname
    actual=Path(sources[root])/relative
    target=Path(os.path.normpath(original if os.path.isabs(original) else str(actual.parent/original)))
    for mapped,source in sorted(sources.items(),key=lambda item:len(str(item[1])),reverse=True):
        base=Path(source)
        if target==base or base in target.parents:
            archive_target=Path(mapped)/target.relative_to(base)
            member.linkname=os.path.relpath(archive_target,Path(member.name).parent)
            return member
    omitted.append({"path":member.name,"reason":"external-symlink","target":original})
    return None


class HybridBackup:
    def __init__(self,config_path,mode,timeout=1800):
        if mode not in ("hybrid-vps","native"):raise ValueError("Unknown hybrid backup mode")
        config_path=private_path(config_path)
        self.config=json.loads(config_path.read_text())
        self.mode,self.timeout=mode,timeout
        self.directory=private_path(self.config["backupDir"],directory=True,create=True)
        self.restore_directory=Path(self.config.get("restoreDir","/var/lib/okami-restore"))
        self.age=self.config.get("ageBinary","/usr/bin/age")
        if not re.fullmatch(r"age1[0-9a-z]{58}",self.config["recipient"]):
            raise ValueError("Use an operator-owned native age recipient; private identity stays offline")
        origin=urllib.parse.urlsplit(self.config["apiOrigin"])
        if origin.scheme not in ("http","https") or origin.username or origin.password or origin.path not in ("","/") or origin.query or origin.fragment:
            raise ValueError("Invalid private API origin")
        import ipaddress
        if origin.scheme=="http" and (origin.hostname is None or ipaddress.ip_address(origin.hostname) not in
            ipaddress.ip_network("100.64.0.0/10") and origin.hostname!="127.0.0.1"):
            raise ValueError("Plain HTTP backup preflight is localhost/Tailscale only")
        self.token_file=private_path(self.config["apiBearerFile"])
        self.roots=VPS_ROOTS if mode=="hybrid-vps" else NATIVE_ROOTS
        if mode=="hybrid-vps":
            self.project=Path(self.config["projectDir"]).resolve(strict=True)
            self.env=private_path(self.config["envFile"])
            self.secrets=private_path(self.project/"deployment-secrets",directory=True,owners=(0,1000) if os.geteuid()==0 else None)
            self.compose=["docker","compose","--project-directory",str(self.project),"--env-file",str(self.env),
                "-f",str(self.project/"docker-compose.yml"),"-f",str(self.project/"deploy/compose.hybrid.yml")]
            private_path(self.config["vaultBackupTokenFile"])
        else:
            from importlib import import_module
            import sys
            sys.path.insert(0,self.config.get("nativeCode","/opt/okami-computer"))
            registry=import_module("executor.user_session").root_owned_json(self.config.get("nativeConfig","/etc/okami-executor")+"/users.json")
            self.account=registry[self.config["executorId"]]
            self.units=["okami-executor@"+self.config["executorId"]+".service","okami-session@"+self.config["executorId"]+".service"]
            self.native_admin=import_module("executor.admin_helper").AdminHelper(registry,runner=self.output)

    def run(self,argv,**kwargs):
        return subprocess.run(argv,check=True,timeout=self.timeout,stderr=subprocess.PIPE,**kwargs)

    def output(self,argv):return self.run(argv,stdout=subprocess.PIPE).stdout.decode().strip()

    @contextlib.contextmanager
    def lock(self):
        fd=os.open(self.directory/".hybrid.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,"w") as stream:
            fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB);yield

    def api(self,path="/api/deployment/status",body=None):
        token=self.token_file.read_text().strip()
        if not re.fullmatch(r"odb1\.[A-Za-z0-9_-]{43}",token):
            raise ValueError("Use the scoped root backup token, never a pairing key or expiring device session")
        request=urllib.request.Request(self.config["apiOrigin"].rstrip("/")+path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*_):raise ValueError("Backup status must not redirect")
        with urllib.request.build_opener(NoRedirect).open(request,timeout=15) as response:
            data=response.read(65537)
            if len(data)>65536:raise ValueError("Excessive backup status response")
            result=json.loads(data)
            if not isinstance(result,dict):raise ValueError("Invalid trusted API response")
            return result

    def preflight(self):
        status=self.api()
        if status.get("format")!=1 or not status.get("readyForStoppedWriterBackup") or status.get("pause",{}).get("paused") is not True:
            raise ValueError("Backup deferred: pause explicitly, close viewers, and reconcile active/unknown work first")
        return {"revision":status["pause"]["revision"],"paused":True}

    @contextlib.contextmanager
    def snapshot_window(self,quiesce,drain_timeout):
        if not quiesce:
            yield self.preflight();return
        status=self.api()
        # No live work can reconcile these remaining operations while admission
        # is closed. Defer the snapshot instead of taking the app offline for
        # the full drain timeout; retain every uncertain receipt unchanged.
        if status.get("activeOperations",0)>0 and all(status.get(key)==0 for key in (
                "activeTasks","activeConversations","activeHttpRequests",
                "nativeDeliveries","workAdmissions","heldResources")):
            raise ValueError("Backup deferred: idle runtime has unresolved operations; admission remains open")
        identity=str(uuid.uuid4());owned_pause=None;completed=False
        try:
            self.api("/api/deployment/maintenance",{"id":identity,"operation":"begin","ttlMs":120000})
            deadline=time.monotonic()+drain_timeout
            renewed=0
            while True:
                status=self.api()
                if (status.get("maintenance") or {}).get("id")!=identity:
                    raise ValueError("Maintenance lease changed while draining")
                if status.get("readyForStoppedWriterBackup"):
                    pause=status["pause"]
                    if not pause["paused"]:
                        # Only after the admission barrier and every active/held
                        # request have drained. Pause therefore kills/freezes no job.
                        changed=self.api("/api/agent/runtime-pause",{"paused":True,"expectedRevision":pause["revision"]})
                        if changed.get("paused") is not True or changed.get("revision")!=pause["revision"]+1:
                            raise ValueError("Pause outcome could not be confirmed; operator inspection is required")
                        owned_pause=changed
                    break
                if time.monotonic()>=deadline:
                    raise ValueError("Backup drain timed out; existing work is preserved")
                if time.monotonic()-renewed>=30:
                    self.api("/api/deployment/maintenance",{"id":identity,"operation":"renew","ttlMs":120000})
                    renewed=time.monotonic()
                time.sleep(min(1,max(0,deadline-time.monotonic())))
            yield self.preflight()
            completed=True
        finally:
            # Metadata GETs may retry after an API restart. A lost pause response
            # leaves the user pause untouched; never infer ownership from a model
            # or a later revision and silently unpause it.
            available=False
            for _ in range(30):
                try:self.api();available=True;break
                except (OSError,ValueError):time.sleep(1)
            if not available:raise RuntimeError("API did not return; temporary pause/maintenance need operator inspection")
            # An exception can be a remote writer/containment restoration failure.
            # A reachable API cannot prove physical recovery. Retain our pause for
            # inspection on every incomplete snapshot, including peer failures.
            if owned_pause and completed:
                try:self.api("/api/agent/runtime-pause",{"paused":False,"expectedRevision":owned_pause["revision"]})
                except urllib.error.HTTPError as error:
                    error.close()
                    if error.code!=409:raise
                    # A user changed pause after us. Its new revision is authoritative.
            try:self.api("/api/deployment/maintenance",{"id":identity,"operation":"finish"})
            except urllib.error.HTTPError as error:
                error.close()
                if error.code!=409:raise

    def peer_snapshot(self,batch):
        peer=self.config.get("nativeBackupPeer")
        if not peer:
            if self.config.get("requirePeerSnapshot",True):raise ValueError("Configure the fixed Lenovo snapshot peer before a coordinated VPS backup")
            return False
        import ipaddress
        address=peer["tailscaleIP"]
        if ipaddress.ip_address(address) not in ipaddress.ip_network("100.64.0.0/10"):
            raise ValueError("Native snapshot requires the fixed existing Tailscale host")
        self.run(["ssh","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","IdentitiesOnly=yes",
            "-i",str(private_path(peer["sshIdentityFile"])),"root@"+address,
            "/usr/local/sbin/okami-backup-native "+batch],stdout=subprocess.DEVNULL)
        return True

    def containers(self):
        values={}
        for service in ("server","browser","openbao"):
            identity=self.output(self.compose+["ps","--all","--quiet",service])
            if not identity or "\n" in identity:raise ValueError("Exactly one existing hybrid container per service is required")
            values[service]=json.loads(self.output(["docker","inspect",identity]))[0]
        if any(e.startswith("DATABASE_URL=") and e!="DATABASE_URL=" for e in values["server"]["Config"].get("Env",[])):
            raise ValueError("External Postgres needs its own consistent backup")
        if values["openbao"]["Config"]["Image"]!="openbao/openbao:2.7.1":
            raise ValueError("Raft snapshot requires the reviewed OpenBao version")
        return values

    @staticmethod
    def volumes(values):
        volumes={}
        for name,destination in (("server","/data/openmuse"),("browser","/data"),("openbao","/openbao/data")):
            found=[item for item in values[name]["Mounts"] if item["Destination"]==destination]
            if len(found)!=1 or found[0]["Type"]!="volume" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*",found[0].get("Name","")):
                raise ValueError("Hybrid state must use exact inspected named volumes")
            volumes[name]=found[0]["Name"]
        if len(set(volumes.values()))!=3:raise ValueError("Hybrid state volumes must be distinct")
        return volumes

    def quiesce(self):
        if self.mode=="hybrid-vps":
            before=self.containers();volumes=self.volumes(before)
            running=[name for name in ("server","browser") if before[name]["State"].get("Running")]
            if not before["openbao"]["State"].get("Running"):raise ValueError("OpenBao must be running for a consistent Raft snapshot")
            return {"before":before,"volumes":volumes,"running":running}
        states={unit:self.output(["systemctl","show",unit,"--property=ActiveState","--value"]) for unit in self.units}
        if any(state not in ("active","inactive","failed") for state in states.values()):raise ValueError("Native session transition is not a backup safe point")
        jobs=self.output(["systemctl","list-units","okami-job-*.service","--state=active,activating,deactivating","--no-legend","--no-pager"])
        if jobs:raise ValueError("Managed jobs still exist; never kill them for backup")
        return {"running":[unit for unit,state in states.items() if state=="active"]}

    def stop(self,context):
        if self.mode=="hybrid-vps":
            for name in context["running"]:self.run(self.compose+["stop",name],stdout=subprocess.DEVNULL)
            values=self.containers()
            Deployment.stopped({name:values[name] for name in ("server","browser")},clean=True)
            if self.volumes(values)!=context["volumes"]:raise ValueError("Hybrid volume identities changed during quiescence")
        else:
            # Pause freezes the registered session and its account slice. systemd
            # cannot stop a frozen service. Keep its verified network gate closed,
            # stop the supervisor first, then thaw only this drained account for
            # graceful writer shutdown. Other sessions/accounts are untouched.
            executor=self.config["executorId"]
            self.native_admin.gate(executor,True)
            if self.units[0] in context["running"]:
                self.run(["systemctl","stop",self.units[0]],stdout=subprocess.DEVNULL)
            context["nativeThawed"]=True  # restore containment even after partial failure
            self.native_admin.resume_account(executor)
            self.native_admin.resume_session(executor)
            if self.units[1] in context["running"]:
                self.run(["systemctl","stop",self.units[1]],stdout=subprocess.DEVNULL)
            for unit in self.units:
                state=dict(line.split("=",1) for line in self.output(["systemctl","show",unit,"--property=ActiveState,SubState,MainPID,Result,ExecMainCode,ExecMainStatus"]).splitlines())
                # dbus-run-session is normally terminated by systemctl's SIGTERM
                # after the managed broker/process group closes. systemd reports
                # CLD_KILLED=2/status15 with Result=success, not an exit code143.
                # Never accept SIGKILL, core dumps, timeout/OOM or a remaining PID.
                clean_exit=(state.get("ExecMainCode") in ("0","1") and state.get("ExecMainStatus")=="0") or (state.get("ExecMainCode"),state.get("ExecMainStatus"))==("2","15")
                if state.get("ActiveState")!="inactive" or state.get("SubState")!="dead" or state.get("MainPID")!="0" or state.get("Result")!="success" or not clean_exit:
                    raise ValueError("Native managed writer did not confirm a clean stop")

    def resume(self,context):
        errors=[]
        if self.mode=="native" and context.get("nativeThawed"):
            executor=self.config["executorId"]
            try:
                if self.units[1] in context["running"]:
                    self.run(["systemctl","start",self.units[1]],stdout=subprocess.DEVNULL)
            except (OSError,subprocess.SubprocessError) as error:errors.append(error)
            # Restore physical pause before the out-of-slice supervisor starts.
            # Only the coordinator's original pause CAS may later resume work.
            for contain in (self.native_admin.contain_session,self.native_admin.contain_account):
                try:
                    if not contain(executor):raise ValueError("Native pause restoration unconfirmed")
                except (OSError,ValueError,subprocess.SubprocessError) as error:errors.append(error)
            if not errors and self.units[0] in context["running"]:
                try:self.run(["systemctl","start",self.units[0]],stdout=subprocess.DEVNULL)
                except (OSError,subprocess.SubprocessError) as error:errors.append(error)
            if errors:raise RuntimeError("Native writers/containment failed to resume; runtime pause remains set")
            return
        order=("browser","server") if self.mode=="hybrid-vps" else tuple(reversed(self.units))
        for unit in order:
            if unit in context["running"]:
                try:self.run((self.compose+["start",unit]) if self.mode=="hybrid-vps" else ["systemctl","start",unit],stdout=subprocess.DEVNULL)
                except (OSError,subprocess.SubprocessError) as error:errors.append(error)
        if errors:raise RuntimeError("Previous managed writers failed to resume; runtime pause remains set")

    def raft_snapshot(self,context,target):
        token=private_path(self.config["vaultBackupTokenFile"]).read_text().strip()
        if not token or "\n" in token:raise ValueError("Invalid scoped Raft backup credential")
        name="/tmp/okami-raft-"+uuid.uuid4().hex+".snap"
        # Credential arrives on stdin, never argv/env of docker, logs, model, or archive.
        script="IFS= read -r BAO_TOKEN; export BAO_TOKEN; export BAO_ADDR=http://127.0.0.1:8200; exec bao operator raft snapshot save "+name
        try:
            self.run(self.compose+["exec","-T","openbao","sh","-ec",script],input=(token+"\n").encode(),stdout=subprocess.DEVNULL)
            # Docker's archive/cp API does not see this container's tmpfs mount.
            # Read inside the same namespace and stream directly into a private
            # host file; snapshot bytes never enter logs or command arguments.
            with target.open("xb") as stream:
                target.chmod(0o600)
                self.run(self.compose+["exec","-T","openbao","cat",name],stdout=stream)
        finally:
            self.run(self.compose+["exec","-T","openbao","rm","-f",name],stdout=subprocess.DEVNULL)

    def archive(self,context,staging,manifest):
        (staging/"manifest.json").write_text(json.dumps(manifest,indent=2));(staging/"manifest.json").chmod(0o600)
        archive=staging/"state.tar.gz"
        if self.mode=="hybrid-vps":
            self.raft_snapshot(context,staging/"vault.snap")
            secrets=staging/"deployment-secrets";secrets.mkdir(mode=0o700)
            for entry in self.secrets.iterdir():
                if entry.name=="openbao-unseal.key":continue  # Recovery seal key is a separate offline material.
                if entry.is_symlink() or not entry.is_file():raise ValueError("Unexpected protected deployment secret entry")
                shutil.copyfile(private_path(entry,owners=(0,1000) if os.geteuid()==0 else None),secrets/entry.name);(secrets/entry.name).chmod(0o600)
            command=Deployment.helper(self,None,{name:volume for name,volume in context["volumes"].items() if name!="openbao"})
            for source,target in ((self.env,"deployment.env"),(secrets,"deployment-secrets"),(staging/"manifest.json","manifest.json"),(staging/"vault.snap","vault.snap")):
                command += ["--mount",f"type=bind,src={source},dst=/state/{target},readonly"]
            command += ["--entrypoint","tar",context["before"]["server"]["Config"]["Image"],"--numeric-owner","-czf","-","-C","/state",*sorted(VPS_ROOTS)]
            with archive.open("xb") as stream:
                archive.chmod(0o600);self.run(command,stdout=stream)
        else:
            sources={"home":self.account["home"],"native-state":self.config.get("nativeState","/var/lib/okami-executor"),
                "native-config":self.config.get("nativeConfig","/etc/okami-executor")}
            omitted=[]
            with tarfile.open(archive,"w:gz",dereference=False) as stream:
                for root,source in sources.items():
                    path=Path(source)
                    if any(p.is_symlink() for p in (path,*path.parents)):raise ValueError("Native backup source ancestry is a symlink")
                    stream.add(path,arcname=root,filter=lambda member:portable_native_member(member,sources,omitted))
                manifest["omittedNativeEntries"]=omitted
                manifest["nativeLinkPolicy"]="Internal links made relative; external links and runtime special files recorded but not restored"
                (staging/"manifest.json").write_text(json.dumps(manifest,indent=2))
                stream.add(staging/"manifest.json",arcname="manifest.json")
            archive.chmod(0o600)
        validate_archive(archive,self.roots,{"server","browser","home","native-state"})
        return archive

    def encrypt(self,archive,target):
        self.run([self.age,"--encrypt","--recipient",self.config["recipient"],"--output",str(target),str(archive)],stdout=subprocess.DEVNULL)
        target.chmod(0o600)
        with target.open("rb") as stream:os.fsync(stream.fileno())

    def transfer(self,archive):
        peer=self.config.get("peer")
        if not peer or peer.get("host") not in ("lenovo","vps") or peer["host"]==("vps" if self.mode=="hybrid-vps" else "lenovo"):
            raise ValueError("Backup transfer must target the other existing runtime host")
        address=peer.get("tailscaleIP","")
        import ipaddress
        if ipaddress.ip_address(address) not in ipaddress.ip_network("100.64.0.0/10"):
            raise ValueError("Cross-host transfer requires the fixed existing Tailscale peer")
        # Remote command is a committed root-owned receiver, not a model-selected path.
        name=archive.name
        if not ENCRYPTED.fullmatch(name):raise ValueError("Only committed encrypted backup names are transferable")
        command=["ssh","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","IdentitiesOnly=yes",
            "-i",str(private_path(peer["sshIdentityFile"])),"root@"+address,
            "/usr/local/sbin/okami-backup-receive "+name+" "+checksum(archive)]
        with archive.open("rb") as stream:self.run(command,stdin=stream,stdout=subprocess.DEVNULL)

    def backup(self,retention_days,batch_id=None,transfer=False,quiesce=False,drain_timeout=300):
        with self.lock(),self.snapshot_window(quiesce,drain_timeout) as pause:
            batch=str(uuid.UUID(batch_id)) if batch_id else str(uuid.uuid4())
            peer_confirmed=self.peer_snapshot(batch) if self.mode=="hybrid-vps" else False
            # Recheck the same user-pause revision after the peer's encrypted copy.
            if self.preflight()!=pause:raise ValueError("Pause changed during the peer snapshot; no VPS archive authorized")
            context=self.quiesce()
            stamp=datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            host="vps" if self.mode=="hybrid-vps" else "lenovo"
            name=f"okami-{host}-{stamp}-{uuid.uuid4().hex[:8]}.tar.gz.age"
            destination=self.directory/name
            try:
                self.stop(context)
                with tempfile.TemporaryDirectory(prefix=".pending-",dir=self.directory) as temp:
                    stage=Path(temp)
                    manifest={"format":2,"host":host,"batchId":batch,"createdAt":stamp,"pause":pause,
                        "quiescedWriters":context["running"],"sealKeyIncluded":False,
                        "restoreStartsServices":False,"volumes":context.get("volumes",{}),"peerSnapshotConfirmed":peer_confirmed}
                    if host=="vps":manifest["serverImage"]=context["before"]["server"]["Config"]["Image"]
                    source=self.archive(context,stage,manifest)
                    pending=stage/name;self.encrypt(source,pending)
                    metadata=stage/(name+".sha256");metadata.write_text(checksum(pending)+"\n");metadata.chmod(0o600)
                    os.replace(metadata,self.directory/metadata.name);os.replace(pending,destination)
            finally:self.resume(context)  # Keeps the durable user pause; never implicitly resumes effects.
            if transfer:self.transfer(destination)
            cutoff=datetime.datetime.now().timestamp()-retention_days*86400
            for old in self.directory.iterdir():
                if ENCRYPTED.fullmatch(old.name) and old!=destination and not old.is_symlink() and old.stat().st_mtime<cutoff:
                    old.unlink();old.with_name(old.name+".sha256").unlink(missing_ok=True)
            print("Encrypted backup committed: "+destination.name+"; managed writers restored; only an acknowledged backup-owned pause may resume")
            return destination

    def restore(self,archive_path,identity_path):
        with self.lock():
            archive=private_path(archive_path);identity=private_path(identity_path)
            if not ENCRYPTED.fullmatch(archive.name):raise ValueError("Unsupported encrypted archive")
            expected=private_path(str(archive)+".sha256").read_text().strip()
            if not re.fullmatch(r"[a-f0-9]{64}",expected) or checksum(archive)!=expected:raise ValueError("Encrypted backup checksum failed")
            directory=private_path(self.restore_directory,directory=True,create=True)
            # Never decrypt recovery credentials into the full-trust account's
            # home or below active application/config/volume paths.
            prohibited=[Path("/home"),Path("/opt"),Path("/etc"),Path("/var/lib/docker"),Path("/var/lib/okami-executor")]
            if self.mode=="hybrid-vps":prohibited.append(self.project)
            else:prohibited.append(Path(self.account["home"]))
            if any(directory==path or path in directory.parents for path in prohibited):
                raise ValueError("Restore target must be a private isolated operator directory outside active state and agent home")
            target=directory/("isolated-"+uuid.uuid4().hex);target.mkdir(mode=0o700)
            try:
                with tempfile.TemporaryDirectory(prefix=".decrypt-",dir=directory) as temp:
                    plain=Path(temp)/"state.tar.gz"
                    self.run([self.age,"--decrypt","--identity",str(identity),"--output",str(plain),str(archive)],stdout=subprocess.DEVNULL)
                    plain.chmod(0o600)
                    validate_archive(plain,self.roots,{"server","browser","home","native-state"})
                    with tarfile.open(plain,"r:gz") as bundle:
                        # Python's data filter rejects escaping/absolute symlinks; no
                        # archive is extracted over production dirs, volumes or credentials.
                        bundle.extractall(target,filter="data")
                manifest=json.loads((target/"manifest.json").read_text())
                if manifest.get("format")!=2 or manifest.get("host")!=("vps" if self.mode=="hybrid-vps" else "lenovo"):
                    raise ValueError("Backup host/format mismatch")
                isolated={"services":{"inspect":{"image":manifest.get("serverImage","openmuse-server:local"),
                    "network_mode":"none","read_only":True,"user":"1000:1000","init":True,
                    "mem_limit":"1024m","memswap_limit":"1024m","pids_limit":192,
                    "cap_drop":["ALL"],"security_opt":["no-new-privileges:true"],"tmpfs":["/tmp:size=128m"],
                    "environment":{"WORKSPACE_MODE":"sample","AGENT_BACKEND":"sample","HOST":"127.0.0.1","PORT":"8788",
                        "PUBLIC_API_URL":"http://localhost:8788","DATA_DIR":"/data/openmuse","TASK_WORKER_ENABLED":"false",
                        "PROACTIVITY_ENABLED":"false","COMPUTER_ENABLED":"false","BROWSER_WORKER_URL":"","MODEL":""},
                    "volumes":[{"type":"bind","source":str(target/"server"),"target":"/data/openmuse"}]}}}
                (target/"compose.inspect.json").write_text(json.dumps(isolated,indent=2))
                for file in (target/"manifest.json",target/"compose.inspect.json"):file.chmod(0o600)
            except BaseException:
                shutil.rmtree(target);raise
            print("Restore staged in a new private directory: "+str(target)+"; no service, executor, cron or send was started")
            return target
