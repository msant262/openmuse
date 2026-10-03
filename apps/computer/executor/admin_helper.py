"""Local privileged helper: fixed root catalog and registered units, never shell RPC.

The helper is invoked only by the root-owned supervisor. Node HTTP credentials
cannot request packages, URLs, units, users, root environment or shell execution.
"""
import argparse
import ipaddress
import json
import os
import re
from pathlib import Path
import subprocess

from .user_session import UserSession, root_owned_json, run

BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
              "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
              "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "168.63.129.16/32"]
BLOCKED_V6 = ["::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "100::/64", "2001:db8::/32",
              "fc00::/7", "fe80::/10", "ff00::/8"]


class NetworkPolicy:
    def __init__(self, uid, dns, exceptions=None, admin_replies=None, browser_proxy_port=None):
        if not isinstance(uid, int) or uid < 1000:
            raise ValueError("Network policy requires registered unprivileged UID")
        self.uid = uid
        if browser_proxy_port is not None and (type(browser_proxy_port) is not int or not 1024<=browser_proxy_port<=65535):
            raise ValueError("Browser proxy requires a fixed unprivileged port")
        self.browser_proxy_port=browser_proxy_port
        self.dns = [ipaddress.ip_address(value) for value in dns]
        if not self.dns:
            raise ValueError("Register explicit DNS resolver addresses")
        self.exceptions = []
        for exception in exceptions or []:
            address = ipaddress.ip_address(exception["address"])
            port = exception["port"]
            if not isinstance(port, int) or not 1 <= port <= 65535:
                raise ValueError("Exception port must be fixed")
            self.exceptions.append((address, port))
        self.blocked = [ipaddress.ip_network(value) for value in BLOCKED_V4 + BLOCKED_V6]
        self.admin_replies=[]
        for reply in admin_replies or []:
            address=ipaddress.ip_address(reply["address"]);port=reply["sourcePort"]
            if port not in (22,3389,3390):
                raise ValueError("Administrative replies require a fixed SSH/RDP source port")
            self.admin_replies.append((address,port))

    def permits(self, address, port, protocol="tcp", gate_open=True, source_port=None, direction="original", state="new",local_route=False,source_address=None):
        address = ipaddress.ip_address(address)
        if protocol=="tcp" and direction=="reply" and state=="established" and (address,source_port) in self.admin_replies:
            return True
        if not gate_open or protocol not in ("tcp", "udp"):
            return False
        if self.browser_proxy_port is not None and protocol=="tcp" and str(address)==source_address=="127.0.0.1":
            if direction=="original" and port==self.browser_proxy_port:return True
            if direction=="reply" and state=="established" and source_port==self.browser_proxy_port:return True
        if address in self.dns:
            return port == 53
        if (address, port) in self.exceptions:
            return True
        if local_route:
            return False
        if port in (53, 853) or any(address.version == network.version and address in network for network in self.blocked):
            return False
        return address.is_global

    def administrative_rules(self):
        return [f"  meta skuid {self.uid} {'ip' if address.version==4 else 'ip6'} daddr {address} tcp sport {port} ct direction reply ct state established accept"
            for address,port in self.admin_replies]

    def chain(self):
        rules = [f"chain uid_{self.uid} {{"]
        if self.browser_proxy_port is not None:
            # Both peers run under this UID. These exact loopback rules remain
            # behind closed_uids, so established proxy replies cannot evade pause.
            rules.extend([f"  ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp dport {self.browser_proxy_port} ct direction original accept",
                          f"  ip saddr 127.0.0.1 ip daddr 127.0.0.1 tcp sport {self.browser_proxy_port} ct direction reply ct state established accept"])
        for address in self.dns:
            family = "ip" if address.version == 4 else "ip6"
            rules.append(f"  {family} daddr {address} meta l4proto {{ tcp, udp }} th dport 53 accept")
            rules.append(f"  {family} daddr {address} reject")
        for address, port in self.exceptions:
            family = "ip" if address.version == 4 else "ip6"
            rules.append(f"  {family} daddr {address} meta l4proto {{ tcp, udp }} th dport {port} accept")
        # Address classification cannot identify a public address assigned to
        # this host. FIB local-route matching handles both address families and
        # runs after only the exact trusted DNS/exception rules above.
        rules.extend(["  fib daddr type local reject",
                      "  ip daddr { " + ", ".join(BLOCKED_V4) + " } reject",
                      "  ip6 daddr { " + ", ".join(BLOCKED_V6) + " } reject",
                      "  meta l4proto { tcp, udp } th dport { 53, 853 } reject",
                      "  meta l4proto { tcp, udp } accept", "  reject", "}"])
        return "\n".join(rules)


