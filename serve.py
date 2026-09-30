#!/usr/bin/env python3
"""Lokaler Testserver für die App – wie `python3 -m http.server`, aber ohne Browser-Cache.

Safari & Co. halten sonst alte Dateien (index.html, css, js) fest und mischen sie mit neuen;
dann bricht die App beim Start ab. Mit diesem Server lädt der Browser immer den aktuellen Stand.

Start:  python3 serve.py        → http://localhost:5173
        python3 serve.py 8080   → anderer Port
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    with Server(("", PORT), NoCacheHandler) as httpd:
        print(f"Aperol Sprintz läuft auf http://localhost:{PORT}  (Beenden mit Ctrl+C)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
