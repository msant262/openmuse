"""Actual nft acceptance. Refuse execution in the caller's host network namespace.

Run this fixed source under sudo -n unshare --net; it never changes the host
firewall or opens network connections. Pure contracts do not require sudo.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from executor.admin_helper import AdminHelper,NetworkPolicy,load_ruleset,policy_identity,ruleset


def nft(argv=(),body=None,check=True):
    result=subprocess.run(["/usr/sbin/nft",*argv],input=body,text=True,capture_output=True)
    if check and result.returncode:raise RuntimeError(result.stderr)
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--host-netns",required=True)
    args=parser.parse_args()
    namespace=os.readlink("/proc/self/ns/net")
    if os.getuid()!=0 or namespace==args.host_netns:
        raise RuntimeError("Actual nft test requires root inside a fresh isolated network namespace")
    sentinel="table inet okami_test_unrelated {\n chain preserve {\n type filter hook input priority 0; policy accept;\n counter\n }\n}\n"
    nft(["-f","-"],sentinel)
    preserved=nft(["-n","list","table","inet","okami_test_unrelated"]).stdout
    policy=NetworkPolicy(1003,["127.0.0.53","1.1.1.1"],admin_replies=[{"address":"100.122.137.110","sourcePort":3389}])
    registry={"node":{"uid":1003,"gid":1004,"user":"okami-bot","home":"/home/okami-bot",
        "workspace":"/home/okami-bot/workspace","trustMode":"full-trust",
        "network":{"dns":["127.0.0.53","1.1.1.1"],"adminReplies":[{"address":"100.122.137.110","sourcePort":3389}],"administrativeRepliesVerified":True}}}
    def runner(argv):
        return subprocess.run(argv,check=True,capture_output=True,text=True).stdout
    helper=AdminHelper(registry,runner=runner)
    first=None
    for _ in range(2):
        nft(["-f","-"],load_ruleset([policy]))
        observed=nft(["-n","list","table","inet","okami_executor"]).stdout
        try:helper.preflight("node")
        except Exception:
            print(json.dumps({"observed":observed,"expected":ruleset([policy]),"observedIdentity":policy_identity(observed),"expectedIdentity":policy_identity(ruleset([policy]))}),file=sys.stderr)
            raise
        if first is not None and observed!=first:raise AssertionError("Firewall reload appended or changed rules")
        first=observed
        if nft(["-n","list","table","inet","okami_test_unrelated"]).stdout!=preserved:
            raise AssertionError("Dedicated reload changed an unrelated table")
    helper.gate("node",False);helper.gate("node",True)
    before=nft(["-n","list","table","inet","okami_executor"]).stdout
    failure=nft(["-f","-"],load_ruleset([policy])+"invalid_nft_statement\n",check=False)
    if failure.returncode==0 or nft(["-n","list","table","inet","okami_executor"]).stdout!=before:
        raise AssertionError("Failed replacement changed the prior firewall transaction")
    print(json.dumps({"isolatedNamespace":namespace,"hostNamespace":args.host_netns,"kernel":platform.release(),
        "nft":nft(["--version"]).stdout.strip(),"loads":2,"sentinelPreserved":True,"failedBatchPreserved":True,"gateRoundTrip":True}))


if __name__=="__main__":main()
