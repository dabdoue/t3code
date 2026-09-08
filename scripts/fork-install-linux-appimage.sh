#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/fork-update-server.sh" "$@"
