"""MIT. Registered privilege mode is an operator decision, never model input."""


def service_privileges(account):
    if account["trustMode"] == "full-trust":
        # Preserve the existing account's sudo and privileged groups. Root can
        # escape the slice/gates: callers must still report no containment guarantee.
        return {"NoNewPrivileges": "no", "ProtectSystem": "no", "ProtectHome": "no",
                "ProtectControlGroups": "no", "RestrictSUIDSGID": "no"}
    return {"NoNewPrivileges": "yes", "ProtectSystem": "strict", "ProtectHome": "tmpfs",
            "ProtectControlGroups": "yes", "RestrictSUIDSGID": "yes",
            "CapabilityBoundingSet": "",
            "InaccessiblePaths": "/root -/etc/okami-executor -/var/lib/okami-executor -/run/docker.sock -/run/lxd -/run/okami-executor"}
