#!/usr/bin/env bash
# ZCode Sites start.sh for a Python web server. Runs in the foreground on 0.0.0.0:3000.
# Dependencies must already be in ./vendor (linux x86-64 wheels for Python 3.12); never install here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export PYTHONPATH="$PWD/vendor${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
export PORT="${PORT:-3000}"
# Writable but temporary storage (lost when the instance is recycled).
export DATA_DIR="${DATA_DIR:-$PWD/data}"
mkdir -p "$DATA_DIR"

# ADJUST: the server command. Always use `python3 -m <tool>`: console scripts in vendor/bin
# carry the build machine's interpreter path and do not run in the cloud.
#   FastAPI / Starlette (ASGI): exec python3 -m uvicorn main:app --host 0.0.0.0 --port "$PORT"
#   Flask (WSGI):               exec python3 -m gunicorn --bind "0.0.0.0:$PORT" --workers 2 app:app
#   Django (WSGI):              exec python3 -m gunicorn --bind "0.0.0.0:$PORT" --workers 2 mysite.wsgi
exec python3 -m uvicorn main:app --host 0.0.0.0 --port "$PORT"
