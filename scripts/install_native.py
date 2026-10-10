#!/usr/bin/env python3
"""MIT. Review a fixed existing-account installation before root prepares/activates it.

No shell recipes, OS Python replacement, account creation or remote administration.
The plan contains hashes and public settings, never credential values.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"apps/computer"))
from executor.deployment import render_units,unit_text
from executor.user_session import UserSession,root_owned_json
from deployment.firewall.render import render as render_firewall

CODE=Path("/opt/okami-computer")
CONFIG=Path("/etc/okami-executor")
MODEL=Path("/opt/openmuse/models/whisper-small")
MODEL_REVISION="536b0662742c02347bc0e980a01041f333bce120"
GOG={"url":"https://github.com/openclaw/gogcli/releases/download/v0.43.0/gogcli_0.43.0_linux_amd64.tar.gz",
     "sha256":"a16d4b8b917e36b96b09b30ecb7a5049d06ff1e88b856a101eec12b86b33fe05","version":"0.43.0",
     "licenseUrl":"https://raw.githubusercontent.com/openclaw/gogcli/v0.43.0/LICENSE",
     "licenseSha256":"14293556b79940745123d0160c71d27ed0e9fe9b8a848093f3ed78f4853caafe"}
PACKAGES=("python3-venv","python3-pillow","python3-xlib","dbus-x11","xauth",
          "tigervnc-standalone-server","xfce4","novnc","nftables","iproute2","apparmor",
          "nodejs","npm","xdotool","libreoffice-writer","libreoffice-calc","libreoffice-impress",
          "ffmpeg","libgomp1","fonts-dejavu-core","fonts-liberation","age",
          "python3-pip","poppler-utils","imagemagick","jq","git","curl","ca-certificates")
SAFE_PATH=re.compile(r"/[A-Za-z0-9._/-]+")


def sha(path):
    digest=hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):digest.update(chunk)
    return digest.hexdigest()


def no_links(path):
    path=Path(path).absolute()
    if any(p.is_symlink() for p in (path,*path.parents)):
        raise ValueError("Installation paths must not contain symlinks")
    return path


def root_path(path,directory=False,private=False):
    path=no_links(path)
    for entry in (path,*path.parents):
        info=entry.stat()
        if info.st_uid!=0 or info.st_mode&0o022:
            raise ValueError("Apply requires root-owned, nonwritable input/code ancestry")
    info=path.stat()
    if directory!=path.is_dir() or private and info.st_mode&0o077:
        raise ValueError("Incorrect protected installation path type or permissions")
    return path


def copy_set(source):
    """Keep the upstream worker/domain relative import layout, without node_modules."""
    files={}
    roots=("apps/computer/executor","apps/computer/desktop","apps/computer/deployment",
           "apps/worker/src","packages/domain/src")
    for root in roots:
        for path in sorted((source/root).rglob("*")):
            if path.is_symlink():raise ValueError("Source symlinks are not installable")
            if path.is_file() and path.suffix in (".py",".ts") and "__pycache__" not in path.parts:
                files[str(path.relative_to(source))]=sha(path)
    for name in ("files.py","media.py","media_job.py","requirements.txt"):
        path=source/"apps/computer"/name
        if path.is_symlink():raise ValueError("Source symlinks are not installable")
        if not path.is_file():raise ValueError("Native media milestone source is missing: "+name)
        files[str(path.relative_to(source))]=sha(path)
    for name in ("package.json","package-lock.json","tsconfig.json","tsconfig.native.json"):
        path=source/"apps/worker"/name
        if path.is_symlink():raise ValueError("Source symlinks are not installable")
        if not path.is_file():raise ValueError("Frozen browser worker package is missing")
        files[str(path.relative_to(source))]=sha(path)
    for name in ("backup_receive.py","backup_native_remote.py","deployment_backup.py","hybrid_backup.py","reload_native_browser.py","verify_hybrid.py","soak_hybrid.py","operator_backup_token.py"):
        path=source/"scripts"/name
        if path.is_symlink() or not path.is_file():raise ValueError("Hybrid deployment scripts are missing or symlinked")
        files[str(path.relative_to(source))]=sha(path)
    for name in ("deploy/THIRD-PARTY.md","infra/systemd/okami-soak@.service"):
        path=source/name
        if path.is_symlink() or not path.is_file():raise ValueError("Deployment notice/unit is missing")
        files[name]=sha(path)
    files["LICENSE"]=sha(source/"LICENSE")
    files["package.json"]=sha(source/"package.json")
    if "apps/worker/src/native.ts" not in files:
        raise ValueError("Connected native browser source is missing")
    return files


def build_plan(source,inputs,memory_total,media_python="/usr/bin/python3",with_model=False,user_lookup=pwd.getpwnam):
    source,inputs=no_links(source),no_links(inputs)
    registry=json.loads((inputs/"users.json").read_text())
    UserSession(registry)
    if len(registry)!=1:raise ValueError("This installer targets one existing Lenovo account")
    executor_id,account=next(iter(registry.items()))
    if account["user"]!="okami-bot" or account["trustMode"]!="full-trust":
        raise ValueError("Preserve the explicitly authorized existing okami-bot full-trust account")
    native=user_lookup(account["user"])
    if (native.pw_uid,native.pw_gid,native.pw_dir)!=(account["uid"],account["gid"],account["home"]):
        raise ValueError("Existing UID/GID/home mismatch; never recreate or modify the account")
    if not account.get("desktop"):raise ValueError("Register the native headed desktop session/profile")
    if not account["desktop"].get("proxyPort"):
        raise ValueError("Register an unused fixed desktop proxyPort for the native UID firewall")
    supervisor=json.loads((inputs/(executor_id+".json")).read_text())
    if supervisor.get("executorId")!=executor_id or supervisor.get("hostId")!=account.get("hostId"):
        raise ValueError("Native host and executor config must match the trusted registry")
    from executor.supervisor import NodeTransport
    credential=json.loads((inputs/(executor_id+".credential.json")).read_text())
    token=credential.get("token")
    if not isinstance(token,str) or not 32<=len(token)<=256:raise ValueError("Invalid node credential file")
    NodeTransport(supervisor["serverOrigin"],executor_id,token)
    if not SAFE_PATH.fullmatch(media_python) or ".." in media_python.split("/"):
        raise ValueError("Media Python must be an absolute fixed local executable")
    units=render_units(registry,memory_total,supervisor.get("reserveBytes",4*1024**3))
    service=units[f"okami-session@{executor_id}.service"]["Service"]
    service["ExecStart"]+=" --browser-worker /opt/okami-computer/repository/native-dist/apps/worker/src/native.js --browser-channel chromium"
    service["Environment"]+=" PLAYWRIGHT_BROWSERS_PATH=/opt/okami-computer/playwright-browsers"
    firewall=render_firewall(registry)  # Refuses unverified administrative recovery paths.
    names=("users.json","apps.json",executor_id+".json",executor_id+".credential.json")
    for name in names:
        path=no_links(inputs/name)
        if not path.is_file():raise ValueError("Missing private native configuration")
    unit_files={name:unit_text(sections) for name,sections in units.items()}
    unit_files["okami-soak@.service"]=(source/"infra/systemd/okami-soak@.service").read_text().replace(
        "/opt/openmuse/scripts/soak_hybrid.py","/opt/okami-computer/repository/scripts/soak_hybrid.py")
    return {"format":1,"source":str(source),"inputs":str(inputs),"executorId":executor_id,
        "account":{key:account[key] for key in ("user","uid","gid","home","workspace","trustMode")},
        "memoryTotalBytes":memory_total,"reserveBytes":supervisor.get("reserveBytes",4*1024**3),
        "sourceHashes":copy_set(source),"inputHashes":{name:sha(inputs/name) for name in names},
        "units":unit_files,"firewall":firewall,
        "mediaPython":media_python,"asrModel":{"path":str(MODEL),"repo":"Systran/faster-whisper-small",
            "revision":MODEL_REVISION,"download":with_model,"device":"cpu","computeType":"int8"},
        "packages":list(PACKAGES),"gog":GOG,
        "effects":["Install explicitly listed packages; no dist-upgrade or Python alternatives",
            "Install root-owned code/config and frozen browser dependencies",
            "Create isolated media venv; keep OS Python and existing account identity",
            "Preserve groups, sudo, SSH, GNOME/RDP, power policy and existing services",
            "Prepare managed systemd units; activation is a separate operator command"],
        "containmentGuaranteed":False}


def execute(argv,**kwargs):
    # Fixed argv; expanded command stderr can contain secrets, so keep it private.
    return subprocess.run(argv,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          timeout=kwargs.pop("timeout",1800),**kwargs)


def checked_plan(path):
    plan=json.loads(root_path(path,private=True).read_text())
    root_path(plan["source"],directory=True);root_path(plan["inputs"],directory=True,private=True)
    current=build_plan(plan["source"],plan["inputs"],plan["memoryTotalBytes"],plan["mediaPython"],plan["asrModel"]["download"])
    if current!=plan:raise ValueError("Plan/source/config changed after review; render and review again")
    measured=next(int(line.split()[1])*1024 for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemTotal:"))
    if measured!=plan["memoryTotalBytes"]:raise ValueError("Physical host RAM differs from the reviewed plan")
    for base,key in ((plan["source"],"sourceHashes"),(plan["inputs"],"inputHashes")):
        for name in plan[key]:root_path(Path(base)/name)
    for target in (CODE,CONFIG,Path("/etc/systemd/system"),Path("/usr/local/bin")):
        no_links(target);root_path(target if target.exists() else target.parent,directory=True)
    return plan


def write_atomic(path,data,mode=0o600):
    path=no_links(path)
    if path.exists():root_path(path)
    with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as stream:
        temporary=Path(stream.name)
        try:
            os.fchmod(stream.fileno(),mode);stream.write(data);stream.flush();os.fsync(stream.fileno())
            os.replace(temporary,path)
        finally:temporary.unlink(missing_ok=True)


def install_gog(settings):
    with tempfile.TemporaryDirectory(prefix="okami-gog-") as temp:
        archive=Path(temp)/"gog.tar.gz"
        with urllib.request.urlopen(settings["url"],timeout=60) as src,archive.open("wb") as out:
            shutil.copyfileobj(src,out)
        if sha(archive)!=settings["sha256"]:raise ValueError("Pinned gog release digest mismatch")
        with tarfile.open(archive,"r:gz") as bundle:
            entries=[item for item in bundle if item.name in ("gog","./gog") and item.isfile()]
            if len(entries)!=1:raise ValueError("Unexpected gog archive layout")
            write_atomic(Path("/usr/local/bin/gog"),bundle.extractfile(entries[0]).read(),0o755)
        # The official binary archive contains only gog. Fetch the license from
        # the same pinned tag and verify its separate reviewed digest.
        with urllib.request.urlopen(settings["licenseUrl"],timeout=30) as stream:license_text=stream.read(65537)
        if len(license_text)>65536 or hashlib.sha256(license_text).hexdigest()!=settings["licenseSha256"]:
            raise ValueError("Pinned gog license digest mismatch")
        directory=Path("/usr/local/share/licenses/gogcli");no_links(directory)
        root_path(next(parent for parent in directory.parents if parent.exists()),directory=True)
        directory.mkdir(mode=0o755,parents=True,exist_ok=True);root_path(directory,directory=True)
        write_atomic(directory/"LICENSE",license_text,0o644)
    execute(["/usr/local/bin/gog","--version"],timeout=30)  # Never authenticates a Google account.


def preflight_python(python,requirements):
    python=root_path(Path(python).resolve(strict=True))
    with tempfile.TemporaryDirectory(prefix="okami-media-python-preflight-") as temp:
        probe=Path(temp)/"venv"
        execute([str(python),"-m","venv",str(probe)],timeout=120)
        execute([str(probe/"bin/python"),"-m","pip","install","--dry-run","--only-binary=:all:",
            "--disable-pip-version-check","-r",str(requirements)],timeout=600)
    return python


def browser_userns_profile(executable):
    executable=str(executable)
    if not executable.startswith(str(CODE)+"/playwright-browsers/") or not SAFE_PATH.fullmatch(executable) or ".." in executable.split("/"):
        raise ValueError("Browser namespace policy requires the exact root-owned Chromium cache path")
    # Mirrors Ubuntu's shipped Chrome exception. This permits its own user
    # namespace sandbox; it does not relax the global userns policy or disable
    # Chromium's sandbox. AppArmor binds by path, not by the recorded digest.
    return ("# MIT. OkamiBot native Chromium namespace sandbox.\n"
            "abi <abi/5.0>,\ninclude <tunables/global>\n"
            "profile okami-chromium "+executable+" flags=(unconfined) {\n"
            "  userns,\n  @{exec_path} mr,\n}\n")


def prepare_browser_policy(worker,cache):
    executable=Path(execute(["/usr/bin/node","--input-type=module","-e",
        "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())"],
        cwd=worker,env={"PATH":"/usr/bin:/bin","PLAYWRIGHT_BROWSERS_PATH":str(cache)},timeout=30).stdout.decode())
    root_path(executable)
    if cache not in executable.parents:raise ValueError("Installed Chromium is outside the protected cache")
    receipt={"executable":str(executable),"sha256":sha(executable),"chromiumSandbox":True,"profile":None}
    restriction=Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
    if restriction.exists() and restriction.read_text().strip()=="1":
        profile=Path("/etc/apparmor.d/okami-chromium")
        text=browser_userns_profile(executable)
        root_path(profile.parent,directory=True)
        if profile.exists() and not root_path(profile).read_text().startswith("# MIT. OkamiBot native Chromium namespace sandbox."):
            raise ValueError("Refusing to replace an unrelated AppArmor policy")
        # Parse against the installed Ubuntu ABI before replacing/loading our
        # own profile. Existing personal/browser profiles stay untouched.
        with tempfile.NamedTemporaryFile(mode="w",dir=CONFIG,prefix=".apparmor-",delete=True) as candidate:
            candidate.write(text);candidate.flush()
            execute(["/usr/sbin/apparmor_parser","--skip-kernel-load","--skip-cache",candidate.name],timeout=30)
        write_atomic(profile,text.encode(),0o644)
        execute(["/usr/sbin/apparmor_parser","--replace","--skip-cache",str(profile)],timeout=30)
        receipt.update({"profile":str(profile),"profileSha256":sha(profile)})
    write_atomic(CONFIG/"browser-runtime.json",json.dumps(receipt,indent=2).encode())


def publish_runtime_permissions(directory):
    """Code/model assets contain no secrets and must be readable by the bot UID.

    The installer deliberately uses umask 077 for private inputs. mkdir's mode
    argument alone cannot make code ancestors readable under that mask.
    """
    directory=no_links(directory)
    for entry in (directory,*directory.rglob("*")):
        if entry.is_symlink():continue
        if entry.stat().st_uid!=os.geteuid():raise ValueError("Runtime tree has unexpected ownership")
        entry.chmod(0o755 if entry.is_dir() or entry.stat().st_mode&0o111 else 0o644)


def prepare(plan):
    executor=plan["executorId"]
    # Replacing code below a live Python/Node process is not an upgrade strategy.
    for unit in (f"okami-executor@{executor}.service",f"okami-session@{executor}.service"):
        state=subprocess.run(["systemctl","is-active",unit],capture_output=True,text=True,timeout=10).stdout.strip()
        if state not in ("inactive","failed","unknown",""):
            raise ValueError("Pause, reconcile and stop only managed units before preparing an upgrade")
    # Resolve every transitive dependency as a compatible wheel BEFORE apt or
    # code/service mutation. Ubuntu 26.04's Python 3.14 must not be assumed.
    python=preflight_python(plan["mediaPython"],Path(plan["source"])/"apps/computer/requirements.txt")
    execute(["apt-get","update"])
    execute(["apt-get","install","--yes","--no-remove","--no-install-recommends",*plan["packages"]])
    version=execute(["/usr/bin/node","--version"],timeout=10).stdout.decode().strip()
    if not re.fullmatch(r"v(?:2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+",version):
        raise ValueError("Native headed browser needs Node 22+ at /usr/bin/node")
    CODE.mkdir(mode=0o755,exist_ok=True);CONFIG.mkdir(mode=0o700,exist_ok=True)
    CODE.chmod(0o755);CONFIG.chmod(0o700)
    for name in plan["sourceHashes"]:
        source=Path(plan["source"])/name
        target=CODE/name.removeprefix("apps/computer/") if name.startswith("apps/computer/") else CODE/"repository"/name
        if name=="LICENSE":target=CODE/"LICENSE"
        target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        write_atomic(target,source.read_bytes(),0o644)
    for name in plan["inputHashes"]:write_atomic(CONFIG/name,(Path(plan["inputs"])/name).read_bytes())
    worker=CODE/"repository/apps/worker"
    execute(["npm","ci","--ignore-scripts","--no-audit","--no-fund"],cwd=worker,
            env={"PATH":"/usr/bin:/bin","HOME":"/root","PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD":"1"})
    link=CODE/"repository/node_modules"
    if link.exists() or link.is_symlink():
        if not link.is_symlink() or link.readlink()!=Path("apps/worker/node_modules"):
            raise ValueError("Unexpected native repository dependency path")
    else:link.symlink_to("apps/worker/node_modules",target_is_directory=True)
    # Ubuntu's Node may omit its optional TypeScript support. Compile using the
    # frozen TypeScript dependency instead of replacing the OS Node executable.
    execute(["/usr/bin/node",str(worker/"node_modules/typescript/bin/tsc"),"-p",str(worker/"tsconfig.native.json")],cwd=worker)
    execute(["npm","prune","--omit=dev","--ignore-scripts","--no-audit","--no-fund"],cwd=worker)
    cache=CODE/"playwright-browsers";cache.mkdir(mode=0o755,exist_ok=True)
    root_path(cache,directory=True)
    execute(["/usr/bin/node",str(worker/"node_modules/playwright/cli.js"),"install","--with-deps","chromium"],
        env={"PATH":"/usr/local/bin:/usr/bin:/bin","HOME":"/root","PLAYWRIGHT_BROWSERS_PATH":str(cache)},timeout=1800)
    for entry in (cache,*cache.rglob("*")):
        if entry.is_symlink():continue
        entry.chmod(0o755 if entry.is_dir() or entry.stat().st_mode&0o111 else 0o644)
    prepare_browser_policy(worker,cache)
    execute([str(python),"-m","venv",str(CODE/"venv")])
    execute([str(CODE/"venv/bin/python"),"-m","pip","install","--disable-pip-version-check","-r",str(CODE/"requirements.txt")])
    execute([str(CODE/"venv/bin/python"),"-I","-c","import faster_whisper,ctranslate2,pptx,docx,openpyxl; assert 'int8' in ctranslate2.get_supported_compute_types('cpu')"],timeout=60)
    install_gog(plan["gog"])
    Path("/usr/local/sbin").mkdir(mode=0o755,exist_ok=True)
    write_atomic(Path("/usr/local/sbin/okami-backup-receive"),(Path(plan["source"])/"scripts/backup_receive.py").read_bytes(),0o755)
    write_atomic(Path("/usr/local/sbin/okami-backup-native"),(Path(plan["source"])/"scripts/backup_native_remote.py").read_bytes(),0o755)
    if plan["asrModel"]["download"]:
        if MODEL.exists():raise ValueError("Model already exists; validate/reuse it rather than overwrite")
        no_links(MODEL);root_path(next(parent for parent in MODEL.parents if parent.exists()),directory=True)
        MODEL.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        command="from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-small',revision='"+MODEL_REVISION+"',local_dir='"+str(MODEL)+"',allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.*','preprocessor_config.json'])"
        execute([str(CODE/"venv/bin/python"),"-I","-c",command],timeout=3600)
        for entry in (MODEL,*MODEL.rglob("*")):
            if entry.is_symlink():raise ValueError("Model snapshot contains a symlink")
        publish_runtime_permissions(MODEL)
        for parent in (MODEL.parent,MODEL.parent.parent):
            root_path(parent,directory=True);parent.chmod(0o755)
    publish_runtime_permissions(CODE)
    # Workspace provisioning is scoped to the existing registered home, never chown -R.
    sys.path.insert(0,str(CODE))
    from deployment.users.provision import apply_workspace
    apply_workspace(plan["account"],new_account=False,tighten_home=False)
    write_atomic(CONFIG/"firewall.nft",plan["firewall"].encode())
    for name,content in plan["units"].items():write_atomic(Path("/etc/systemd/system")/name,content.encode(),0o644)
    execute(["systemd-analyze","verify",*[str(Path("/etc/systemd/system")/name) for name in plan["units"] if name.endswith(".service")]],timeout=60)
    execute(["systemctl","daemon-reload"],timeout=60)
    write_atomic(CONFIG/"installed-plan.json",json.dumps(plan,indent=2).encode())


def activate(plan):
    executor=plan["executorId"]
    installed=json.loads(root_path(CONFIG/"installed-plan.json",private=True).read_text())
    if installed!=plan:raise ValueError("Prepare this exact reviewed plan before activation")
    # This is deliberately separate from preparation: root must verify SSH/RDP
    # reply rules and Tailscale grants on the actual hosts before this command.
    execute(["nft","--check","--file",str(CONFIG/"firewall.nft")],timeout=30)
    execute(["systemctl","enable","--now","okami-firewall.service"],timeout=60)
    execute(["systemctl","enable","--now",f"okami-session@{executor}.service"],timeout=60)
    execute(["systemctl","enable","--now",f"okami-executor@{executor}.service"],timeout=60)
    target=Path("/etc/systemd/system/sleep.target.d")
    target.mkdir(mode=0o755,exist_ok=True)
    write_atomic(target/"okami-executor.conf",("[Unit]\nRequires=okami-suspend@"+executor+".service\nAfter=okami-suspend@"+executor+".service\n").encode(),0o644)
    execute(["systemctl","daemon-reload"],timeout=60)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation",choices=("plan","prepare","activate","preflight-python"))
    parser.add_argument("--source",type=Path);parser.add_argument("--inputs",type=Path)
    parser.add_argument("--output",type=Path);parser.add_argument("--plan",type=Path)
    parser.add_argument("--memory-total-bytes",type=int)
    parser.add_argument("--media-python",default="/usr/bin/python3")
    parser.add_argument("--with-asr-model",action="store_true",help="Include the pinned small model download in the reviewed preparation plan")
    args=parser.parse_args();os.umask(0o077)
    try:
        if args.operation=="preflight-python":
            if os.geteuid()!=0:raise ValueError("Python preflight checks root-owned compatible input")
            if not args.source:raise ValueError("Choose the reviewed source requirements")
            preflight_python(args.media_python,args.source/"apps/computer/requirements.txt")
            print(json.dumps({"pythonWheelPreflight":True,"operatingSystemPythonChanged":False}));return 0
        if args.operation=="plan":
            if not all((args.source,args.inputs,args.output,args.memory_total_bytes)):parser.error("plan requires source, inputs, output and measured memory total")
            plan=build_plan(args.source,args.inputs,args.memory_total_bytes,args.media_python,args.with_asr_model)
            args.output.write_text(json.dumps(plan,indent=2)+"\n");args.output.chmod(0o600)
            print("Native plan prepared; credential values omitted. Review the plan before root preparation/activation.")
        else:
            if os.geteuid()!=0:raise ValueError("Preparation and activation require the operator's root execution")
            if not args.plan:parser.error("prepare/activate require --plan")
            plan=checked_plan(args.plan)
            (prepare if args.operation=="prepare" else activate)(plan)
            print("Native "+args.operation+" completed; existing account, sudo, SSH and RDP were preserved.")
    except (ValueError,OSError,KeyError,subprocess.SubprocessError,tarfile.TarError):
        print("Native installation failed; inspect the private plan and dependencies. No credential diagnostics are printed.",file=sys.stderr)
        sys.exit(1)


if __name__=="__main__":main()
