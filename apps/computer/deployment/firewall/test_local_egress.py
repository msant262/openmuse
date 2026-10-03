"""Actual local-route socket proof; refuses root's host network namespace."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from executor.admin_helper import NetworkPolicy,load_ruleset


def run(argv,body=None):
    return subprocess.run(argv,input=body,text=True,capture_output=True,check=True).stdout


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--host-netns",required=True);args=parser.parse_args()
    actual=os.readlink("/proc/self/ns/net")
    if os.getuid()!=0 or actual==args.host_netns or not args.host_netns.startswith("net:["):
        raise RuntimeError("Refusing host network namespace or non-root fixture")
    run(["/usr/sbin/ip","link","set","lo","up"])
    for address in ("8.8.4.4/32","1.1.1.1/32","100.122.137.110/32"):
        run(["/usr/sbin/ip","addr","add",address,"dev","lo"])
    run(["/usr/sbin/ip","-6","addr","add","2606:4700:4700::1111/128","dev","lo","nodad"])
    policy=NetworkPolicy(1003,["1.1.1.1"],exceptions=[{"address":"8.8.4.4","port":23457}],
                         admin_replies=[{"address":"100.122.137.110","sourcePort":3390}])
    run(["/usr/sbin/nft","-f","-"],load_ruleset([policy]))
    run(["/usr/sbin/nft","delete","element","inet","okami_executor","closed_uids","{","1003","}"])
    records=[]
    for family,address,port,allowed in ((socket.AF_INET,"8.8.4.4",23456,False),
            (socket.AF_INET6,"2606:4700:4700::1111",23456,False),
            (socket.AF_INET,"127.0.0.1",23456,False),(socket.AF_INET,"8.8.4.4",23457,True),
            (socket.AF_INET,"1.1.1.1",53,True)):
        with socket.socket(family,socket.SOCK_STREAM) as server:
            server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);server.bind((address,port));server.listen(1);server.settimeout(.5)
            code=f'import os,socket;os.setgid(1004);os.setuid(1003);s=socket.socket({int(family)},socket.SOCK_STREAM);s.settimeout(1);s.connect(({address!r},{port}));s.sendall(b"fixture")'
            attempt=subprocess.run([sys.executable,"-B","-c",code],capture_output=True,text=True,timeout=3)
            received=None
            if attempt.returncode==0:
                client,_=server.accept()
                with client:received=client.recv(16).decode()
            records.append({"address":address,"port":port,"registeredUid":1003,"listenerUid":0,
                            "connected":attempt.returncode==0,"allowedByCatalog":allowed,"received":received})
    # A cataloged original connection loses egress at pause, even while established.
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);listener.bind(("8.8.4.4",23457));listener.listen(1);listener.settimeout(2)
        code='import os,socket,sys;os.setgid(1004);os.setuid(1003);s=socket.socket();s.settimeout(1);s.connect(("8.8.4.4",23457));print("ready",flush=True);sys.stdin.readline();s.sendall(b"blocked-after-pause");sys.stdin.readline()'
        child=subprocess.Popen([sys.executable,"-B","-c",code],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            connection,_=listener.accept()
            with connection:
                assert child.stdout.readline().strip()=="ready"
                run(["/usr/sbin/nft","add","element","inet","okami_executor","closed_uids","{","1003","}"])
                child.stdin.write("continue\n");child.stdin.flush();connection.settimeout(.8)
                try:after_pause=connection.recv(64)
                except OSError:after_pause=b""
                assert after_pause!=b"blocked-after-pause"
            child.stdin.write("finish\n");child.stdin.flush();child.communicate(timeout=3)
        finally:
            if child.poll() is None:child.kill();child.communicate()
    # The socket is created after dropping UID, so this tests actual UID reply rules.
    code='import os,socket;os.setgid(1004);os.setuid(1003);s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("127.0.0.1",3390));s.listen(1);s.settimeout(2);print("ready",flush=True);c,_=s.accept();c.recv(32);c.sendall(b"administrative-reply");c.close()'
    child=subprocess.Popen([sys.executable,"-B","-c",code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        assert child.stdout.readline().strip()=="ready"
        with socket.socket() as client:
            client.settimeout(2);client.bind(("100.122.137.110",0));client.connect(("127.0.0.1",3390));client.sendall(b"admin")
            reply=client.recv(64)
        _,error=child.communicate(timeout=3);assert child.returncode==0,error
    finally:
        if child.poll() is None:child.kill();child.communicate()
    result={"isolatedNamespace":actual,"hostNamespace":args.host_netns,"kernel":os.uname().release,
            "nft":run(["/usr/sbin/nft","--version"]).strip(),"sockets":records,
            "oldOriginalSocketBlockedAfterPause":after_pause!=b"blocked-after-pause",
            "catalogedUidReplyDuringPause":reply==b"administrative-reply"}
    print(json.dumps(result,indent=2),flush=True)
    assert all(record["connected"]==record["allowedByCatalog"] for record in records),"Unapproved public-address local services must be blocked"
    assert result["catalogedUidReplyDuringPause"]


if __name__=="__main__":main()
