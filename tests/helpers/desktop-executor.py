"""Connected test adapter: real M6 journal/gate/supervisor and desktop broker,
with a synthetic pixel/input device. This does not claim native UID/GUI proof."""
import json
import base64
import hashlib
import uuid
import sys
import threading
import time
from pathlib import Path
from executor.supervisor import Journal, Supervisor
from executor.files import Workspace
from desktop.broker import DesktopBroker
from desktop.driver import DesktopDriver

session=json.loads(sys.argv[2]);init=json.loads(sys.argv[3])
output_lock=threading.Lock();pending={};pending_lock=threading.Lock();counter=0
def send(value):
    with output_lock:print(json.dumps(value),flush=True)
class Transport:
    def request(self,route,body):
        global counter
        with pending_lock:
            counter+=1;key=counter;event=threading.Event();slot={"event":event};pending[key]=slot
        send({"rpc":key,"route":route,"body":body})
        if not event.wait(10):raise RuntimeError("Test protocol response timed out")
        with pending_lock:pending.pop(key,None)
        if "error" in slot:raise RuntimeError(slot["error"])
        return slot["data"]
class Device:
    def __init__(self):self.events=[];self.fail_reset=False;self.fail_browser=False;self.uploaded=None;self.dialog=None;self.dialog_responses=[]
    def capture(self):return session["width"],session["height"],b"\xee"*(session["width"]*session["height"]*3)
    def event(self,*event):
        self.events.append(event)
        if event==("button",1,True):send({"inputStarted":True});time.sleep(.025)
    def reset(self):
        self.events.append(("reset",))
        if self.fail_reset:raise RuntimeError("Fixture cannot confirm input release")
device=Device()
class Browser:
    def gate(self,*_):pass
    def reset(self,*_):pass
    def perform(self,operation):
        if device.fail_browser:
            from desktop.broker import DesktopOperationError
            raise DesktopOperationError("Fixture lost browser response",dispatched=True,cleanup_confirmed=False)
        kind=operation["args"]["operation"];body=operation["args"].get("body",{})
        csv=b"name,value\nfixture,42\n"
        download={"id":"22222222-2222-4222-8222-222222222222","name":"fixture.csv","size":len(csv),"mimeType":"text/csv","sha256":hashlib.sha256(csv).hexdigest()}
        if kind=="search":return {"query":body["query"],"status":"ok","sources":[{"title":"Fixture source","url":"https://example.org/source","snippet":"index result"}],"observedAt":"2026-10-03T00:00:00.000Z","truncated":False,"provenance":{"backend":"browser","provider":"duckduckgo-html","searchUrl":"https://html.duckduckgo.com/html/","sessionId":session["browserSessionId"],"fullPagesRead":False}}
        if kind=="images":return {"sessionId":session["browserSessionId"],"url":"https://example.org/images","observedAt":"2026-10-03T00:00:00.000Z","images":[{"src":"https://example.org/course.svg","alt":"Course cover","width":320,"height":180,"frameUrl":"https://example.org/images"}],"total":1,"nextOffset":None,"partial":False}
        if kind=="downloads":return {"downloads":[download],"failures":[]}
        if kind=="download":return {**download,"base64":base64.b64encode(csv).decode()}
        if kind in ("dialog", "reviewed-dialog"):
            if not device.dialog or body["dialogId"] != device.dialog["id"]:raise ValueError("Dialog changed")
            if body["accept"] and (kind != "reviewed-dialog" or not body.get("approvalId")):raise ValueError("Approval missing")
            device.dialog_responses.append({"dialogId":body["dialogId"],"accept":body["accept"]})
            device.dialog=None
            return {"sessionId":session["browserSessionId"],"snapshotId":str(uuid.uuid4()),"url":"https://example.org/upload","title":"Fixture upload","text":"Document deleted" if body["accept"] else "Document preserved","truncated":False,"truncatedElements":False,"control":"agent","elements":[],"response":device.dialog_responses[-1]}
        if kind in ("snapshot","upload","back"):
            if kind=="upload":
                blob=base64.b64decode(body["base64"],validate=True)
                if len(blob)!=body["size"] or hashlib.sha256(blob).hexdigest()!=body["sha256"]:raise ValueError("Upload bytes changed")
                device.uploaded=body["sha256"]
            return {"sessionId":session["browserSessionId"],"snapshotId":str(uuid.uuid4()),"url":"https://example.org/upload","title":"Fixture upload","text":"Upload data","truncated":False,"truncatedElements":False,"control":"agent","elements":[{"number":1,"tag":"input","type":"file","role":"input","label":"Upload data","disabled":False,"frameUrl":"https://example.org/upload"}],**({"historyMoved":True} if kind=="back" else {}),**({"dialog":device.dialog,"elements":[]} if device.dialog else {})}
        return {"id":session["browserSessionId"],"url":"https://example.org/upload","title":"Fixture upload","status":"active","updatedAt":"2026-10-03T00:00:00.000Z","control":"agent"}
