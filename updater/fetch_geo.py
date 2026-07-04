"""Download the Natural Earth master files (one-time setup).

These are too large to commit (the admin-1 file is ~60 MB), so they are
fetched on demand into data/geo/. Natural Earth data is public domain.

Run:  python updater/fetch_geo.py        (skips files that already exist)
Then: python updater/build_geo.py        (builds web/data/countries.geojson)
"""

import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEO_DIR = os.path.join(ROOT, "data", "geo")

BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
FILES = {
    "ne_50m_admin_0_countries.geojson": BASE + "ne_50m_admin_0_countries.geojson",
    # admin-1 master keeps its historical local name (scraper.py reads it)
    "ne_10m_admin_1.json": BASE + "ne_10m_admin_1_states_provinces.geojson",
}


def main():
    os.makedirs(GEO_DIR, exist_ok=True)
    ok = True
    for name, url in FILES.items():
        dest = os.path.join(GEO_DIR, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000:
            print(f"already present: {name}")
            continue
        print(f"downloading {name} ...")
        tmp = dest + ".tmp"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AUTravelAdvisoryMap-setup/1.0"})
            with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            os.replace(tmp, dest)
            print(f"  done ({os.path.getsize(dest) / 1e6:.1f} MB)")
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED: {e}")
            if os.path.exists(tmp):
                os.remove(tmp)
            ok = False
    return ok


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
