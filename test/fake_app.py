"""Fake app for the end-to-end test. The /api/cf/* routes check signatures with the app's
real verify_worker_request (loaded by app_ref from APP_SRC).

usage: fake_app.py <port> <secret> <api_id> <api_hash> <bot_token> [<user>=<user_secret>=<user_bot_token> ...]

Users with their own bots behave as in the app: a Worker request
is checked against the main secret first, then against each user's Worker secret, and
/api/cf/config answers a user's Worker with that user's own bots.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import app_ref  # noqa: E402

PORT, SECRET, API_ID, API_HASH, BOT = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
USERS = [tuple(a.split("=", 2)) for a in sys.argv[6:]]  # (name, worker secret, bot token)
app_ref._Settings.cf_stream_secret = SECRET
REPORTS = []
CONFIG_CALLS = {}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _verified(self, body):
        """(who, bots): who is 'main', a user's name, or None (bad signature) — as cf_routes.py 5.3.5."""
        signed = (self.command, self.path.split("?")[0], body,
                  self.headers.get("x-cf-time", ""), self.headers.get("x-cf-sig", ""))
        if app_ref.cf.verify_worker_request(*signed):
            return "main", [BOT]
        for name, secret, bot in USERS:
            if app_ref.cf.verify_worker_request(*signed, secret):
                return name, [bot]
        return None, []

    def do_GET(self):
        if self.path == "/api/cf/config":
            who, bots = self._verified(b"")
            if not who:
                return self._json(401, {"detail": "Bad signature"})
            CONFIG_CALLS[who] = CONFIG_CALLS.get(who, 0) + 1
            return self._json(200, {"api_id": API_ID, "api_hash": API_HASH, "bots": bots, "user_session": ""})
        if self.path == "/_reports":
            return self._json(200, {"reports": REPORTS, "config_calls": CONFIG_CALLS.get("main", 0), "config_calls_by": CONFIG_CALLS})
        if self.path.startswith("/dl/"):
            return self._json(200, {"served_by": "app", "path": self.path})
        return self._json(404, {"detail": "Not Found"})

    def do_POST(self):
        body = self._body()
        if self.path == "/api/cf/usage":
            who, _ = self._verified(body)
            if not who:
                return self._json(401, {"detail": "Bad signature"})
            report = json.loads(body or b"{}")
            report["_by"] = who
            REPORTS.append(report)
            return self._json(200, {"ok": True})
        return self._json(404, {"detail": "Not Found"})


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