broker=DesktopBroker(init["executorId"],init["hostId"],session,DesktopDriver(device,session["sessionGeneration"]),browser=Browser())
class Desktop:
    def gate(self,gate):return broker.update_gate({"epoch":gate.epoch,"open":gate.open,"reconciled":not gate.needs_reconciliation,"ttl":2})
    def close_gate(self,epoch):return broker.update_gate({"epoch":epoch,"open":False,"reconciled":False,"ttl":2}) if epoch else {"accepted":True}
    def perform(self,value):return broker.handle(0,{"operation":"perform","envelope":value})
class Sessions:
    registry={init["executorId"]:{"trustMode":"full-trust"}}
    def account(self,_):return {"trustMode":"full-trust"}
class Runtime:
    active={}
    def contain(self,*_,**__):return True
class Helper:
    def gate(self,*_):return True
    def contain_session(self,*_):return True
    def contain_account(self,*_):return True
root=Path(sys.argv[1]).parent/"workspace";root.mkdir(mode=0o700,exist_ok=True)
(root/"source.txt").write_text("owned native workspace content")
workspace=Workspace(root,Path(sys.argv[1]).parent/"file-state")
journal=Journal(Path(sys.argv[1]))
supervisor=Supervisor(init,Sessions(),Runtime(),workspace,journal,Transport(),Helper(),desktop=Desktop(),resource_snapshot=lambda _:{"memoryTotalBytes":32*1024**3,"memoryAvailableBytes":24*1024**3})
supervisor.gate.handshake(init["epoch"],{"paused":False,"revision":0},40,init["serverTime"]);supervisor.gate.reconciled()
supervisor.desktop_frozen=False
def call(value):
    try:
        if value["command"]=="perform":
            supervisor.perform(value["operation"]);supervisor.flush();result=journal.get(value["operation"]["id"])
        elif value["command"]=="pendingDialog":device.dialog=value["dialog"];result={"accepted":True}
        elif value["command"]=="state":result={"events":device.events,"journal":journal.manifest(),"control":broker.control,"uploaded":device.uploaded,"dialog":device.dialog,"dialogResponses":device.dialog_responses,"browserEnvelopes":[json.loads(row[0]) for row in journal.db.execute("SELECT envelope FROM operations WHERE json_extract(envelope,'$.kind')='browser'")]}
        elif value["command"]=="pause":result=supervisor.gate.pause(value["pause"])
        elif value["command"]=="failure":
            device.fail_reset=value.get("reset",False);device.fail_browser=value.get("browser",False);result={"accepted":True}
        else:raise ValueError("Unsupported fixture command")
        send({"call":value["call"],"result":result})
    except Exception as error:send({"call":value["call"],"error":str(error)})
send({"ready":True})
for line in sys.stdin:
    value=json.loads(line)
    if "response" in value:
        with pending_lock:
            slot=pending.get(value["response"])
            if slot:slot.update(value);slot["event"].set()
    else:threading.Thread(target=call,args=(value,),daemon=True).start()
