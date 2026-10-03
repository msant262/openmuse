"""Render a dedicated nft table; never flush or replace unrelated host rules."""
import argparse
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from executor.admin_helper import NetworkPolicy,load_ruleset
from executor.user_session import UserSession,root_owned_json


def render(registry):
    UserSession(registry)
    if any(account["trustMode"]=="full-trust" and account.get("network",{}).get("administrativeRepliesVerified") is not True for account in registry.values()):
        raise ValueError("Verify actual administrative RDP reply sources/direction/UID before rendering the host policy")
    return load_ruleset([NetworkPolicy(account["uid"],account.get("network",{}).get("dns",[]),account.get("network",{}).get("exceptions",[]),account.get("network",{}).get("adminReplies",[]),account.get("desktop",{}).get("proxyPort"))
        for account in registry.values()])


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--registry",default="/etc/okami-executor/users.json")
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args();args.output.write_text(render(root_owned_json(args.registry)))


if __name__=="__main__":main()
