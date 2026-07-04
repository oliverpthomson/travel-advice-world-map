"""Local development server for the AU Travel Advisory Map.

Serves the single-page front-end and the scraped data, and re-scrapes
automatically once a day in a background thread.

LOCAL USE ONLY - do not deploy this publicly. It binds to 127.0.0.1 and uses
Flask's development server. The published site is static: host web/ plus the
JSON data files and run the updaters on a schedule instead (see the GitHub
Actions workflow). To re-scrape manually, run the updaters directly:
python updater/scraper.py  and  python updater/visa_scraper.py.

Run:  python server/app.py   (then open http://localhost:5000)
"""

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, send_from_directory

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "updater"))
import scraper  # noqa: E402
import visa_scraper  # noqa: E402

WEB_DIR = os.path.join(ROOT, "web")
DATA_DIR = os.path.join(ROOT, "data")

REFRESH_INTERVAL_H = 24     # daily auto-refresh
SCHEDULER_TICK_S = 30 * 60  # how often the scheduler thread checks

app = Flask(__name__, static_folder=None)

_refresh_lock = threading.Lock()
_refresh_state = {"running": False, "lastResult": None}


@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(WEB_DIR, path)


# The front-end loads all datasets from relative "data/..." URLs so the same
# code works on static hosting (where the workflow copies these files next to
# the geojson). Locally, the scraped JSONs live in DATA_DIR.
DATA_PUBLIC = {"advisories.json", "visas.json", "history.json", "status.json"}


@app.get("/data/<name>")
def data_files(name):
    if name in DATA_PUBLIC:
        return send_from_directory(DATA_DIR, name, max_age=0)
    return send_from_directory(os.path.join(WEB_DIR, "data"), name, max_age=0)


@app.get("/api/advisories")
def advisories():
    return send_from_directory(DATA_DIR, "advisories.json", max_age=0)


@app.get("/api/visas")
def visas():
    path = os.path.join(DATA_DIR, "visas.json")
    if not os.path.exists(path):
        return jsonify({"meta": {}, "entries": []})
    return send_from_directory(DATA_DIR, "visas.json", max_age=0)


@app.get("/api/history")
def history():
    path = os.path.join(DATA_DIR, "history.json")
    if not os.path.exists(path):
        return jsonify({})
    return send_from_directory(DATA_DIR, "history.json", max_age=0)


@app.get("/api/status")
def status():
    path = os.path.join(DATA_DIR, "status.json")
    if not os.path.exists(path):
        return jsonify({"lastRunAt": None, "ok": False, "errors": ["updater has not run yet"]})
    return send_from_directory(DATA_DIR, "status.json", max_age=0)


def _do_refresh(force=False):
    with _refresh_lock:
        _refresh_state["running"] = True
        try:
            result = scraper.run_update(force=force)
            visa_result = visa_scraper.run_update()
            result["visas"] = visa_result
            _refresh_state["lastResult"] = result
            return result
        finally:
            _refresh_state["running"] = False


def _last_success_age_hours():
    try:
        with open(os.path.join(DATA_DIR, "status.json"), encoding="utf-8") as f:
            st = json.load(f)
        ts = st.get("lastSuccessAt")
        if not ts:
            return 1e9
        dt = datetime.fromisoformat(ts)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    except (OSError, ValueError):
        return 1e9


def _scheduler():
    """Daily auto-refresh: check every 30 min, run when data is >24h old."""
    while True:
        try:
            if _last_success_age_hours() >= REFRESH_INTERVAL_H and not _refresh_state["running"]:
                print("[scheduler] data is stale, running daily refresh...", flush=True)
                _do_refresh()
        except Exception as e:  # noqa: BLE001 - scheduler must never die
            print(f"[scheduler] error: {e}", flush=True)
        time.sleep(SCHEDULER_TICK_S)


def main():
    port = int(os.environ.get("PORT", "5000"))
    threading.Thread(target=_scheduler, daemon=True).start()
    if not os.path.exists(os.path.join(DATA_DIR, "advisories.json")):
        print("No advisories.json yet - running initial scrape (takes a few minutes)...",
              flush=True)
        threading.Thread(target=_do_refresh, daemon=True).start()
    print(f"Smartraveller map: http://localhost:{port}", flush=True)
    app.run(host="127.0.0.1", port=port, debug=False)


if __name__ == "__main__":
    main()
