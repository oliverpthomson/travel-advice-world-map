# AU Travel Advisory Map

A locally-hosted, single-page interactive world map that colour-codes every
country by the Australian Government's **Smartraveller** travel advice level.
Hover for a quick summary, click for details (including area-specific
warnings), search, filter by level, and keep a watchlist that alerts you when
a starred country's advice changes.

A toggle in the top bar switches the map to **Visas** mode, colouring every
country by its visa requirement for Australian passport holders instead
(visa-free / visa on arrival / electronic travel authority / eVisa / visa
required).

> Personal, non-commercial tool. Travel advice © Commonwealth of Australia
> (Smartraveller, smartraveller.gov.au). Always check the official site before
> travelling.

## Quick start

```powershell
# 1. Install dependencies (one-time; Python 3.10+)
python -m venv .venv
.venv\Scripts\pip install flask requests beautifulsoup4 lxml

# 2. Download the Natural Earth map masters (one-time, ~65 MB, public domain)
.venv\Scripts\python updater\fetch_geo.py
.venv\Scripts\python updater\build_geo.py

# 3. (Optional but polite) set a contact address for the scraper's headers
$env:SCRAPER_CONTACT = "you@example.com"

# 4. Start the local server
.venv\Scripts\python server\app.py
```

Then open **http://localhost:5000**. Or just double-click **`run.bat`**.

On the very first start the app scrapes all ~179 destination pages, which
takes about 4 minutes; the page shows progress and loads automatically when
done. After that, startup is instant.

## How the data stays fresh

- **Daily auto-refresh** — a background thread inside the server re-runs the
  scraper whenever the data is more than 24 hours old (checked every 30 min).
  As long as the server is running, no other scheduling is needed.
- **Manual refresh** — click **Refresh now** in the top bar (calls
  `POST /refresh`), or run the updater yourself:

  ```powershell
  .venv\Scripts\python updater\scraper.py          # only re-fetches changed pages
  .venv\Scripts\python updater\scraper.py --force  # re-fetches everything
  ```

- Incremental: a country page is only re-fetched when the index's "Updated"
  date for it has changed, so a routine daily refresh makes ~1 request plus a
  handful of changed pages.
- **If you don't keep the server running** and want a refresh at boot/daily
  anyway, add a Windows Task Scheduler job:
  Program: `C:\...\Smart Traveller\.venv\Scripts\python.exe`
  Arguments: `updater\scraper.py`
  Start in: `C:\...\Smart Traveller`
  Trigger: daily.

### Robustness

- On any scrape failure the last good `data/advisories.json` is kept and the
  error recorded in `data/status.json` (surfaced as a banner in the UI).
- The previous snapshot is kept at `data/advisories.prev.json`.

### Scraping etiquette

The updaters are deliberately conservative:

- `robots.txt` is checked before every run; an explicit Disallow aborts the
  scrape (keeping the last good data).
- Requests are throttled (~0.7 s apart) with retry/backoff, and a country
  page is only re-fetched when the index says its advice changed — a routine
  daily refresh is ~1 request.
- Set `SCRAPER_CONTACT=you@example.com` so your contact address travels in
  the request headers.
- Note: the Smartraveller CDN stalls non-browser User-Agents (requests hang
  until timeout), so the advisory scraper identifies with a browser-style UA
  and carries the contact address in a `From:` header instead. The Wikipedia
  scraper uses a descriptive UA as Wikimedia policy asks.
- When deployed via the included GitHub Actions workflow, scraping happens
  once per day *in total* — visitors of the published site never trigger
  requests to the sources.

## Using the map

- **Advice levels / Visas toggle** (top bar): switches the whole map — colours,
  legend, filters and tooltips — between Smartraveller advisory levels and visa
  requirements for Australian passports. The detail panel always shows both.
  Visa data is scraped from Wikipedia's "Visa requirements for Australian
  citizens" table (refreshed with every data refresh) and covers ~224
  countries and territories, including ones with no Smartraveller advice
  (Andorra, Greenland, Bermuda...). Wikipedia can lag official sources —
  always confirm with the embassy or Smartraveller before booking.
- **Hover** a country for its name, level and one-line summary.
- **⏱ Recent** (top bar): badge shows how many countries' advice changed in the
  last 30 days; the panel lists them ("3 days ago"), and a checkbox filters the
  map to recent changes only.
- **Region dropdown**: focus the map on one region (Africa, Americas, Asia,
  Europe, Middle East, Pacific) — dims the rest and zooms.
- **★ Watchlist** opens a panel listing your starred countries (level, last
  updated, one-click unstar) with a "show only starred" map filter. The
  change-alert banner links straight to it.
