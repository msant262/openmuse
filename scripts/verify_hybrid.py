#!/usr/bin/env python3
"""MIT. Read-only hybrid deployment checks. Print metadata and failures, never env values."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

GIB=1024**3
# Bound the nominal host budget by actual MemTotal as well. OS and Hermes
# headroom are already explicit reservations in the summed budget below.
RAM_CEILING=8*GIB
HERMES_RESERVE=2304*1024**2
OS_RESERVE=GIB


def command(argv,timeout=30):
    return subprocess.run(argv,check=True,capture_output=True,text=True,timeout=timeout).stdout.strip()


def memory_info(path="/proc/meminfo"):
    return {key:int(value.split()[0])*1024 for key,value in
            (line.split(":",1) for line in Path(path).read_text().splitlines()) if value.strip().endswith("kB")}


def bytes_value(value):
    if isinstance(value,int) and value>=0:return value
    found=re.fullmatch(r"([0-9]+)([kKmMgG]?)",str(value))
    if not found:raise ValueError("Unknown Compose memory limit")
    return int(found[1])*1024**("kmg".find(found[2].lower())+1 if found[2] else 0)


def vps_budget(compose,mem,hermes,include_legacy=False,allocated=None):
    services=compose["services"]
    active={name:item for name,item in services.items() if include_legacy or not item.get("profiles")}
    if set(active)!=(set(services) if include_legacy else {"server","browser","openbao"}):
        raise ValueError("Unexpected hybrid service/profile set")
    limits={name:bytes_value(item["mem_limit"]) for name,item in active.items()}
    errors=[]
    for name,item in active.items():
        if bytes_value(item.get("memswap_limit",0))!=limits[name]:errors.append(name+": container swap must be disabled")
    if limits.get("browser")!=2*GIB:errors.append("Browser fallback must retain the reviewed 2 GiB cap")
    if not hermes.get("active"):errors.append("Existing Hermes service is not active; do not replace or stop it")
    existing=max(HERMES_RESERVE,hermes.get("current",0),hermes.get("peak",0))
    total=sum(limits.values())+existing+OS_RESERVE
    if total>min(RAM_CEILING,mem["MemTotal"]):errors.append("Services + measured Hermes reserve + OS reserve exceed the RAM ceiling")
    # Warm inspection subtracts only current kernel-accounted memory of the
    # same managed services. Cold admission has no such allocation to subtract.
    allocated=allocated or {}
    committed=sum(min(limits[name],max(0,allocated.get(name,0))) for name in limits)
    headroom=sum(limits.values())-committed+OS_RESERVE
    if mem["MemAvailable"]<headroom:errors.append("Measured available RAM cannot admit the remaining reviewed service headroom")
    if mem.get("SwapTotal",0)<4*GIB-os.sysconf("SC_PAGE_SIZE"):
        errors.append("The reviewed 4 GiB host swap has not been provisioned; swap adds no admission capacity")
    return {"ready":not errors,"serviceCapsBytes":limits,"hermesReserveBytes":existing,
        "osReserveBytes":OS_RESERVE,"budgetBytes":total,"ceilingBytes":RAM_CEILING,
        "memoryTotalBytes":mem["MemTotal"],"memoryAvailableBytes":mem["MemAvailable"],
        "swapTotalBytes":mem.get("SwapTotal",0),"managedAllocatedBytes":committed,"requiredAvailableBytes":headroom,"errors":errors}


def allocated_memory(project,env_file,limits):
    base=["docker","compose","--project-directory",str(project),"--env-file",str(env_file),
        "-f",str(project/"docker-compose.yml"),"-f",str(project/"deploy/compose.hybrid.yml")]
    allocated={}
    for name,limit in limits.items():
        ids=command(base+["ps","--quiet",name]).splitlines()
        if not ids:continue
        if len(ids)!=1:raise ValueError("Expected at most one managed service container")
        record=json.loads(command(["docker","inspect","--format","{{json .}}",ids[0]]))
        if record["HostConfig"]["Memory"]!=limit or record["HostConfig"]["MemorySwap"]!=limit:
            raise ValueError("Running service memory/swap caps differ from reviewed Compose")
        if record["State"]["Running"]:
            pid=int(record["State"]["Pid"])
            relative=next(row[3:] for row in Path(f"/proc/{pid}/cgroup").read_text().splitlines() if row.startswith("0::"))
            allocated[name]=int((Path("/sys/fs/cgroup")/relative.lstrip("/")/"memory.current").read_text())
    return allocated


def compose_config(project,env_file):
    return json.loads(command(["docker","compose","--project-directory",str(project),"--env-file",str(env_file),
        "-f",str(project/"docker-compose.yml"),"-f",str(project/"deploy/compose.hybrid.yml"),"config","--format","json"]))


def vps_check(args):
    project=args.project_dir.resolve(strict=True)
    compose=compose_config(project,args.env_file)
    state=dict(line.split("=",1) for line in command(["systemctl","show",args.hermes_unit,
        "--property=ActiveState,MemoryCurrent,MemoryPeak"]).splitlines() if "=" in line)
    hermes={"active":state.get("ActiveState")=="active",
        "current":int(state.get("MemoryCurrent","0")),"peak":int(state.get("MemoryPeak","0"))}
    active={name:item for name,item in compose["services"].items() if args.include_legacy or not item.get("profiles")}
    limits={name:bytes_value(item["mem_limit"]) for name,item in active.items()}
    report=vps_budget(compose,memory_info(),hermes,args.include_legacy,allocated_memory(project,args.env_file,limits))
    environment=compose["services"]["server"]["environment"]
    if environment.get("COMPUTER_BACKEND")!="native" or environment.get("TASK_WORKER_ENABLED") not in ("true",True):
        report["errors"].append("Hybrid mode needs one API/PGlite task writer with the native computer backend")
    if environment.get("DATABASE_URL"):report["errors"].append("This backup contract requires embedded PGlite")
    image=compose["services"]["openbao"]["image"]
    if image!="openbao/openbao:2.7.1":report["errors"].append("OpenBao image differs from the validated static-seal version")
    report["openbaoImage"]=image
    # Localhost/Tailscale binds only; public 0.0.0.0 publication is not generated.
    for port in compose["services"]["server"].get("ports",[]):
        address=port.get("host_ip","")
        if address!="127.0.0.1" and not re.fullmatch(r"100\.(?:6[4-9]|[789][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+",address):
            report["errors"].append("API publication must bind localhost or the existing Tailscale address")
    if args.check_vault:
        base=["docker","compose","--project-directory",str(project),"--env-file",str(args.env_file),
            "-f",str(project/"docker-compose.yml"),"-f",str(project/"deploy/compose.hybrid.yml")]
        report["openbaoVersion"]=command(base+["exec","-T","openbao","bao","version"])
        # Status exit 2 denotes sealed: capture/parse it without treating it as success.
        result=subprocess.run(base+["exec","-T","openbao","env","BAO_ADDR=http://127.0.0.1:8200","bao","status","-format=json"],
                              capture_output=True,text=True,timeout=30)
        status=json.loads(result.stdout)
        report["vault"]={key:status.get(key) for key in ("initialized","sealed","version","storage_type")}
        if status.get("sealed") is not False or not status.get("initialized"):
            report["errors"].append("Credential vault is sealed/uninitialized; authenticated work must wait")
    report["ready"]=not report["errors"]
    return report


def native_check(args):
    sys.path.insert(0,str(args.native_code))
    from executor.user_session import UserSession,root_owned_json
    from desktop.client import DesktopClient
    registry=root_owned_json(args.native_config/"users.json")
    import hashlib
    browser=root_owned_json(args.native_config/"browser-runtime.json")
    pinned_paths=[(browser["executable"],browser["sha256"])]
    if browser.get("profile"):pinned_paths.append((browser["profile"],browser["profileSha256"]))
    for path,expected in pinned_paths:
        with Path(path).open("rb") as stream:actual=hashlib.file_digest(stream,"sha256").hexdigest()
        if actual!=expected:raise ValueError("Pinned native browser/policy changed since installation")
    sessions=UserSession(registry)
    report={"ready":True,"accounts":[],"errors":[]}
    for executor_id,account in registry.items():
        status=sessions.preflight(executor_id)
        report["accounts"].append({"executorId":executor_id,"trustMode":status["trustMode"],
            "containmentGuaranteed":status["containmentGuaranteed"],"unmanagedProcessCount":len(status["escapePids"]),
            "state":status["state"]})
        if status["state"]!="ready":report["errors"].append("Registered account/workspace preflight is unavailable")
        for unit in (f"okami-session@{executor_id}.service",f"okami-executor@{executor_id}.service"):
            if command(["systemctl","is-active",unit])!="active":report["errors"].append("Managed native unit is unavailable")
        live=DesktopClient(executor_id,account).status()
        desktop={kind:live.get(kind,{}).get("state","unavailable") for kind in ("display","capture","input","browser")}
        report["accounts"][-1]["desktop"]=desktop
        if any(state!="ready" for state in desktop.values()):report["errors"].append("Real headed Chromium or native desktop preflight is unavailable")
    for executable in ("/usr/bin/node","/usr/bin/xdotool","/usr/bin/ffmpeg","/usr/bin/libreoffice","/usr/local/bin/gog"):
        if not Path(executable).is_file():report["errors"].append("Required native executable is missing: "+Path(executable).name)
    media=args.native_code/"venv/bin/python"
    command([str(media),"-I","-c","import faster_whisper,ctranslate2,pptx,docx,openpyxl; assert 'int8' in ctranslate2.get_supported_compute_types('cpu')"],timeout=60)
    model=Path("/opt/openmuse/models/whisper-small")
    if not (model/"model.bin").is_file():report["errors"].append("Pinned offline Whisper small model is not installed")
    elif args.check_asr_model:
        command([str(media),"-I","-c","from faster_whisper import WhisperModel; WhisperModel('/opt/openmuse/models/whisper-small',device='cpu',compute_type='int8',cpu_threads=2,num_workers=1,local_files_only=True)"],timeout=120)
        report["asrModelLoad"]="cpu-int8-local-only"
    report["ready"]=not report["errors"]
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host",choices=("vps","lenovo"),required=True)
    parser.add_argument("--project-dir",type=Path,default=Path("/opt/openmuse"))
    parser.add_argument("--env-file",type=Path,default=Path("/opt/openmuse/.env"))
    parser.add_argument("--hermes-unit",default="hermes-gateway.service")
    parser.add_argument("--include-legacy",action="store_true")
    parser.add_argument("--check-vault",action="store_true")
    parser.add_argument("--native-code",type=Path,default=Path("/opt/okami-computer"))
    parser.add_argument("--native-config",type=Path,default=Path("/etc/okami-executor"))
    parser.add_argument("--check-asr-model",action="store_true")
    args=parser.parse_args()
    try:report=(vps_check if args.host=="vps" else native_check)(args)
    except (OSError,ValueError,KeyError,StopIteration,subprocess.SubprocessError):
        report={"ready":False,"errors":["Read-only deployment inspection failed; inspect protected config, dependencies and service state locally"]}
    print(json.dumps(report,indent=2));return 0 if report["ready"] else 1


if __name__=="__main__":sys.exit(main())
