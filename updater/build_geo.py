"""Build web/data/countries.geojson from the Natural Earth admin-0 master.

Slims the 3 MB Natural Earth file down to just {iso3, name} properties and
normalises the handful of codes where Natural Earth deviates from ISO
(ISO_A3 is "-99" for France/Norway/Kosovo etc.). Run once at setup; safe to
re-run any time.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simplify import simplify_geometry  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "geo", "ne_50m_admin_0_countries.geojson")
OUT = os.path.join(ROOT, "web", "data", "countries.geojson")

# Natural Earth internal code -> ISO 3166-1 alpha-3 (or common user-assigned)
NE_TO_ISO = {"KOS": "XKX", "PSX": "PSE", "SDS": "SSD", "CYN": "CYN", "SAH": "ESH"}


def feature_iso3(props):
    iso = props.get("ISO_A3_EH") or props.get("ISO_A3") or ""
    if iso == "-99" or not iso:
        iso = props.get("ADM0_A3") or ""
    return NE_TO_ISO.get(iso, iso)


def main():
    with open(SRC, encoding="utf-8") as f:
        gj = json.load(f)
    out_feats = []
    for feat in gj["features"]:
        p = feat["properties"]
        out_feats.append({
            "type": "Feature",
            "properties": {
                "iso3": feature_iso3(p),
                "name": p.get("NAME_LONG") or p.get("NAME") or "",
            },
            # ~0.005 deg tolerance: invisible at the zooms the map uses,
            # but keeps the web payload small
            "geometry": simplify_geometry(feat["geometry"], eps=0.005, ndigits=4),
        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": out_feats}, f,
                  ensure_ascii=False)
    size = os.path.getsize(OUT)
    print(f"wrote {OUT}: {len(out_feats)} features, {size/1e6:.1f} MB")


if __name__ == "__main__":
    main()
