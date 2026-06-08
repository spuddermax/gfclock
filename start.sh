#!/usr/bin/env bash
# Serve the grandfather clock locally on a fixed, uncommon port.
#
# Binds to all interfaces (0.0.0.0) so other computers on your local
# network can reach it too — the LAN URL is printed below.
#
# Uses a tiny no-cache handler so the browser always picks up edits to
# the HTML/CSS/JS immediately (the stock http.server lets browsers cache
# JS, which can leave you running stale code after an update).
set -e

PORT=8473
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 -u - "$PORT" "$DIR" << 'PY'
import sys, socket, functools
from http.server import HTTPServer, SimpleHTTPRequestHandler

port, directory = int(sys.argv[1]), sys.argv[2]

def lan_ip():
    # Find the IP of the interface used to reach the network (no packets sent).
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()

ip = lan_ip()
print("Grandfather Clock is running. Open it at:")
print(f"  This computer:   http://localhost:{port}")
if ip:
    print(f"  Other computers: http://{ip}:{port}   (same Wi-Fi/LAN)")
else:
    print("  (could not detect a LAN IP — run `hostname -I` to find this machine's address)")
print("(Ctrl+C to stop)")

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Disable caching so edits to JS/CSS/HTML are always served fresh.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

handler = functools.partial(NoCacheHandler, directory=directory)
# "" => bind all interfaces (0.0.0.0), so the LAN URL above works.
HTTPServer(("", port), handler).serve_forever()
PY
