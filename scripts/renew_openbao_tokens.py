#!/usr/bin/env python3
"""MIT. Renew two scoped periodic service tokens; never log or mint credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess

from deployment_backup import private_path

PERIOD = 72 * 3600


def validate_identity(data, policy):
    if (data.get("type") != "service" or data.get("orphan") is not True
        or data.get("renewable") is not True or data.get("num_uses") != 0
        or data.get("explicit_max_ttl") != 0 or data.get("period") != PERIOD
        or data.get("policies") != [policy] or data.get("identity_policies", [])
        or data.get("ttl", 0) <= 0):
        raise ValueError("Vault service token is not the expected scoped periodic orphan")


class Renewal:
    def __init__(self, project, env_file, backup_token_file, run=subprocess.run):
        self.project = Path(project).resolve(strict=True)
        self.env = private_path(env_file)
        self.backup = private_path(backup_token_file)
        self.run = run
        self.compose = ["docker", "compose", "--project-directory", str(self.project),
            "--env-file", str(self.env), "-f", str(self.project / "docker-compose.yml"),
            "-f", str(self.project / "deploy/compose.hybrid.yml")]

    def output(self, argv, **kwargs):
        return self.run(argv, check=True, timeout=30, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, **kwargs).stdout

    def call(self, token, operation):
        if operation not in ("lookup", "renew") or not token or len(token) > 4096 or any(c.isspace() for c in token):
            raise ValueError("Invalid vault service credential or operation")
        # The token crosses stdin only. Neither argv nor systemd logs contain it.
        script = "IFS= read -r BAO_TOKEN || exit 1; export BAO_TOKEN; export BAO_ADDR=http://127.0.0.1:8200; exec bao token " + operation + " -format=json"
        return json.loads(self.output(self.compose + ["exec", "-T", "openbao", "sh", "-c", script],
            input=(token + "\n").encode()))

    def renew(self):
        config = json.loads(self.output(self.compose + ["config", "--format", "json"]))
        broker = config["services"]["server"]["environment"]["CREDENTIALS_OPENBAO_TOKEN"]
        results = []
        failures = []
        for policy, token in (("openmuse-credentials", broker), ("openmuse-backup", self.backup.read_text().strip())):
            try:
                validate_identity(self.call(token, "lookup")["data"], policy)
                auth = self.call(token, "renew")["auth"]
                if auth.get("renewable") is not True or auth.get("lease_duration", 0) < PERIOD - 60:
                    raise ValueError("Vault did not extend the service token period")
                results.append({"policy": policy, "renewed": True, "ttlSeconds": auth["lease_duration"]})
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                # Still renew the other credential if one has been revoked.
                failures.append(policy)
        if failures:
            raise ValueError("Vault renewal failed for " + ", ".join(failures) + "; replace expired/revoked tokens through operator bootstrap")
        return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", type=Path, default=Path("/opt/openmuse"))
    parser.add_argument("--env-file", type=Path, default=Path("/opt/openmuse/.env"))
    parser.add_argument("--backup-token-file", type=Path, default=Path("/etc/okami-backup/bao-snapshot-token"))
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise ValueError("Vault renewal is an operator-only host service")
        print(json.dumps({"tokens": Renewal(args.project_dir, args.env_file, args.backup_token_file).renew()}))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("Vault service renewal failed; inspect private configuration and rebootstrap expired credentials. No token values were logged.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