def ruleset(policies):
    uids = [policy.uid for policy in policies]
    if len(set(uids)) != len(uids):
        raise ValueError("Duplicate registered bot UID")
    # One transaction installs all IPv4/IPv6 rules. Every bot starts closed;
    # supervisor tailnet traffic is outside these UIDs and this bots slice.
    lines = ["table inet okami_executor {", "set closed_uids { type uid; elements = { " + ", ".join(map(str, uids)) + " }; }",
             "chain output { type filter hook output priority 100; policy accept;"]
    # Verify destination after ordinary output DNAT, and preserve only fixed
    # authenticated administrative replies. An old agent outbound connection
    # cannot bypass pause with an established-state rule.
    lines += [rule for policy in policies for rule in policy.administrative_rules()]
    lines.append("  meta skuid @closed_uids reject")
    lines += [f"  meta skuid {policy.uid} jump uid_{policy.uid}" for policy in policies]
    lines.append("}")
    lines += [policy.chain() for policy in policies]
    lines.append("}")
    return "\n".join(lines) + "\n"


def load_ruleset(policies):
    # nft processes the whole batch atomically. Destroy is idempotent even when
    # the dedicated table is absent; no unrelated table or global ruleset flush.
    return "destroy table inet okami_executor\n"+ruleset(policies)


def policy_identity(text):
    """Compare the installed dedicated table, allowing formatter/set ordering.

    Gate membership is checked separately through nft's JSON set representation.
    No absent UID jump, earlier accept, removed block, or extra hook is accepted.
    """
    text = re.sub(r"#.*", "", text)
    text = re.sub(r"(set\s+closed_uids\s*\{\s*type\s+uid\s*;?)\s*elements\s*=\s*\{[^{}]*\}\s*;?", r"\1", text)
    text = text.replace("reject with icmpx type port-unreachable", "reject")
    text = text.replace("reject with icmp 3", "reject").replace("reject with icmpv6 4","reject")
    text = re.sub(r"\bct direction 1\b","ct direction reply",text)
    text = re.sub(r"\bct direction 0\b","ct direction original",text)
    text = re.sub(r"\bct state (?:0x2|2)\b","ct state established",text)
    text = re.sub(r"\bfib daddr type 2\b","fib daddr type local",text)
    text = re.sub(r"meta l4proto\s*\{([^{}]+)\}",lambda match:"meta l4proto {"+
        ",".join({"6":"tcp","17":"udp"}.get(value.strip(),value.strip()) for value in match[1].split(","))+"}",text)
    def networks(match):
        values=[ipaddress.ip_network(value.strip(),strict=False) for value in match[2].split(",")]
        return match[1]+" {"+",".join(str(value) for value in ipaddress.collapse_addresses(values))+"}"
    # nft canonicalizes adjacent anonymous CIDRs and mapped IPv6 addresses.
    # Compare the same address union while preserving every rule/order/hook.
    text=re.sub(r"\b(ip6? daddr)\s*\{([^{}]+)\}",networks,text)
    text = re.sub(r"\{([^{}]+)\}", lambda match: "{" + ",".join(sorted(value.strip() for value in match[1].split(","))) + "}"
        if "," in match[1] and not any(value in match[1] for value in (";", "chain ", "type ")) else match[0], text)
    return re.sub(r"\s+|;", "", text)


