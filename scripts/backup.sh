#!/usr/bin/env bash
# Host-only; never install the Docker socket in an OpenMuse container.
set -euo pipefail
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/deployment_backup.py" backup "$@"
