"""Root supervisor adapter to one registered UID's private socket."""
from pathlib import Path
import time
from .broker import exchange


class DesktopClient:
    def __init__(self, executor_id, account):
        self.executor_id,self.uid=executor_id,account["uid"]
        self.path=Path("/run/okami-user-"+str(self.uid))/"desktop.sock"
        self.last_status=None
    def call(self,value,timeout=45):return exchange(self.path,value,expected_uid=self.uid,timeout=timeout)
    def status(self):
        try:
            self.last_status=self.call({"operation":"status"},timeout=5)
            return self.last_status
        except Exception:
            absent={"state":"unavailable","reason":"Registered native desktop/socket preflight unavailable"}
            return {"display":absent,"capture":absent,"input":absent,"browser":absent}
    def cached_status(self):
        if self.last_status:return self.last_status
        absent={"state":"unavailable","reason":"Desktop is contained; live preflight resumes after explicit resume"}
        return {"display":absent,"capture":absent,"input":absent,"browser":absent}
    def gate(self,gate):
        return self.call({"operation":"gate","gate":{"epoch":gate.epoch,"open":gate.open and not gate.quarantined,
                        "reconciled":not gate.needs_reconciliation,"ttl":2}},timeout=5)
    def resume_gate(self,gate,timeout=15):
        """A newly thawed session may not have created its socket yet.

        Retry only an absent/not-listening socket before any permit was sent.
        Authentication/protocol errors and ambiguous IPC failures remain fatal.
        The watchdog must not call this startup wait while the account is cold.
        """
        deadline=time.monotonic()+timeout
        while True:
            if gate.quarantined or not gate.open or gate.clock()>=gate.deadline:
                raise ValueError("Native effect gate closed while desktop was starting")
            try:return self.gate(gate)
            except (FileNotFoundError,ConnectionRefusedError):
                if time.monotonic()>=deadline:raise
                time.sleep(min(.1,max(0,deadline-time.monotonic())))

    def close_gate(self,epoch):
        if epoch:return self.call({"operation":"gate","gate":{"epoch":epoch,"open":False,"reconciled":False,"ttl":2}},timeout=5)
        return {"accepted":True}
    def perform(self,operation):return self.call({"operation":"perform","envelope":operation})
