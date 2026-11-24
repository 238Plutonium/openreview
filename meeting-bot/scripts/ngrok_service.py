#!/usr/bin/env python3
import os
import signal
import sys
import time
from pathlib import Path

from pyngrok import conf, ngrok
from pyngrok.conf import PyngrokConfig


ROOT_DIR = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT_DIR / ".env"
URL_FILE = ROOT_DIR / ".ngrok-url"
# Prefer a preinstalled binary. The conda wrapper may still try to download
# ngrok, and Python SSL on this host can fail certificate verification.
LOCAL_NGROK_BIN = ROOT_DIR / "bin" / "ngrok"


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")

        if key and key not in os.environ:
            os.environ[key] = value


def main() -> int:
    load_dotenv(ENV_FILE)

    token = os.environ.get("NGROK_AUTHTOKEN", "").strip()
    if not token:
        print("Missing NGROK_AUTHTOKEN in environment or .env", file=sys.stderr)
        return 1

    port = int(os.environ.get("PORT", "3000"))
    domain = os.environ.get("NGROK_DOMAIN", "").strip()
    webhook_path = os.environ.get("RTMS_WEBHOOK_PATH", "/zoom/webhooks").strip()
    if not webhook_path.startswith("/"):
        webhook_path = f"/{webhook_path}"

    if LOCAL_NGROK_BIN.is_file() and os.access(LOCAL_NGROK_BIN, os.X_OK):
        conf.set_default(PyngrokConfig(ngrok_path=str(LOCAL_NGROK_BIN)))

    ngrok.set_auth_token(token)

    connect_kwargs = {
        "addr": port,
        "proto": "http",
        "bind_tls": True,
    }
    if domain:
        connect_kwargs["domain"] = domain

    tunnel = ngrok.connect(**connect_kwargs)
    public_url = tunnel.public_url.rstrip("/")
    URL_FILE.write_text(f"{public_url}\n")

    print(f"ngrok tunnel: {public_url} -> http://127.0.0.1:{port}", flush=True)
    print(f"Zoom webhook URL: {public_url}{webhook_path}", flush=True)

    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        while running:
            time.sleep(1)
    finally:
        try:
            ngrok.disconnect(public_url)
        finally:
            ngrok.kill()
            if URL_FILE.exists():
                URL_FILE.unlink()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
