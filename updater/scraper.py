"""Smartraveller advisory scraper.

Scrapes https://www.smartraveller.gov.au/destinations (index table) and each
per-country page, and writes data/advisories.json. Designed to be polite and
resilient:

- Browser-style User-Agent (the site's CDN stalls on non-Mozilla UAs) plus a
  From: contact header, throttled requests, retry with backoff.
- A country page is only re-fetched when the index's "Updated" date changed
  since the last run (cached details live in data/updater_state.json).
- On any failure the last good advisories.json is kept untouched; errors are
  recorded in data/status.json. The previous snapshot is kept as
  data/advisories.prev.json so changes can be diffed.

Personal, non-commercial tool. Data © Commonwealth of Australia (Smartraveller).
"""

import json
import os
import re
import shutil
import sys
import time
import unicodedata
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(__file__))
from iso_mapping import to_iso3  # noqa: E402
from simplify import simplify_geometry  # noqa: E402

BASE = "https://www.smartraveller.gov.au"
INDEX_URL = BASE + "/destinations"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
WEB_DATA_DIR = os.path.join(ROOT, "web", "data")
ADVISORIES = os.path.join(DATA_DIR, "advisories.json")
ADVISORIES_PREV = os.path.join(DATA_DIR, "advisories.prev.json")
STATE_FILE = os.path.join(DATA_DIR, "updater_state.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
STATUS_FILE = os.path.join(DATA_DIR, "status.json")
ADMIN1_MASTER = os.path.join(DATA_DIR, "geo", "ne_10m_admin_1.json")
SUBREGIONS_GEOJSON = os.path.join(WEB_DATA_DIR, "subregions.geojson")

# Optional contact address for polite scraping, e.g.
#   set SCRAPER_CONTACT=you@example.com   (Windows)
# Kept out of the source so publishing the repo doesn't publish the address.
CONTACT = os.environ.get("SCRAPER_CONTACT", "").strip()

HEADERS = {
    # The Smartraveller CDN hangs on non-browser User-Agents, so a browser
    # UA is required; the From header carries the polite contact info.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-AU,en;q=0.8",
}
if CONTACT:
    HEADERS["From"] = f"{CONTACT} (personal non-commercial travel-advice map)"

REQUEST_DELAY = 0.7          # seconds between page fetches
RETRIES = 3
TIMEOUT = 40

LEVEL_LABELS = {
    1: "Exercise normal safety precautions",
    2: "Exercise a high degree of caution",
    3: "Reconsider your need to travel",
    4: "Do not travel",
}
LABEL_TO_LEVEL = {v.lower(): k for k, v in LEVEL_LABELS.items()}
CLASS_TO_LEVEL = {
    "normal-safety-precautions": 1,
    "high-degree-caution": 2,
    "reconsider-travel": 3,
    "do-not-travel": 4,
}

# Sub-region advice that only covers part of a province ("within 50 km of the
# border...") — matched provinces get flagged partial instead of fully shaded.
PARTIAL_RE = re.compile(
    r"within\s+\d+\s*(?:km|kilometre|kilometer)|border\s+(?:area|region)s?\b|"
    r"\bparts?\s+of\b|\bareas?\s+(?:of|near|along|close to)\b",
    re.I,
)


def log(msg):
    print(f"[updater] {msg}", flush=True)


def fetch(session, url):
    """GET with retry + exponential backoff. Raises on final failure."""
    last_exc = None
    for attempt in range(RETRIES):
        try:
            r = session.get(url, headers=HEADERS, timeout=TIMEOUT)
            r.raise_for_status()
            return r.text
        except Exception as e:  # noqa: BLE001 - want to retry on anything
            last_exc = e
            wait = 2 ** attempt * 2
            log(f"fetch failed ({attempt + 1}/{RETRIES}) {url}: {e}; retry in {wait}s")
            time.sleep(wait)
    raise last_exc


def parse_index(html):
    """Parse the destinations table -> list of destination dicts."""
    soup = BeautifulSoup(html, "lxml")
    rows = soup.select("table.views-table tbody tr")
    dests, unmatched = [], []
    for row in rows:
        link = row.select_one("td.views-field-title a")
        if not link:
            continue
        name = link.get_text(strip=True)
        href = link.get("href", "")
        if not re.match(r"^/destinations/[a-z-]+/[a-z-]+", href):
            continue  # e.g. the "No travel advice" pseudo-row
        region_td = row.select_one("td.views-field-field-region")
        level_td = row.select_one("td.views-field-field-overall-advice-level")
        time_el = row.select_one("td.views-field-field-updated time")
        label = level_td.get_text(strip=True) if level_td else ""
        level = LABEL_TO_LEVEL.get(label.lower())
        updated = ""
        if time_el and time_el.get("datetime"):
            updated = time_el["datetime"][:10]
        iso3 = to_iso3(name)
        if not iso3:
            unmatched.append(name)
        dests.append({
            "name": name,
            "iso3": iso3,
            "region": region_td.get_text(strip=True) if region_td else "",
            "level": level,
            "levelLabel": LEVEL_LABELS.get(level, label),
            "updated": updated,
            "url": BASE + href,
        })
    return dests, unmatched


def clean_text(s):
    s = unicodedata.normalize("NFKC", s)
    return " ".join(s.split())


def parse_country_page(html):
    """Extract the overall summary and sub-region advice statements."""
    soup = BeautifulSoup(html, "lxml")
    block = soup.select_one(".field--name-field-advice-levels")
    items = []
    if block:
        for p in block.select(".paragraph--type--advice-level"):
            level = None
            for cls, lvl in CLASS_TO_LEVEL.items():
                if cls in (p.get("class") or []):
                    level = lvl
                    break
            desc = p.select_one(".field--name-field-description")
            text = ""
            if desc:
                # Join per block element with no separator inside (the source
                # HTML splits words across inline spans, e.g. "C|hanthaburi"),
                # then join blocks with a space.
                blocks = desc.find_all(["p", "li"]) or [desc]
                # get_text("") keeps the source's own whitespace (words split
                # across inline spans stay joined); clean_text collapses it.
                text = clean_text(" ".join(b.get_text("") for b in blocks))
            if level and text:
                items.append({"level": level, "text": text})
    summary, sub_regions = "", []
    if items:
        # The first advice paragraph is the overall statement; the rest are
        # sub-region advisories (usually at higher levels).
        summary = items[0]["text"]
        sub_regions = items[1:]

    # "Latest update" blurb — why the advice last changed
    latest = ""
    lu = soup.select_one(".views-field-field-last-update .field-content .right")
    if lu:
        for br in lu.find_all("br"):
            br.replace_with(" ")
        latest = clean_text(lu.get_text(""))
    return summary, sub_regions, latest


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def update_history(countries):
    """Append a history entry per country whenever its level or updated date
    changes. First run seeds a baseline entry (tracking start) per country.
    data/history.json: {iso3: [{"t": obs-date, "level": n, "updated": date}]}"""
    hist = load_json(HISTORY_FILE, {})
    today = datetime.now(timezone.utc).date().isoformat()
    changes = 0
    for c in countries:
        if not c.get("iso3"):
            continue
        entries = hist.setdefault(c["iso3"], [])
        last = entries[-1] if entries else None
        if last is None or last.get("level") != c["level"] or last.get("updated") != c["updated"]:
            entries.append({"t": today, "level": c["level"], "updated": c["updated"]})
            changes += 1
    write_json_atomic(HISTORY_FILE, hist)
    return changes


# ---------------------------------------------------------------------------
# Admin-1 sub-region matching

# Natural Earth uses its own codes for a few areas in the admin-1 adm0_a3 field
ISO_TO_NE_ADM0 = {"XKX": "KOS", "PSE": "PSX", "SSD": "SDS"}

_norm_cache = {}


def _norm_name(s):
    if s in _norm_cache:
        return _norm_cache[s]
    n = unicodedata.normalize("NFKD", s)
    n = "".join(c for c in n if not unicodedata.combining(c)).lower()
    n = n.replace("’", "'")
    _norm_cache[s] = n
    return n


def build_subregion_geojson(countries):
    """Shade admin-1 provinces cleanly named in sub-region advice text.

    Only provinces whose Natural Earth name appears verbatim in a sub-region
    statement are included — anything else stays text-only (no faked shading).
    Statements that clearly cover only part of a province set partial=true.
    """
    with_subs = [c for c in countries if c.get("subRegions") and c.get("iso3")]
    if not with_subs:
        write_json_atomic(SUBREGIONS_GEOJSON, {"type": "FeatureCollection", "features": []})
        return {"matched": 0, "countries": 0}
    if not os.path.exists(ADMIN1_MASTER):
        log(f"admin-1 master file missing ({ADMIN1_MASTER}); skipping sub-region shading")
        return {"matched": 0, "countries": 0, "error": "admin1 master missing"}

    log("loading admin-1 master geojson for sub-region matching...")
    admin1 = load_json(ADMIN1_MASTER, {"features": []})
    by_adm0 = {}
    for f in admin1.get("features", []):
        by_adm0.setdefault(f["properties"].get("adm0_a3"), []).append(f)

    out_features = []
    matched_countries = set()
    for c in with_subs:
        # Only shade at levels above the country's overall level
        higher = [s for s in c["subRegions"] if s["level"] > (c["level"] or 0)]
        if not higher:
            continue
        ne_code = ISO_TO_NE_ADM0.get(c["iso3"], c["iso3"])
        feats = by_adm0.get(ne_code, [])
        for feat in feats:
            props = feat["properties"]
            names = {props.get(k) for k in ("name", "name_en", "name_alt", "woe_name")}
            names = {n for n in names if n and len(n) >= 4}
            best = None
            for sub in higher:
                text_norm = _norm_name(sub["text"])
                text_nospace = text_norm.replace(" ", "")
                for n in names:
                    n_norm = _norm_name(n)
                    pat = r"\b" + re.escape(n_norm) + r"\b"
                    # Word-boundary match, or space-insensitive match for
                    # transliteration variants ("Buri Ram" vs "Buriram")
                    if re.search(pat, text_norm) or (
                            len(n_norm) >= 6 and n_norm.replace(" ", "") in text_nospace):
                        if best is None or sub["level"] > best["level"]:
                            best = sub
                        break
            if best:
                out_features.append({
                    "type": "Feature",
                    "properties": {
                        "iso3": c["iso3"],
                        "country": c["name"],
                        "name": props.get("name_en") or props.get("name"),
                        "level": best["level"],
                        "partial": bool(PARTIAL_RE.search(best["text"])),
                    },
                    # source is 1:10m - far denser than a shaded overlay needs
                    "geometry": simplify_geometry(feat["geometry"], eps=0.008, ndigits=4),
                })
                matched_countries.add(c["iso3"])

    write_json_atomic(SUBREGIONS_GEOJSON, {"type": "FeatureCollection", "features": out_features})
    log(f"sub-region shading: {len(out_features)} provinces across {len(matched_countries)} countries")
    return {"matched": len(out_features), "countries": len(matched_countries)}


# ---------------------------------------------------------------------------


def run_update(force=False, progress=None):
    """Run a full update. Returns a summary dict. Never destroys good data."""
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    status = {"lastRunAt": started, "ok": False, "errors": [], "unmatched": []}
    session = requests.Session()

    def note(msg):
        log(msg)
        if progress:
            progress(msg)

    try:
        note("fetching destinations index...")
        index_html = fetch(session, INDEX_URL)
        dests, unmatched = parse_index(index_html)
        if len(dests) < 150:
            raise RuntimeError(
                f"index parse produced only {len(dests)} destinations - page layout "
                "may have changed; keeping previous data")
        status["unmatched"] = unmatched
        for n in unmatched:
            note(f"WARNING: no ISO3 match for destination name: {n!r}")
    except Exception as e:  # noqa: BLE001
        status["errors"].append(f"index fetch/parse: {e}")
        write_json_atomic(STATUS_FILE, status)
        note(f"FAILED: {e} (previous advisories.json kept)")
        return status

    state = load_json(STATE_FILE, {"details": {}})
    details = state.get("details", {})

    to_fetch = []
    for d in dests:
        key = d["url"]
        cached = details.get(key)
        if force or not cached or cached.get("updated") != d["updated"]:
            to_fetch.append(d)
    note(f"{len(dests)} destinations; {len(to_fetch)} country pages need fetching")

    fetched = 0
    for d in to_fetch:
        try:
            time.sleep(REQUEST_DELAY)
            html = fetch(session, d["url"])
            summary, subs, latest = parse_country_page(html)
            details[d["url"]] = {
                "updated": d["updated"],
                "summary": summary,
                "subRegions": subs,
                "latestUpdate": latest,
                "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            fetched += 1
            if fetched % 20 == 0:
                note(f"fetched {fetched}/{len(to_fetch)} country pages...")
                # checkpoint the cache so an interrupted run resumes cheaply
                state["details"] = details
                write_json_atomic(STATE_FILE, state)
        except Exception as e:  # noqa: BLE001
            status["errors"].append(f"{d['name']}: {e}")
            note(f"ERROR fetching {d['name']}: {e} (using cached details if any)")

    state["details"] = details
    write_json_atomic(STATE_FILE, state)

    countries = []
    for d in dests:
        det = details.get(d["url"], {})
        countries.append({
            "name": d["name"],
            "iso3": d["iso3"],
            "region": d["region"],
            "level": d["level"],
            "levelLabel": d["levelLabel"],
            "updated": d["updated"],
            "url": d["url"],
            "summary": det.get("summary", ""),
            "subRegions": det.get("subRegions", []),
            "latestUpdate": det.get("latestUpdate", ""),
        })

    counts = {}
    for c in countries:
        counts[str(c["level"] or 0)] = counts.get(str(c["level"] or 0), 0) + 1

    doc = {
        "meta": {
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": INDEX_URL,
            "attribution": "Travel advice © Commonwealth of Australia (Smartraveller), "
                           "CC BY 4.0. Unofficial viewer - not endorsed by the "
                           "Australian Government.",
            "license": "CC BY 4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "destinationCount": len(countries),
            "levelCounts": counts,
            "pagesFetched": fetched,
            "errors": status["errors"],
            "unmatchedNames": unmatched,
        },
        "countries": countries,
    }

    # Keep the previous good snapshot for diffing, then swap in the new data.
    if os.path.exists(ADVISORIES):
        shutil.copyfile(ADVISORIES, ADVISORIES_PREV)
    write_json_atomic(ADVISORIES, doc)

    try:
        hist_changes = update_history(countries)
        if hist_changes:
            note(f"history: recorded {hist_changes} change(s)")
    except Exception as e:  # noqa: BLE001
        status["errors"].append(f"history: {e}")

    try:
        sub_stats = build_subregion_geojson(countries)
        status["subregionShading"] = sub_stats
    except Exception as e:  # noqa: BLE001
        status["errors"].append(f"subregion geojson: {e}")

    status["ok"] = True
    status["lastSuccessAt"] = doc["meta"]["fetchedAt"]
    status["destinationCount"] = len(countries)
    status["pagesFetched"] = fetched
    write_json_atomic(STATUS_FILE, status)
    note(f"done: {len(countries)} destinations, {fetched} pages fetched, "
         f"{len(status['errors'])} errors, {len(unmatched)} unmatched names")
    return status


if __name__ == "__main__":
    force = "--force" in sys.argv
    result = run_update(force=force)
    sys.exit(0 if result.get("ok") else 1)
