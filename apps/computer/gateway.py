"""OpenMuse MIT. Authenticated fixed-route RPC proxy with a fail-closed network policy.

Run in a separate PID namespace. It alone owns NET_ADMIN and COMPUTER_TOKEN.
The nonroot computer shares only this network namespace, never this environment.
"""
import hmac
import http.client
import ipaddress
import json
import os
import re
import shlex
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 36 * 1024 * 1024
RPC_PORT = 8810
PROXY_PORT = 8811
DENIED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
             "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
             "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
             "168.63.129.16/32"]  # Azure platform/metadata virtual address
PUBLIC_DNS = ("1.1.1.1", "8.8.8.8")


def system(argv):
    return subprocess.check_output(argv, text=True, timeout=5, stderr=subprocess.DEVNULL)


class Firewall:
    def __init__(self, server_ip, host_public_ips, runner=system):
        self.server_ip = str(ipaddress.IPv4Address(server_ip))
        self.host_ips = sorted(set(str(ipaddress.IPv4Address(p.strip())) for p in host_public_ips.split(",") if p.strip()))
        if not self.host_ips or any(not ipaddress.ip_address(p).is_global for p in self.host_ips):
            raise ValueError("COMPUTER_HOST_PUBLIC_IPS must list every public IPv4 address of the VPS")
        if ipaddress.ip_address(self.server_ip).is_global or self.server_ip == "127.0.0.1":
            raise ValueError("COMPUTER_SERVER_IP must be the API's fixed private control-bridge IPv4")
        self.run = runner
        self.rules = {
            "INPUT": [["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
                      ["-i", "lo", "-j", "ACCEPT"],
                      ["-s", self.server_ip + "/32", "-p", "tcp", "-m", "tcp", "--dport", str(PROXY_PORT), "-j", "ACCEPT"]],
            "OUTPUT": [["-d", "127.0.0.11/32", "-j", "DROP"],
                       ["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
                       ["-o", "lo", "-j", "ACCEPT"]]
        }
        self.rules["OUTPUT"] += [["-d", prefix, "-j", "DROP"] for prefix in DENIED_V4 + [ip + "/32" for ip in self.host_ips]]
        self.rules["OUTPUT"] += [["-d", ip + "/32", "-p", "udp", "-m", "udp", "--dport", "53", "-j", "ACCEPT"] for ip in PUBLIC_DNS]
        self.rules["OUTPUT"] += [["-p", "tcp", "-m", "conntrack", "--ctstate", "NEW", "-j", "ACCEPT"]]

    def install(self):
        # DROP policy first. Existing Docker nat DNS rules remain, but their loopback
        # destination is blocked in filter OUTPUT. No agent can reach NET_ADMIN.
        for tool in ("iptables", "ip6tables"):
            for chain in ("INPUT", "OUTPUT", "FORWARD"):
                self.run([tool, "-w", "5", "-P", chain, "DROP"])
                self.run([tool, "-w", "5", "-F", chain])
        for chain, rules in self.rules.items():
            for rule in rules:
                self.run(["iptables", "-w", "5", "-A", chain] + rule)
        self.verify()

    def verify(self):
        for tool in ("iptables", "ip6tables"):
            for chain in ("INPUT", "OUTPUT", "FORWARD"):
                actual = [shlex.split(line) for line in self.run([tool, "-w", "5", "-S", chain]).splitlines() if line]
                expected = [["-P", chain, "DROP"]]
                if tool == "iptables":
                    expected += [["-A", chain] + rule for rule in self.rules.get(chain, [])]
                if actual != expected:
                    raise RuntimeError("Computer egress firewall changed; refusing RPC dispatch")
        return True

    def permits(self, address):
        # Specification helper used by contract tests; real packets use the rules above.
        ip = ipaddress.ip_address(address)
        return ip.version == 4 and str(ip) not in self.host_ips and not any(ip in ipaddress.ip_network(p) for p in DENIED_V4)


def raw_ready():
    connection = http.client.HTTPConnection("127.0.0.1", RPC_PORT, timeout=2)
    try:
        connection.request("GET", "/health")
        response = connection.getresponse()
        return response.status == 200 and json.loads(response.read(4096)).get("ready") is True
    finally:
        connection.close()


def handler(firewall, token, ready=raw_ready):
    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *args):
            pass  # Never log credentials or arbitrary command/source content.

        def do_GET(self):
            self.proxy()

        def do_POST(self):
            self.proxy()

        def fail(self, status, message):
            body = json.dumps({"error": message}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def proxy(self):
            self.connection.settimeout(30)
            if self.path != "/health" and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return self.fail(401, "Computer RPC authentication required")
            allowed = (self.command == "GET" and (self.path in ("/health", "/rpc/status") or re.fullmatch(r"/rpc/jobs/[a-f0-9]{64}", self.path))) or \
                      (self.command == "POST" and (self.path in ("/rpc/start", "/rpc/stop", "/rpc/jobs", "/rpc/files") or re.fullmatch(r"/rpc/jobs/[a-f0-9]{64}/cancel", self.path)))
            if not allowed:
                return self.fail(404, "Computer RPC route not found")
            try:
                firewall.verify()
                if not ready():
                    return self.fail(503, "Computer RPC is not ready")
            except Exception:
                return self.fail(503, "Computer egress protection is unavailable; no operation was dispatched")
            if self.path == "/health":
                body = b'{"ready":true,"egress":"public-ipv4-only","firewallVerified":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 0 or size > MAX_BODY or self.headers.get("Transfer-Encoding"):
                    return self.fail(413, "Computer RPC request is too large")
                connection = http.client.HTTPConnection("127.0.0.1", RPC_PORT, timeout=30)
                connection.putrequest(self.command, self.path)
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Content-Length", str(size))
                connection.endheaders()
                remaining = size
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError("Incomplete request")
                    connection.send(chunk)
                    remaining -= len(chunk)
                response = connection.getresponse()
                length = int(response.getheader("Content-Length", "0"))
                if length < 0 or length > MAX_BODY:
                    raise ValueError("Invalid RPC response")
                self.send_response(response.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(length))
                self.end_headers()
                remaining = length
                while remaining:
                    chunk = response.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError("Incomplete response")
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (ValueError, OSError, http.client.HTTPException):
                self.close_connection = True
            finally:
                if "connection" in locals():
                    connection.close()
    return Proxy


def main():
    token = os.environ.get("COMPUTER_TOKEN", "")
    if len(token) < 32:
        raise ValueError("COMPUTER_TOKEN must contain at least 32 characters")
    firewall = Firewall(os.environ["COMPUTER_SERVER_IP"], os.environ["COMPUTER_HOST_PUBLIC_IPS"])
    firewall.install()
    # Tokens stay in this gateway PID namespace, never the command container.
    server = ThreadingHTTPServer(("0.0.0.0", PROXY_PORT), handler(firewall, token))
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
