"""Local dev server without caching (WebHID needs localhost or https)."""
import http.server
import sys
from functools import partial
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # lets the dev build be injected into monkeytype.com for testing
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
root = Path(__file__).resolve().parent.parent
handler = partial(NoCacheHandler, directory=str(root))
print(f"Halcyon Type: http://localhost:{port}/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
