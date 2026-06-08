#!/usr/bin/env bash
# Serve the grandfather clock locally on a fixed, uncommon port.
set -e

PORT=8473
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Grandfather Clock running at:  http://localhost:${PORT}"
echo "(Ctrl+C to stop)"

python3 -m http.server "${PORT}" --directory "${DIR}"
