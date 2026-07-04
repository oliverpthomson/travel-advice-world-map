"""Visa requirements scraper (for Australian passport holders).

Scrapes Wikipedia's "Visa requirements for Australian citizens" page — the
only well-structured, regularly-maintained public table of this data — and
writes data/visas.json. Follows the same rules as the advisory scraper:
polite fetching, keep-last-good-data on any failure, log unmatched names.

Note: visa rules change and Wikipedia can lag; the UI links each country to
its Smartraveller page, which is the authoritative source for entry rules.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup
from urllib import robotparser

sys.path.insert(0, os.path.dirname(__file__))
from iso_mapping import to_iso3  # noqa: E402

SOURCE_URL = "https://en.wikipedia.org/wiki/Visa_requirements_for_Australian_citizens"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
VISAS = os.path.join(DATA_DIR, "visas.json")

# Optional contact for the User-Agent (see SCRAPER_CONTACT note in scraper.py)
CONTACT = os.environ.get("SCRAPER_CONTACT", "").strip()

HEADERS = {
    "User-Agent": "AUTravelAdvisoryMap/1.0 (personal non-commercial travel map"
                  + (f"; contact: {CONTACT}" if CONTACT else "") + ")",
    "Accept": "text/html",
}

# category -> label shown in legend / detail panel
CATEGORIES = {
    "free": "Visa not required",
    "voa": "Visa on arrival",
    "eta": "Electronic travel authority",
    "evisa": "eVisa (apply online in advance)",
    "required": "Visa required in advance",
    "none": "No data",
}

# Wikipedia names that iso_mapping doesn't already cover
EXTRA_ALIASES = {
    "dr congo": "COD",
    "state of palestine": "PSE",
    "sao tome and principe": "STP",
    "st kitts and nevis": "KNA",
    "st lucia": "LCA",
    "st vincent and the grenadines": "VCT",
    "andorra": "AND",
    "antigua and barbuda": "ATG",
    "barbados": "BRB",
    "united kingdom and crown dependencies": "GBR",
    # dependent territories with their own ISO code and map polygon
    "faroe islands": "FRO",
    "greenland": "GRL",
    "aruba": "ABW",
    "curacao": "CUW",
    "sint maarten": "SXM",
    "bermuda": "BMU",
    "cayman islands": "CYM",
    "falkland islands": "FLK",
    "turks and caicos islands": "TCA",
    "anguilla": "AIA",
    "montserrat": "MSR",
    "british virgin islands": "VGB",
    "puerto rico": "PRI",
    "american samoa": "ASM",
    "northern mariana islands": "MNP",
    "saint pierre and miquelon": "SPM",
    "wallis and futuna": "WLF",
    "saint helena": "SHN",
    "south georgia and the south sandwich islands": "SGS",
    "pitcairn islands": "PCN",
    "british indian ocean territory": "IOT",
}


def log(msg):
    print(f"[visa-updater] {msg}", flush=True)


def clean(s):
    """Strip citation markers like [2], [Note 1] and collapse whitespace."""
    s = re.sub(r"\[[^\]]*\]", "", s)
    return " ".join(s.split()).strip()


def classify(requirement_text):
    """Normalise a raw requirement string into one of our categories.

    Combos ("eVisa / Visa on arrival") pick the on-the-day option the
    traveller could use with least advance effort: free > voa > eta > evisa
    > required.
    """
    t = requirement_text.lower()
    if "not required" in t or "visa waiver" in t and "program" not in t:
        return "free"
    if "visa waiver program" in t:   # USA ESTA
        return "eta"
    if "on arrival" in t or "on-arrival" in t:
        return "voa"
    if re.search(r"electronic(?:al)? (?:travel|border)|(?<![a-z])eta(?![a-z])|esta", t):
        return "eta"
    if re.search(r"e-?visa|online visa|e-?voa", t):
        return "evisa"
    if "visa required" in t or "permit required" in t:
        return "required"
    if "visa not available" in t or "restricted" in t or "banned" in t:
        return "required"
    return "none"


def name_to_iso3(name):
    iso = to_iso3(name)
    if iso:
        return iso
    from iso_mapping import _norm
    return EXTRA_ALIASES.get(_norm(name))


def parse_page(html):
    soup = BeautifulSoup(html, "lxml")
    tables = soup.select("table.wikitable")
    if not tables:
        raise RuntimeError("no wikitable found - page layout may have changed")

    entries, unmatched = [], []

    def add(name, requirement, stay, notes, territory=False):
        iso = name_to_iso3(name)
        if not iso:
            unmatched.append(name)
            return
        cat = classify(requirement)
        entries.append({
            "name": name,
            "iso3": iso,
            "category": cat,
            "categoryLabel": CATEGORIES[cat],
            "requirement": requirement,
            "allowedStay": stay,
            "notes": notes[:600],
            "territory": territory,
        })

    # Main sovereign-states table: Country | Visa requirement | Allowed stay | Notes | ...
    main = tables[0]
    for row in main.select("tr"):
        tds = row.find_all("td")
        if len(tds) < 3:
            continue
        name = clean(tds[0].get_text(" ", strip=True))
        req = clean(tds[1].get_text(" ", strip=True))
        stay = clean(tds[2].get_text(" ", strip=True))
        notes = clean(tds[3].get_text(" ", strip=True)) if len(tds) > 3 else ""
        if name and req:
            add(name, req, stay, notes)

    # Territory tables: Territory | Conditions of access | Notes.
    # Requirement and stay are mixed into one prose cell; classify by keywords
    # and pull a "NN days/months" phrase for the stay when present.
    for t in tables[1:]:
        heading = t.find_previous(["h2", "h3"])
        if not heading or "territories" not in heading.get_text(strip=True).lower():
            continue
        for row in t.select("tr"):
            tds = row.find_all("td")
            if len(tds) < 2:
                continue
            name = clean(tds[0].get_text(" ", strip=True))
            cond = clean(tds[1].get_text(" ", strip=True))
            notes = clean(tds[2].get_text(" ", strip=True)) if len(tds) > 2 else ""
            if not name or not cond:
                continue
            m = re.search(r"\b(\d+\s*(?:days?|months?|weeks?))\b", cond)
            add(name, cond, m.group(1) if m else "", notes, territory=True)

    # De-duplicate on iso3 — prefer the sovereign-table entry
    by_iso = {}
    for e in entries:
        if e["iso3"] not in by_iso or (by_iso[e["iso3"]]["territory"] and not e["territory"]):
            by_iso[e["iso3"]] = e
    return list(by_iso.values()), unmatched


def write_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def run_update():
    """Fetch and rebuild visas.json. Keeps the old file on any failure."""
    try:
        try:
            rb = requests.get("https://en.wikipedia.org/robots.txt",
                              headers=HEADERS, timeout=20)
            if rb.status_code < 400:
                rp = robotparser.RobotFileParser()
                rp.parse(rb.text.splitlines())
                if not rp.can_fetch(HEADERS["User-Agent"], SOURCE_URL):
                    raise RuntimeError("robots.txt disallows fetching the article")
        except RuntimeError:
            raise
        except Exception:  # noqa: BLE001 - unreachable robots.txt doesn't block
            pass
        log("fetching Wikipedia visa requirements page...")
        r = requests.get(SOURCE_URL, headers=HEADERS, timeout=60)
        r.raise_for_status()
        entries, unmatched = parse_page(r.text)
        if len(entries) < 150:
            raise RuntimeError(f"only parsed {len(entries)} entries - layout may have "
                               "changed; keeping previous visas.json")
        counts = {}
        for e in entries:
            counts[e["category"]] = counts.get(e["category"], 0) + 1
        for n in unmatched:
            log(f"WARNING: no ISO3 match for name: {n!r}")
        doc = {
            "meta": {
                "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source": SOURCE_URL,
                "attribution": "Visa requirement data adapted from the Wikipedia article "
                               "'Visa requirements for Australian citizens' "
                               "(CC BY-SA 4.0). May lag official sources - always confirm "
                               "with the destination's embassy or Smartraveller.",
                # This dataset is a derivative of CC BY-SA text, so it carries the
                # same licence. The licence metadata must stay with the file.
                "license": "CC BY-SA 4.0",
                "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
                "modifications": "Extracted from the source article's tables; raw "
                                 "requirement text normalised into six categories "
                                 "(free/voa/eta/evisa/required/none); destination names "
                                 "mapped to ISO 3166-1 alpha-3 codes; citation markers "
                                 "stripped; territory rows deduplicated against sovereign "
                                 "entries; notes truncated to 600 characters.",
                "entryCount": len(entries),
                "categoryCounts": counts,
                "unmatchedNames": unmatched,
            },
            "entries": entries,
        }
        write_json_atomic(VISAS, doc)
        log(f"done: {len(entries)} entries {counts}, {len(unmatched)} unmatched")
        return {"ok": True, "entryCount": len(entries), "unmatched": unmatched}
    except Exception as e:  # noqa: BLE001
        log(f"FAILED: {e} (previous visas.json kept)")
        return {"ok": False, "error": str(e)}


if __name__ == "__main__":
    sys.exit(0 if run_update().get("ok") else 1)
