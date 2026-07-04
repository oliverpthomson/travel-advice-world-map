# Data licences

The application code and the datasets it produces carry **different licences**.
The code is MIT-licensed (see [LICENSE](LICENSE)). The generated data files
under `data/` and `web/data/` are derived from third-party sources and carry
the terms below. The two advisory/visa datasets are kept in **separate files**
deliberately — they are an aggregation of independently-licensed works, not a
single merged derivative.

## 1. Travel advisories — `data/advisories.json`, `data/history.json`, `web/data/subregions.geojson`

- **Source:** [Smartraveller](https://www.smartraveller.gov.au/destinations),
  Australian Department of Foreign Affairs and Trade.
- **Copyright:** © Commonwealth of Australia.
- **Licence:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  (Smartraveller content, excluding the Smartraveller name/logo and the
  Commonwealth Coat of Arms, which are not reproduced by this project).
- **Modifications:** advice levels and area statements extracted from HTML;
  destination names mapped to ISO 3166-1 alpha-3; sub-region statements
  matched to Natural Earth admin-1 polygons; level/date change log accumulated
  over time in `history.json`.
- **Disclaimer:** this is an unofficial personal viewer, not endorsed by the
  Australian Government. Advice can change at any time — always check the
  official site before travelling.

## 2. Visa requirements — `data/visas.json`

- **Source:** Wikipedia,
  [Visa requirements for Australian citizens](https://en.wikipedia.org/wiki/Visa_requirements_for_Australian_citizens).
- **Licence:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Share-alike:** because this dataset adapts CC BY-SA text, **`visas.json`
  is itself released under CC BY-SA 4.0**. If you redistribute this file or a
  derivative of it, you must do so under the same licence, with attribution
  and an indication of changes. The licence metadata embedded in the file's
  `meta` block must be preserved.
- **Modifications:** extracted from the article's tables; raw requirement text
  normalised into six categories (visa-free / visa on arrival / electronic
  travel authority / eVisa / visa required / no data); destination names
  mapped to ISO 3166-1 alpha-3; citation markers stripped; territory rows
  deduplicated against sovereign entries; notes truncated to 600 characters.
- **Accuracy:** community-maintained and may lag official sources. Confirm
  with the destination's embassy or Smartraveller before booking.

## 3. Map geometry — `web/data/countries.geojson`, `data/geo/*`

- **Source:** [Natural Earth](https://www.naturalearthdata.com/)
  (admin-0 countries 1:50m, admin-1 states/provinces 1:10m).
- **Licence:** public domain. No restrictions; credited here as a courtesy.
- **Modifications:** properties slimmed to `iso3`/`name`; a few Natural Earth
  internal codes normalised to ISO (Kosovo, Palestine, South Sudan, Western
  Sahara).

## 4. Bundled library

- **Leaflet** (`web/lib/leaflet/`) — © Volodymyr Agafonkin and contributors,
  [BSD 2-Clause](https://github.com/Leaflet/Leaflet/blob/main/LICENSE).
