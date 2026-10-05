#!/usr/bin/env python3
"""Reject mobile releases based on a server-only branch that drops published UI."""

import argparse
import json
import pathlib
import subprocess


def verify_mobile_baseline(
    root: pathlib.Path, previous_mobile_source: str, mobile_source: str
) -> dict[str, str]:
    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(root), *args], capture_output=True, text=True, check=False
        )

    def commit(ref: str) -> str:
        result = git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")
        if result.returncode:
            raise ValueError(f"Cannot resolve mobile source commit: {ref}")
        return result.stdout.strip()

    previous = commit(previous_mobile_source)
    source = commit(mobile_source)
    if git("merge-base", "--is-ancestor", previous, source).returncode:
        raise ValueError(
            "Release excludes published mobile history. Select the mobile source "
            "independently of the API release; do not rebuild an old mobile tree."
        )
    if git("diff", "--quiet", source, "--", "apps/mobile", "packages/domain").returncode:
        raise ValueError("Mobile working tree differs from the selected source commit.")
    return {"mobileSourceCommit": source, "previousMobileSourceCommit": previous}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument("--previous-mobile-source", required=True)
    parser.add_argument("--mobile-source", default="HEAD")
    args = parser.parse_args()
    try:
        print(json.dumps(verify_mobile_baseline(args.repo, args.previous_mobile_source, args.mobile_source)))
    except ValueError as error:
        parser.exit(1, f"Mobile baseline rejected: {error}\n")