- **+ Compare** (in the detail panel): add up to three countries, then open a
  side-by-side table of advice level, last update and reason, higher-level
  areas, visa requirement and allowed stay.
- The detail panel also shows the **"Latest update"** blurb from Smartraveller
  (why the advice last changed) and an **advice history** — every level change
  or revision observed since tracking began (data/history.json, appended on
  each refresh).
- **Click** for the detail panel: overall level, last-updated date, summary,
  all area-specific advice statements, and a link to the full advice page.
- **Search** (top bar) to find and zoom to a country.
- **Legend** (bottom left): click a level to hide/show those countries; live
  counts per level.
- **★ Watchlist**: star countries in the detail panel (stored in your
  browser's localStorage). When a starred country's level or updated date
  changes since you last hit "Mark as seen", a banner lists what changed.
  The "★ Watchlist" button filters the map to starred countries only.
- **CB palette** switches to a colour-blind-friendly palette
  (blue / yellow / orange / vermillion).
- **Insets** (bottom strip): magnified panels for the Caribbean, Pacific,
  Gulf states, European microstates, Malta, Cyprus, Singapore, Hong Kong &
  Macau and Indian Ocean islands. Tiny destinations also get an always-visible
  circle marker on the main map, so everything is clickable.
- **Sub-region shading**: where a named province cleanly matches a Natural
  Earth admin-1 polygon it is shaded at the higher advice level. Dashed /
  lighter shading means the higher level applies only to *part* of that
  province (e.g. "within 50 km of the border"). Advice that can't be matched
  to a polygon is never faked on the map — it's always shown as text in the
  detail panel.

## Project layout

```
updater/
  scraper.py       # scrapes index + country pages -> data/advisories.json
  visa_scraper.py  # scrapes Wikipedia visa table -> data/visas.json
  iso_mapping.py   # destination name -> ISO 3166-1 alpha-3
  build_geo.py     # one-time: slims Natural Earth admin-0 -> web/data/countries.geojson
server/
  app.py          # Flask server: static files, /api/*, POST /refresh, daily scheduler
web/
  index.html, app.js, style.css
  lib/leaflet/    # vendored Leaflet (works offline)
  data/           # countries.geojson, subregions.geojson (generated)
data/
  advisories.json       # current scraped data (generated)
  advisories.prev.json  # previous snapshot (generated)
  updater_state.json    # per-country cache so unchanged pages aren't re-fetched
  status.json           # last run result / errors
  geo/                  # Natural Earth master files (admin-0 50m, admin-1 10m)
```

## Publishing (GitHub Pages)

The repo ships with [.github/workflows/update-data.yml](.github/workflows/update-data.yml),
which turns the project into a self-updating static site:

1. Push the repo to GitHub.
2. In the repo settings, set **Pages → Source → GitHub Actions**.
3. (Optional but polite) add a repository secret `SCRAPER_CONTACT` with your
   contact email for the scraper headers.
4. Done. The workflow runs daily (~05:00 AEST), on every push, and on demand
   via **Actions → Update data and deploy → Run workflow**.

How it works:

- Scrapes advisories + visas, then **commits the refreshed JSON back to the
  repo** — this is what lets `data/history.json` accumulate advice changes
  over time across runs.
- Builds the site into `_site/` (the `web/` front-end plus the data files)
  and deploys it to GitHub Pages.
- If a scrape fails, the workflow stops: nothing is committed and the
  previously deployed site stays live — last good data always wins.
- The Natural Earth masters and the scraper's page cache are kept in the
  Actions cache, so daily runs are incremental (~1 request to Smartraveller).
- On the published site the **Refresh button is hidden** (there's no server
  to re-scrape on demand); it appears automatically when running locally.

The Flask server in `server/` is for **local use only** — never deploy it.

## Disclaimer

This is an unofficial personal project. It is not affiliated with or endorsed
by the Australian Government or DFAT. The data shown may be incomplete, stale
or wrong, and is provided as-is with no warranty of any kind. Do not rely on
it for travel decisions — always check
[smartraveller.gov.au](https://www.smartraveller.gov.au/) and official embassy
sources.

## Licensing

- **Code:** MIT — see [LICENSE](LICENSE).
- **Data:** the generated datasets carry their sources' licences — see
  [DATA-LICENSES.md](DATA-LICENSES.md). In short: advisory data is
  © Commonwealth of Australia (Smartraveller) under CC BY 4.0; the visa
  dataset (`data/visas.json`) is adapted from Wikipedia and is itself
  **CC BY-SA 4.0** (redistribute it only under the same licence, with
  attribution and change notes); map geometry is Natural Earth
  (public domain); [Leaflet](https://leafletjs.com/) is BSD-2.
- This is an unofficial personal tool, not endorsed by the Australian
  Government. Always check the official sources before travelling.
