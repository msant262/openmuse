#!/usr/bin/env python3
"""MIT. Actual pinned OpenBao: isolated Raft init/restart/snapshot/restore/sealed proof.

Uses only local temporary state and loopback listeners, never production tokens,
services, models or accounts. Key material and HTTP responses are never printed.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def port():
    with socket.socket() as sock:sock.bind(("127.0.0.1",0));return sock.getsockname()[1]


def request(origin,path,body=None,token=None,raw=False):
    data=body if isinstance(body,bytes) else None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(origin+"/v1/"+path,data=data,
        headers={"Content-Type":"application/octet-stream" if isinstance(body,bytes) else "application/json",
                 **({"X-Vault-Token":token} if token else {})})
    # A single-node Raft initialization can wait for its first election. Do not
    # cancel it at the short health-poll timeout or assume its outcome.
    timeout=45 if path in ("sys/init","sys/storage/raft/snapshot-force") else 2 if path=="sys/health" else 15
    try:response=urllib.request.urlopen(req,timeout=timeout)
    except urllib.error.HTTPError as error:
        if path!="sys/health":raise
        response=error
    with response:data=response.read()
    return data if raw else json.loads(data) if data else {}


def wait_health(origin,process,ready=True,timeout=40):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if process.poll() is not None:raise ValueError("Pinned vault process stopped")
        try:
            status=request(origin,"sys/health")
            if not ready or status.get("initialized") and not status.get("sealed"):return status
        except (OSError,ValueError):pass
        time.sleep(.1)
    raise ValueError("Pinned vault did not reach its expected health state")


def validate(binary):
    version=subprocess.run([str(binary),"version"],capture_output=True,text=True,check=True,timeout=5).stdout.strip()
    if not version.startswith("OpenBao v2.7.1"):raise ValueError("Verifier requires the Compose-pinned OpenBao 2.7.1")
    with tempfile.TemporaryDirectory(prefix="okami-static-seal-") as temp:
        root=Path(temp);root.chmod(0o700);(root/"raft").mkdir(mode=0o700)
        key=root/"seal.key";key.write_bytes(secrets.token_bytes(32));key.chmod(0o600)
        api_port,cluster_port=port(),port();origin=f"http://127.0.0.1:{api_port}"
        config=root/"openbao.hcl"
        config.write_text(f'''ui = false
disable_mlock = true
api_addr = "{origin}"
cluster_addr = "http://127.0.0.1:{cluster_port}"
storage "raft" {{ path = "{root/'raft'}" node_id = "isolated-verification" }}
listener "tcp" {{ address = "127.0.0.1:{api_port}" cluster_address = "127.0.0.1:{cluster_port}" tls_disable = true }}
seal "static" {{ current_key_id = "isolated-1" current_key = "file://{key}" }}
''');config.chmod(0o600)
        log=root/"process.log"
        @contextlib.contextmanager
        def server():
            with log.open("ab") as output:
                process=subprocess.Popen([str(binary),"server","-config="+str(config)],stdout=output,stderr=output,
                    env={"PATH":"/usr/bin:/bin","HOME":str(root)},start_new_session=True)
                try:yield process
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:process.wait(timeout=10)
                        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        with server() as process:
            wait_health(origin,process,ready=False)
            init=request(origin,"sys/init",{"recovery_shares":1,"recovery_threshold":1})
            token=init["root_token"]  # Local fixture only; never logged or persisted.
            wait_health(origin,process)
            request(origin,"sys/mounts/secret",{"type":"kv","options":{"version":"2"}},token)
            original="fixture-"+secrets.token_hex(16)
            request(origin,"secret/data/receipt",{"data":{"value":original}},token)
            snapshot=request(origin,"sys/storage/raft/snapshot",token=token,raw=True)
            request(origin,"secret/data/receipt",{"data":{"value":"later fixture revision"}},token)
            assert request(origin,"secret/data/receipt",token=token)["data"]["data"]["value"]!=original
        with server() as process:
            health=wait_health(origin,process)
            assert health["sealed"] is False and health["version"]=="2.7.1"
            request(origin,"sys/storage/raft/snapshot-force",snapshot,token)
            wait_health(origin,process)
            deadline=time.monotonic()+10
            while True:
                try:
                    restored=request(origin,"secret/data/receipt",token=token)["data"]["data"]["value"]
                    if restored==original:break
                except (OSError,KeyError):pass
                if time.monotonic()>deadline:raise ValueError("Actual Raft restore did not recover the fixture")
                time.sleep(.1)
        key.write_bytes(secrets.token_bytes(32))
        blocked=False
        with server() as process:
            try:
                status=wait_health(origin,process,ready=False,timeout=4)
                blocked=status.get("sealed") is True
            except ValueError:blocked=True  # No healthy credential endpoint with the wrong key.
        if not blocked:raise ValueError("Incorrect static seal material did not fail closed")
        return {"version":"2.7.1","mode":"isolated-loopback-raft-static-seal",
            "autoUnsealAfterRestart":True,"snapshotRestoredOriginalValue":True,
            "wrongSealKeyBlocked":True,"productionServicesChanged":False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--bao-binary",type=Path,required=True)
    args=parser.parse_args()
    try:print(json.dumps(validate(args.bao_binary),indent=2));return 0
    except (OSError,ValueError,AssertionError,KeyError,subprocess.SubprocessError):
        print(json.dumps({"verified":False,"error":"Isolated pinned OpenBao validation failed; no secret diagnostics are printed"}));return 1


if __name__=="__main__":raise SystemExit(main())
