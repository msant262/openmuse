"""MIT. Actual same-UID proxy sockets; refuses the operator's host namespace."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from executor.admin_helper import NetworkPolicy, load_ruleset, policy_identity, ruleset


def run(argv, body=None):
    return subprocess.run(argv, input=body, text=True, capture_output=True, check=True, timeout=10).stdout


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--host-netns", required=True);args=parser.parse_args()
    actual=os.readlink("/proc/self/ns/net")
    if os.getuid()!=0 or actual==args.host_netns or not args.host_netns.startswith("net:["):
        raise RuntimeError("Refusing host network namespace or non-root fixture")
    run(["/usr/sbin/ip", "link", "set", "lo", "up"])
    policy=NetworkPolicy(1003,["1.1.1.1"],browser_proxy_port=18777)
    run(["/usr/sbin/nft", "-f", "-"], load_ruleset([policy]))
    observed=run(["/usr/sbin/nft", "-n", "list", "table", "inet", "okami_executor"])
    assert policy_identity(observed)==policy_identity(ruleset([policy]))
    run(["/usr/sbin/nft", "delete", "element", "inet", "okami_executor", "closed_uids", "{", "1003", "}"])
    server_code='''import os,socket
os.setgid(1004);os.setuid(1003)
s=socket.socket();s.bind(("127.0.0.1",18777));s.listen(1);s.settimeout(5)
print("ready",flush=True)
c,_=s.accept();c.settimeout(3)
try:
 while data:=c.recv(64):c.sendall(data)
except OSError:pass
finally:c.close();s.close()
'''
    client_code='''import os,socket,sys,json
os.setgid(1004);os.setuid(1003)
s=socket.socket();s.settimeout(2);s.connect(("127.0.0.1",18777));s.sendall(b"before")
assert s.recv(64)==b"before";print("round-trip",flush=True)
sys.stdin.readline()
try:s.sendall(b"after");blocked=s.recv(64)!=b"after"
except OSError:blocked=True
print(json.dumps({"blocked":blocked}),flush=True);s.close()
'''
    children=[]
    try:
        server=subprocess.Popen([sys.executable,"-B","-c",server_code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);children.append(server)
        assert server.stdout.readline().strip()=="ready"
        client=subprocess.Popen([sys.executable,"-B","-c",client_code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);children.append(client)
        assert client.stdout.readline().strip()=="round-trip", "The same-UID listener must return its TCP reply"
        # A separate loopback listener is reachable by root but not this UID.
        import socket
        with socket.socket() as other:
            other.bind(("127.0.0.1",18778));other.listen(1)
            denied=run([sys.executable,"-B","-c",'import os,socket;os.setgid(1004);os.setuid(1003);s=socket.socket();s.settimeout(.5);print(s.connect_ex(("127.0.0.1",18778))!=0)']).strip()=="True"
        assert denied
        run(["/usr/sbin/nft", "add", "element", "inet", "okami_executor", "closed_uids", "{", "1003", "}"])
        client.stdin.write("pause\n");client.stdin.flush()
        output,error=client.communicate(timeout=5)
        assert client.returncode==0,error
        assert json.loads(output)["blocked"]
        print(json.dumps({"isolatedNamespace":actual,"sameUidRoundTrip":True,"unregisteredLoopbackBlocked":True,"pauseStopsExistingProxy":True,"policyIdentityVerified":True}))
    finally:
        for child in children:
            if child.poll() is None:child.terminate()
            try:child.communicate(timeout=3)
            except subprocess.TimeoutExpired:child.kill();child.communicate()


if __name__=="__main__":main()
