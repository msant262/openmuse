#!/usr/bin/env python3
"""MIT. Local 24-hour metadata collector; no credentials, prompts, frames or effects."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time
import urllib.parse
import urllib.request

from deployment_backup import private_path
from verify_hybrid import memory_info


def read_number(path):
    try:return int(Path(path).read_text().strip())
    except (OSError,ValueError):return None


def cgroup_memory(path):
    path=Path(path)
    return {"currentBytes":read_number(path/"memory.current"),"peakBytes":read_number(path/"memory.peak"),
        "events":read_fields(path/"memory.events")}


def read_fields(path):
    try:return {parts[0]:int(parts[1]) for parts in (line.split() for line in Path(path).read_text().splitlines()) if len(parts)==2}
    except (OSError,ValueError):return {}


def command(argv):
    return subprocess.run(argv,check=True,capture_output=True,text=True,timeout=10).stdout.strip()


def managed_containers(settings):
    if not settings.get("projectDir"):return {}
    project=Path(settings["projectDir"])
    base=["docker","compose","--project-directory",str(project),"--env-file",settings["envFile"],
        "-f",str(project/"docker-compose.yml"),"-f",str(project/"deploy/compose.hybrid.yml")]
    result={}
    for name in ("server","browser","openbao"):
        try:
            ids=command(base+["ps","--quiet",name]).splitlines()
            if len(ids)!=1:raise ValueError("Expected one managed container")
            pid=int(command(["docker","inspect","--format","{{.State.Pid}}",ids[0]]))
            if pid<=0:raise ValueError("Managed container is stopped")
            rows=Path(f"/proc/{pid}/cgroup").read_text().splitlines()
            relative=next(row[3:] for row in rows if row.startswith("0::"))
            result[name]=cgroup_memory(Path("/sys/fs/cgroup")/relative.lstrip("/"))
        except (OSError,ValueError,StopIteration,subprocess.SubprocessError):result[name]={"unavailable":True}
    return result


def sample(settings,elapsed):
    mem=memory_info()
    row={"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"elapsedSeconds":elapsed,
        "host":settings["host"],"memoryTotalBytes":mem["MemTotal"],"memoryAvailableBytes":mem["MemAvailable"],
        "swapTotalBytes":mem.get("SwapTotal",0),"swapFreeBytes":mem.get("SwapFree",0),
        "load":list(os.getloadavg()),"managed":{}}
    if settings["host"]=="lenovo":
        row["managed"]["bots"]=cgroup_memory("/sys/fs/cgroup/okami.slice/okami-bots.slice")
    else:
        row["managed"]["hermes"]=cgroup_memory("/sys/fs/cgroup/system.slice/hermes-gateway.service")
        row["managed"].update(managed_containers(settings))
    temperatures=[read_number(path) for path in Path("/sys/class/thermal").glob("thermal_zone*/temp")]
    row["temperatureCelsius"]=max((value/1000 for value in temperatures if value is not None and 0<value<150000),default=None)
    row["pressure"]={}
    for name in ("cpu","memory","io"):
        try:
            lines=Path("/proc/pressure").joinpath(name).read_text().splitlines()
            row["pressure"][name]={line.split()[0]:{k:float(v) for k,v in (part.split("=",1) for part in line.split()[1:])} for line in lines}
        except (OSError,ValueError):row["pressure"][name]={}
    start=time.monotonic()
    try:
        request=urllib.request.Request(settings["healthOrigin"].rstrip("/")+"/api/health")
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*_):raise ValueError("Health probe must not redirect")
        with urllib.request.build_opener(NoRedirect).open(request,timeout=5) as response:
            row["apiReachable"]=response.status==200
        row["apiHealthRoundTripMs"]=(time.monotonic()-start)*1000
    except (OSError,ValueError):row["apiReachable"]=False;row["apiHealthRoundTripMs"]=None
    return row


def report(rows,duration=86400,interval=60):
    if not rows:raise ValueError("No samples recorded")
    span=max(row["elapsedSeconds"] for row in rows)-min(row["elapsedSeconds"] for row in rows)
    expected=math.ceil(duration/interval)+1
    latencies=sorted(row["apiHealthRoundTripMs"] for row in rows if row.get("apiHealthRoundTripMs") is not None)
    available=[row["memoryAvailableBytes"] for row in rows]
    temperature=[row["temperatureCelsius"] for row in rows if row.get("temperatureCelsius") is not None]
    gaps=[b["elapsedSeconds"]-a["elapsedSeconds"] for a,b in zip(rows,rows[1:])]
    managed={}
    for row in rows:
        for name,metrics in row["managed"].items():
            item=managed.setdefault(name,{"peakBytes":None,"unavailableSamples":0,"oomKillCount":0})
            if metrics.get("currentBytes") is None:item["unavailableSamples"]+=1
            else:item["peakBytes"]=max(item["peakBytes"] or 0,metrics["currentBytes"],metrics.get("peakBytes") or 0)
            item["oomKillCount"]=max(item["oomKillCount"],metrics.get("events",{}).get("oom_kill",0))
    complete=span>=duration and len(rows)>=expected*.95 and max(gaps,default=0)<=interval*2
    return {"format":1,"host":rows[0]["host"],"samples":len(rows),"spanSeconds":span,
        "requestedDurationSeconds":duration,"coverage":min(1,len(rows)/expected),"completedRequestedSoak":complete,
        "completed24Hours":complete and duration>=86400,"apiFailures":sum(not row["apiReachable"] for row in rows),
        "apiHealthRoundTripP95Ms":latencies[math.ceil(.95*len(latencies))-1] if latencies else None,
        "minimumAvailableMemoryBytes":min(available),"maximumTemperatureCelsius":max(temperature,default=None),"managed":managed,
        "pendingPhysicalMeasurements":["desktop input ACK p95","chat latency with and without load","provider and network latency separately",
            "five light sessions","workload above 8 GB","phone push and restart/Wi-Fi recovery"],
        "effectsDispatched":False}


def collect(settings,directory,duration,interval):
    directory=private_path(directory,directory=True,create=True)
    name="soak-"+settings["host"]+"-"+datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path=directory/(name+".jsonl");rows=[];start=time.monotonic();deadline=start+duration;next_sample=start
    with path.open("x") as stream:
        path.chmod(0o600)
        while True:
            time.sleep(max(0,next_sample-time.monotonic()))
            row=sample(settings,time.monotonic()-start);rows.append(row)
            stream.write(json.dumps(row,separators=(",",":"))+"\n");stream.flush();os.fsync(stream.fileno())
            if time.monotonic()>=deadline:break
            next_sample=min(deadline,max(next_sample+interval,time.monotonic()))
    result=report(rows,duration,interval)
    result["samplesSha256"]=hashlib.sha256(path.read_bytes()).hexdigest()
    summary=path.with_suffix(".report.json");summary.write_text(json.dumps(result,indent=2));summary.chmod(0o600)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation",choices=("collect","report"));parser.add_argument("--config",type=Path)
    parser.add_argument("--samples",type=Path);parser.add_argument("--directory",type=Path,default=Path("/var/lib/okami-soak"))
    parser.add_argument("--duration-seconds",type=int,default=86400);parser.add_argument("--interval-seconds",type=int,default=60)
    args=parser.parse_args()
    try:
        if not 1<=args.duration_seconds<=604800 or not 1<=args.interval_seconds<=300 or math.ceil(args.duration_seconds/args.interval_seconds)>10080:
            raise ValueError("Invalid bounded sampling interval/duration or excessive sample count")
        if args.operation=="report":
            if not args.samples:raise ValueError("Choose one private JSONL capture")
            source=private_path(args.samples)
            if source.stat().st_size>64*1024**2:raise ValueError("Capture exceeds the report memory budget")
            rows=[json.loads(line) for line in source.read_text().splitlines()]
            result=report(rows,args.duration_seconds,args.interval_seconds)
        else:
            if not args.config:raise ValueError("Configure the existing host and private health origin")
            settings=json.loads(private_path(args.config).read_text())
            origin=urllib.parse.urlsplit(settings["healthOrigin"])
            if settings.get("host") not in ("vps","lenovo") or origin.scheme not in ("http","https") or origin.username or origin.password or origin.path not in ("","/") or origin.query or origin.fragment:
                raise ValueError("Invalid host/health origin; no secrets or query strings")
            result=collect(settings,args.directory,args.duration_seconds,args.interval_seconds)
        print(json.dumps(result,indent=2));return 0
    except (OSError,ValueError,KeyError,subprocess.SubprocessError):
        print(json.dumps({"completed24Hours":False,"error":"Local metadata collection failed; no secret diagnostics are printed"}));return 1


if __name__=="__main__":raise SystemExit(main())
