"""Fixed-account Unix broker. Root's M6 gate supplies bounded live permits.

Xvnc remains view-only even for raw RFB clients. Every input event is checked
against this permit and the shared server control revision. Same-UID access and
broad sudo remain full-trust limitations, not containment guarantees.
"""
import argparse
import datetime
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import time
import uuid

from .driver import DesktopDriver, integer
from .session import NativeSession, SessionConfig, private_directory

MAX_MESSAGE = 12 * 1024 * 1024


class DesktopOperationError(ValueError):
    def __init__(self, message, *, code="DESKTOP_FAILED", dispatched=False, cleanup_confirmed=False):
        super().__init__(message)
        self.code,self.dispatched,self.cleanup_confirmed=code,dispatched,cleanup_confirmed


def boottime():
    return time.clock_gettime(getattr(time, "CLOCK_BOOTTIME", time.CLOCK_MONOTONIC))


def read_exact(stream, size):
    output = bytearray()
    while len(output) < size:
        value = stream.recv(size-len(output))
        if not value:raise ValueError("Private broker connection closed")
        output.extend(value)
    return bytes(output)


def exchange(path, payload, *, expected_uid=None, timeout=45):
    path=Path(path)
    if not path.is_absolute() or path.resolve()!=path:
        raise ValueError("Private broker path must be registered without symlinks")
    info=path.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_mode & 0o077 or expected_uid is not None and info.st_uid!=expected_uid:
        raise ValueError("Private broker socket ownership/permissions changed")
    data=json.dumps(payload,ensure_ascii=False).encode()
    if len(data)>MAX_MESSAGE:raise ValueError("Private broker message exceeds its bounded size")
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout);connection.connect(str(path))
        if expected_uid is not None:
            _,uid,_=struct.unpack("3i",connection.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
            if uid!=expected_uid:raise ValueError("Private broker peer UID changed")
        connection.sendall(struct.pack("!I",len(data))+data)
        size=struct.unpack("!I",read_exact(connection,4))[0]
        if not 0<size<=MAX_MESSAGE:raise ValueError("Private broker response exceeds its bounded size")
        result=json.loads(read_exact(connection,size))
        if result.get("error"):
            error=result["error"]
            if isinstance(error,dict):
                raise DesktopOperationError(error.get("message","Native operation failed"),code=error.get("code","DESKTOP_FAILED"),dispatched=error.get("dispatched",True),cleanup_confirmed=error.get("cleanupConfirmed",False))
            raise DesktopOperationError("Private broker operation failed",dispatched=True)
        return result["data"]


class DesktopBroker:
    def __init__(self, executor_id, host_id, session, driver, *, browser=None, clock=boottime):
        self.executor_id,self.host_id,self.session,self.driver=executor_id,host_id,session,driver
        self.browser,self.clock=browser,clock
        self.control,self.control_revision,self.grant_id="agent",0,None
        self.epoch,self.open,self.reconciled,self.deadline=0,False,False,0
        self.fences,self.masks={},[]
        self.sequence=0
        self.state_lock=threading.RLock()

    def update_gate(self, value):
        integer(value["epoch"],1,2**53-1)
        if type(value.get("open")) is not bool or type(value.get("reconciled")) is not bool or not 0 < value.get("ttl",0) <= 2:
            raise ValueError("Invalid native desktop gate permit")
        with self.state_lock:
            changed=value["epoch"]!=self.epoch or not value["open"]
            self.epoch,self.open,self.reconciled=value["epoch"],value["open"],value["reconciled"]
            self.deadline=self.clock()+value["ttl"]
        if self.browser:self.browser.gate(value)
        if changed:self.driver.invalidate()
        return {"accepted":True}

    def protect(self, masks, *, suspended=False):
        # Called only by trusted credential/session service code. No masks field
        # exists in the model or phone action schema.
        with self.state_lock:
            self.masks=list(masks)
            self.observation_suspended=suspended
        self.driver.invalidate()

    def authorize(self, operation, *, inspection=False, reset=False):
        with self.state_lock:
            if operation.get("executorId")!=self.executor_id or operation.get("executorEpoch")!=self.epoch:
                raise ValueError("Native desktop executor epoch changed")
            args=operation["args"]
            if args.get("sessionId")!=self.session["id"] or args.get("sessionGeneration")!=self.session["sessionGeneration"]:
                raise ValueError("Native desktop session generation changed")
            if self.clock()>=self.deadline or not self.reconciled or not self.open and not inspection and not reset:
                raise ValueError("Native desktop gate is closed")
            expiry=datetime.datetime.fromisoformat(operation["expiresAt"].replace("Z","+00:00")).timestamp()
            if expiry<=time.time():raise ValueError("Native desktop operation expired")
            resource=operation.get("resourceKey")
            expected="system-admin:"+self.host_id if inspection or reset else "desktop:"+self.executor_id+":"+self.session["id"]
            if resource!=expected:raise ValueError("Native desktop resource identity changed")
            fence=integer(operation.get("resourceFence"),0,2**53-1)
            if fence<self.fences.get(resource,0):raise ValueError("Native desktop resource fence is stale")
            self.fences[resource]=fence
            if not reset and args.get("controlRevision")!=self.control_revision:
                raise ValueError("Native desktop control revision changed")
            if not inspection and not reset:
                if args.get("actor")!=self.control:raise ValueError("Native desktop input belongs to another controller")
                if self.control=="human" and args.get("grantId")!=self.grant_id:
                    raise ValueError("Native desktop human grant changed")

    def perform(self, operation):
        progress={"dispatched":False,"cleanup":False}
        def dispatched():progress["dispatched"]=True
        def cleaned():progress["cleanup"]=True
        try:return self._perform(operation,dispatched,cleaned)
        except DesktopOperationError:raise
        except Exception as error:
            code="STALE_FRAME" if isinstance(error,ValueError) and any(word in str(error).lower() for word in ("frame","observe","expired","desktop changed")) else "BROWSER_CONTROLLED" if isinstance(error,ValueError) and any(word in str(error).lower() for word in ("control","gate","grant","epoch")) else "DESKTOP_FAILED"
            # Fixed diagnostics only; values from web pages/text never escape.
            raise DesktopOperationError("Native desktop authority/frame/input could not be confirmed",code=code,dispatched=progress["dispatched"],cleanup_confirmed=progress["cleanup"] or not progress["dispatched"]) from error

    def _perform(self, operation, dispatched, cleaned):
        args=operation["args"];kind=args.get("operation")
        inspection=(operation.get("kind")=="desktop" and kind=="observe" or operation.get("kind")=="browser" and kind in ("snapshot","images","read","inspect","agent-screenshot","screenshot","control","downloads","download"))
        reset=operation.get("kind")=="desktop" and kind=="reset"
        self.authorize(operation,inspection=inspection,reset=reset)
        if reset:
            if args.get("control") not in ("agent","human") or args["controlRevision"]<=self.control_revision:
                raise ValueError("Native desktop reset control revision is stale")
            with self.state_lock:
                self.control,self.control_revision,self.grant_id=args["control"],args["controlRevision"],args.get("grantId")
            # Revoke first, then wait until the active gesture releases inputs.
            dispatched()
            if self.browser:self.browser.reset(self.control,self.control_revision)
            self.driver.invalidate()
            cleaned()
            return {"reset":True,"cleanupConfirmed":True,"sessionGeneration":self.session["sessionGeneration"]}
        if kind=="observe" and operation.get("kind")=="desktop":
            if getattr(self,"observation_suspended",False):raise ValueError("Sensitive observation is suspended")
            if self.browser and self.masks:self.browser.refresh_protection()
            if getattr(self,"observation_suspended",False):raise ValueError("Sensitive observation is suspended")
            frame=self.driver.observe(authorize=lambda:self.authorize(operation,inspection=True),masks=self.masks,previous_image=args.get("previousImage"))
            with self.state_lock:
                self.sequence+=1
                return {**frame,"sequence":self.sequence}
        if kind=="act" and operation.get("kind")=="desktop":
            human=args.get("actor")=="human"
            return {**self.driver.act(args["binding"],args["action"],authorize=lambda:self.authorize(operation),human=human,allow_sensitive=human,before_event=dispatched,after_reset=cleaned),"cleanupConfirmed":True}
        if operation.get("kind")=="browser" and self.browser:
            if args.get("browserSessionId")!=self.session["browserSessionId"]:
                raise ValueError("Native browser profile belongs to another session")
            if getattr(self,"observation_suspended",False):
                raise ValueError("Native browser observations/input are suspended during credential injection")
            self.driver.invalidate()
            if not inspection:dispatched()
            result=self.browser.perform(operation)
            self.authorize(operation,inspection=inspection)
            if "image" in result:
                with self.state_lock:
                    self.sequence+=1;result["sequence"]=self.sequence
            return {**result,"cleanupConfirmed":True}
        raise ValueError("Unsupported registered desktop operation")

    def handle(self, peer_uid, payload):
        if payload.get("operation")=="protect" and self.browser and peer_uid==os.getuid() and isinstance(payload.get("token"),str) and hmac.compare_digest(payload["token"],self.browser.token):
            if payload.get("sessionId")!=self.session["id"] or payload.get("sessionGeneration")!=self.session["sessionGeneration"]:
                raise ValueError("Sensitive region belongs to another desktop generation")
            self.protect(payload["masks"],suspended=payload["suspended"])
            return {"protected":True}
        if peer_uid!=0:raise ValueError("Desktop broker accepts only the registered root supervisor")
        if payload.get("operation")=="gate":return self.update_gate(payload["gate"])
        if payload.get("operation")=="protect":
            if payload.get("sessionId")!=self.session["id"] or payload.get("sessionGeneration")!=self.session["sessionGeneration"]:
                raise ValueError("Sensitive region belongs to another desktop generation")
            self.protect(payload["masks"],suspended=payload["suspended"])
            return {"protected":True}
        if payload=={"operation":"status"}:
            return {"desktopSession":self.session,"display":{"state":"ready"},"capture":{"state":"ready"},
                    "input":{"state":"ready"},"browser":self.browser.status() if self.browser else {"state":"unavailable","reason":"Native headed browser adapter absent"}}
        if set(payload)=={"operation","envelope"} and payload["operation"]=="perform":return self.perform(payload["envelope"])
        raise ValueError("Unsupported private desktop broker operation")


class BrokerServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads=True
    def __init__(self,path,broker):
        self.broker=broker
        class Handler(socketserver.BaseRequestHandler):
            def handle(handler):
                try:
                    _,uid,_=struct.unpack("3i",handler.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    size=struct.unpack("!I",read_exact(handler.request,4))[0]
                    if not 0<size<=MAX_MESSAGE:raise ValueError("Desktop message exceeds limit")
                    result={"data":broker.handle(uid,json.loads(read_exact(handler.request,size)))}
                except Exception as error:
                    # Do not echo request values, typed text, window titles or
                    # arbitrary adapter diagnostics into receipts/logs.
                    result={"error":{"message":"Native desktop operation failed","code":getattr(error,"code","DESKTOP_FAILED"),"dispatched":getattr(error,"dispatched",False),"cleanupConfirmed":getattr(error,"cleanup_confirmed",False)}}
                encoded=json.dumps(result,ensure_ascii=False).encode()
                handler.request.sendall(struct.pack("!I",len(encoded))+encoded)
        super().__init__(str(path),Handler)
        os.chmod(path,0o600)


class NativeBrowser:
    def __init__(self, session, runtime, home, env, worker, channel="chrome", proxy_port=None):
        self.session,self.runtime,self.home,self.env,self.worker=session,runtime,home,env,worker
        self.process=None;self.token=secrets.token_hex(32);self.lock=threading.RLock()
        if channel not in ("chrome","chromium"):raise ValueError("Invalid trusted browser channel")
        self.channel=channel
        if proxy_port is not None and (type(proxy_port) is not int or not 1024<=proxy_port<=65535):
            raise ValueError("Invalid trusted browser proxy port")
        self.proxy_port=proxy_port
        self.socket=Path(runtime)/"browser.sock"
        self.last_gate=None
        self.last_control=None
    def start(self):
        with self.lock:
            if self.process and self.process.poll() is None:return
            self.socket.unlink(missing_ok=True)
            argv=["/usr/bin/node",*(["--experimental-transform-types"] if Path(self.worker).suffix==".ts" else []),str(self.worker)]
            self.process=subprocess.Popen(argv,stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=self.env,start_new_session=True)
            config={"token":self.token,"socket":str(self.socket),"dataDir":str(self.home/".okami/browser"),
                    "native":{"sessionId":self.session["browserSessionId"],"sessionGeneration":self.session["sessionGeneration"],
                    "profileId":self.session["profileId"],"display":self.env["DISPLAY"],"authority":self.env["XAUTHORITY"],"home":str(self.home),
                    "runtime":str(self.runtime),"dbus":self.env.get("DBUS_SESSION_BUS_ADDRESS"),"channel":self.channel}}
            config["native"].update({"width":self.session["width"],"height":self.session["height"]})
            if self.proxy_port is not None:config["native"]["proxyPort"]=self.proxy_port
            self.process.stdin.write(json.dumps(config).encode());self.process.stdin.close()
            deadline=time.monotonic()+40
            while not self.socket.exists():
                if self.process.poll() is not None or time.monotonic()>deadline:raise ValueError("Native browser failed its sandbox/runtime preflight")
                time.sleep(.05)
            if self.last_gate:self.gate(self.last_gate)
            if self.last_control:
                exchange(self.socket,{**self.last_control,"token":self.token},expected_uid=os.getuid())
    def call(self,payload):
        self.start()
        return exchange(self.socket,{**payload,"token":self.token},expected_uid=os.getuid())
    def status(self):
        try:return self.call({"operation":"status"})
        except Exception:return {"state":"unavailable","reason":"Native browser sandbox/runtime preflight unavailable"}
    def gate(self,value):
        self.last_gate=value
        if self.process and self.process.poll() is None and self.socket.exists():
            exchange(self.socket,{"operation":"gate","gate":value,"token":self.token},expected_uid=os.getuid(),timeout=5)
    def reset(self,control,revision):
        self.last_control={"operation":"reset","control":control,"controlRevision":revision}
        if self.process and self.process.poll() is None:
            exchange(self.socket,{**self.last_control,"token":self.token},expected_uid=os.getuid())
    def perform(self,operation):return self.call({"operation":"perform","envelope":operation})
    def refresh_protection(self):return self.call({"operation":"refresh-protection"})
    def close(self):
        if self.process:
            import signal
            try:os.killpg(self.process.pid,signal.SIGTERM);self.process.wait(timeout=10)
            except ProcessLookupError:pass
            except subprocess.TimeoutExpired:os.killpg(self.process.pid,signal.SIGKILL);self.process.wait(timeout=5)
            self.process=None
        self.socket.unlink(missing_ok=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--executor-id",required=True);parser.add_argument("--host-id",required=True)
    parser.add_argument("--session-id",required=True);parser.add_argument("--display",type=int,required=True)
    parser.add_argument("--runtime",type=Path,required=True);parser.add_argument("--home",type=Path,required=True)
    parser.add_argument("--profile-id",default="personal");parser.add_argument("--width",type=int,default=1280);parser.add_argument("--height",type=int,default=720)
    parser.add_argument("--browser-worker",type=Path,default=Path("/opt/okami-computer/browser-worker/src/native.ts"))
    parser.add_argument("--browser-channel",choices=("chrome","chromium"),default="chrome")
    parser.add_argument("--browser-proxy-port",type=int)
    args=parser.parse_args()
    if os.getuid()==0:raise RuntimeError("Desktop session must run under its registered bot UID")
    uuid.UUID(args.session_id)
    private_directory(args.runtime,os.getuid())
    native=NativeSession(SessionConfig(args.executor_id,os.getuid(),args.home,args.runtime,args.display,args.width,args.height))
    browser=None;server=None
    try:
        launched=native.start()
        os.environ.clear();os.environ.update(native.env)
        from .x11 import X11Device
        device=X11Device(launched["display"],launched["authorityPath"])
        device.preflight()
        session={"id":args.session_id,"sessionGeneration":native.generation,"browserSessionId":args.session_id,"profileId":args.profile_id,
                 "width":args.width,"height":args.height}
        browser=NativeBrowser(session,args.runtime,args.home,native.env,args.browser_worker,args.browser_channel,args.browser_proxy_port)
        broker=DesktopBroker(args.executor_id,args.host_id,session,DesktopDriver(device,native.generation),browser=browser)
        socket_path=args.runtime/"desktop.sock"
        socket_path.unlink(missing_ok=True)
        server=BrokerServer(socket_path,broker)
        import signal
        def stop(*_):threading.Thread(target=server.shutdown,daemon=True).start()
        for number in (signal.SIGTERM,signal.SIGINT):signal.signal(number,stop)
        server.serve_forever(poll_interval=.2)
    finally:
        if server:server.server_close()
        if browser:browser.close()
        native.close()
        (args.runtime/"desktop.sock").unlink(missing_ok=True)


if __name__=="__main__":main()
