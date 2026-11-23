"""Runs the app's own code (from its source folder, APP_SRC) so the Worker is tested against
the real implementation, not a re-typed copy.

usage:
  app_ref.py   link   <secret> <worker_url> <token> <file_id> <name>
  app_ref.py   verify <secret> <method> <path> <body> <ts> <sig>
  app_ref.py   sync   <secret>                 -> prints "<ts> <sig>" exactly as notify_worker() builds them
  app_ref.py   encode <json>                   -> encode_string(json)
  app_ref.py   range  <header> <size>          -> "start end" or "416"
"""
import ast
import asyncio
import importlib.util
import json
import logging
import os
import sys
import time
import types

# The app's source folder (see README: Tests)
ROOT = os.environ.get("APP_SRC") or sys.exit("app_ref.py: set APP_SRC to the app's source folder")


class _Settings:
    cf_stream_url = ""
    cf_stream_secret = ""
    cf_stream_mode = "cloudflare"


def _stub(name, **attrs):
    m = types.ModuleType(name)
    m.__path__ = []
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


_stub("Backend")
_stub("Backend.helper")
_stub("Backend.helper.settings_manager", SettingsManager=type("SM", (), {"current": staticmethod(lambda: _Settings)}))
_stub("Backend.logger", LOGGER=logging.getLogger("app"))
_stub("httpx")  # only used by notify_worker's HTTP call, which we don't make


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


cf = _load("Backend.helper.cf_stream", "Backend/helper/cf_stream.py")
enc = _load("Backend.helper.encrypt", "Backend/helper/encrypt.py")


def _parse_range_fn():
    src = open(os.path.join(ROOT, "Backend/fastapi/routes/stream_routes.py")).read()
    tree = ast.parse(src)
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "parse_range_header")

    class HTTPException(Exception):
        def __init__(self, status_code, detail=None, headers=None):
            self.status_code = status_code

    ns = {"HTTPException": HTTPException}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), "stream_routes.py", "exec"), ns)
    return ns["parse_range_header"], HTTPException


def main():
    cmd = sys.argv[1]
    if cmd == "link":
        _, _, secret, url, token, file_id, name = sys.argv
        _Settings.cf_stream_secret, _Settings.cf_stream_url = secret, url
        print(cf.cf_stream_url(token, file_id, name))
    elif cmd == "verify":
        _, _, secret, method, path, body, ts, sig = sys.argv
        _Settings.cf_stream_secret = secret
        print(cf.verify_worker_request(method, path, body.encode(), ts, sig))
    elif cmd == "sync":
        secret = sys.argv[2]
        ts, body = str(int(time.time())), "{}"
        print(ts, cf._hmac(secret, f"{ts}\nPOST /api/sync\n{body}"))
    elif cmd == "encode":
        print(asyncio.run(enc.encode_string(json.loads(sys.argv[2]))))
    elif cmd == "range":
        fn, exc = _parse_range_fn()
        header = sys.argv[2]
        try:
            s, e = fn(header, int(sys.argv[3]))
            print(s, e)
        except exc:
            print("416")
    else:
        raise SystemExit("unknown command")


if __name__ == "__main__":
    main()