class AdminHelper:
    def __init__(self, registry, catalog=None, runner=run):
        self.sessions = UserSession(registry, runner)
        self.catalog = catalog or {}
        self.runner = runner

    def preflight(self, executor_id):
        self.sessions.account(executor_id)
        if any(account["trustMode"]=="full-trust" and account.get("network",{}).get("administrativeRepliesVerified") is not True
            for account in self.sessions.registry.values()):
            raise ValueError("Full-trust administrative RDP/SSH reply catalog must be verified before UID firewall changes")
        policies = [NetworkPolicy(account["uid"], account.get("network", {}).get("dns", []), account.get("network", {}).get("exceptions", []),account.get("network",{}).get("adminReplies",[]),account.get("desktop",{}).get("proxyPort"))
            for account in self.sessions.registry.values()]
        observed = self.runner(["nft", "-n", "list", "table", "inet", "okami_executor"])
        if policy_identity(observed) != policy_identity(ruleset(policies)):
            raise ValueError("Installed native UID firewall policy is unavailable or changed")
        return True

    def ensure_app(self, app_id):
        if app_id not in self.catalog:
            raise ValueError("Application is absent from fixed root-owned catalog")
        for argv in self.catalog[app_id]:
            if (not isinstance(argv, list) or not argv or not all(isinstance(value, str) and "\x00" not in value for value in argv)
                    or not Path(argv[0]).is_absolute() or Path(argv[0]).name in ("bash", "sh", "env", "sudo")):
                raise ValueError("Root catalog recipe must be fixed executable arguments")
            self.runner(list(argv))
        return {"appId": app_id, "ensured": True}

    def gate(self, executor_id, closed):
        uid = self.sessions.account(executor_id)["uid"]
        self.preflight(executor_id)  # Never close a UID gate before verifying RDP reply preservation.
        verb = "add" if closed else "delete"
        try:
            self.runner(["nft", verb, "element", "inet", "okami_executor", "closed_uids", "{", str(uid), "}"])
        except subprocess.CalledProcessError:
            # Duplicate add/remove is safe only after actual set verification.
            pass
        self.preflight(executor_id)
        raw = self.runner(["nft", "-j", "list", "set", "inet", "okami_executor", "closed_uids"])
        body = json.loads(raw)
        elements = [entry for value in body.get("nftables", []) if "set" in value
                    for entry in value["set"].get("elem", [])]
        if (uid in elements) != closed:
            raise ValueError("UID egress gate containment is unconfirmed")
        return True

    def contain_session(self, executor_id):
        unit = self.sessions.unit(executor_id)
        initial = self.runner(["systemctl", "show", unit, "--property=ActiveState,LoadState"])
        if "ActiveState=inactive" in initial or "LoadState=not-found" in initial:
            return True
        self.runner(["systemctl", "freeze", unit])
        observed = self.runner(["systemctl", "show", unit, "--property=FreezerState,ActiveState"])
        return "FreezerState=frozen" in observed or "ActiveState=inactive" in observed

    def contain_account(self, executor_id):
        unit = self.sessions.slice(executor_id)
        self.runner(["systemctl", "start", unit])
        self.runner(["systemctl", "freeze", unit])
        observed = self.runner(["systemctl", "show", unit, "--property=FreezerState,ControlGroup"])
        return "FreezerState=frozen" in observed

    def resume_account(self, executor_id):
        self.runner(["systemctl", "thaw", self.sessions.slice(executor_id)])

    def contain(self,executor_id):
        outcomes=[]
        for operation in (lambda:self.gate(executor_id,True),lambda:self.contain_account(executor_id),lambda:self.contain_session(executor_id)):
            try:outcomes.append(bool(operation()))
            except Exception:outcomes.append(False)
        if not all(outcomes):raise ValueError("Managed executor containment is unconfirmed")
        return {"contained":True,"guaranteed":self.sessions.account(executor_id)["trustMode"]=="restricted"}

    def resume_session(self, executor_id):
        unit=self.sessions.unit(executor_id)
        state=self.runner(["systemctl","show",unit,"--property=ActiveState,LoadState"])
        if "ActiveState=inactive" in state or "ActiveState=failed" in state or "LoadState=not-found" in state:
            return True
        self.runner(["systemctl", "thaw", unit])
        return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["ensure-app", "close-gate", "open-gate", "start-session", "stop-session","contain-executor"])
    parser.add_argument("registered_id")
    args = parser.parse_args()
    if os.getuid() != 0:
        raise RuntimeError("Native administrative helper requires root-owned service execution")
    helper = AdminHelper(root_owned_json("/etc/okami-executor/users.json"),
                         root_owned_json("/etc/okami-executor/apps.json"))
    if args.operation == "ensure-app":
        result = helper.ensure_app(args.registered_id)
    elif args.operation=="contain-executor":
        result=helper.contain(args.registered_id)
    elif args.operation.endswith("gate"):
        result = helper.gate(args.registered_id, args.operation == "close-gate")
    else:
        result = (helper.sessions.start if args.operation == "start-session" else helper.sessions.stop)(args.registered_id)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
