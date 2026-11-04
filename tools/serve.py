"""Local dev server without caching (WebHID needs localhost or https)."""
import http.server
import sys
from functools import partial
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
root = Path(__file__).resolve().parent.parent
handler = partial(NoCacheHandler, directory=str(root))
print(f"Halcyon Type: http://localhost:{port}/")
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
