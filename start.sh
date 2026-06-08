#!/usr/bin/env bash
# Serve the grandfather clock locally on a fixed, uncommon port.
#
# Uses a tiny no-cache handler so the browser always picks up edits to
# the HTML/CSS/JS immediately (the stock http.server lets browsers cache
# JS, which can leave you running stale code after an update).
set -e

PORT=8473
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Grandfather Clock running at:  http://localhost:${PORT}"
echo "(Ctrl+C to stop)"

python3 - "$PORT" "$DIR" << 'PY'
import sys, functools
from http.server import HTTPServer, SimpleHTTPRequestHandler

port, directory = int(sys.argv[1]), sys.argv[2]

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Disable caching so edits to JS/CSS/HTML are always served fresh.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

handler = functools.partial(NoCacheHandler, directory=directory)
HTTPServer(("", port), handler).serve_forever()
PY
