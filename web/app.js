/* Smartraveller Advisory Map — single-page front-end.
   Reads /api/advisories (scraped data), data/countries.geojson and
   data/subregions.geojson, and renders the map, legend, search, detail
   panel, watchlist alerts and inset mini-maps. */

"use strict";

/* ---------------- palettes & constants ---------------- */

const PALETTES = {
  standard: { 1: "#2e7d32", 2: "#f9a825", 3: "#ef6c00", 4: "#c62828", 0: "#9e9e9e" },
  // Colour-blind-friendly (Okabe–Ito based): blue / yellow / orange / vermillion
  cb:       { 1: "#0072b2", 2: "#f0e442", 3: "#e69f00", 4: "#d55e00", 0: "#9e9e9e" },
};
const LEVEL_LABELS = {
  1: "Exercise normal safety precautions",
  2: "Exercise a high degree of caution",
  3: "Reconsider your need to travel",
  4: "Do not travel",
  0: "No advice / not listed",
};
const VISA_PALETTES = {
  standard: { free: "#2e7d32", voa: "#26a69a", eta: "#1e88e5", evisa: "#8e24aa",
              required: "#c62828", none: "#9e9e9e" },
  cb:       { free: "#009e73", voa: "#f0e442", eta: "#56b4e9", evisa: "#0072b2",
              required: "#d55e00", none: "#9e9e9e" },
};
const VISA_LABELS = {
  free: "Visa not required",
  voa: "Visa on arrival",
  eta: "Electronic travel authority",
  evisa: "eVisa (apply in advance)",
  required: "Visa required in advance",
  none: "No data",
};
const VISA_ORDER = ["free", "voa", "eta", "evisa", "required", "none"];

const STORE = {
  watchlist: "str.watchlist",
  lastSeen: "str.lastSeen",
  palette: "str.palette",
  mode: "str.mode",
};

const INSETS = [
  { title: "Caribbean",            bounds: [[7, -90], [28, -58]] },
  { title: "Gulf states",          bounds: [[21.5, 45.5], [31, 58]] },
  { title: "Malta",                bounds: [[35.6, 13.9], [36.2, 14.9]] },
  { title: "Cyprus & E. Med",      bounds: [[33.5, 31.0], [36.5, 35.5]] },
  { title: "Singapore",            bounds: [[1.1, 103.5], [1.6, 104.2]] },
  { title: "Hong Kong & Macau",    bounds: [[21.9, 112.9], [22.7, 114.6]] },
  { title: "Pacific — Melanesia",  bounds: [[-23, 140], [8, 180]] },
  { title: "Pacific — Polynesia",  bounds: [[-24, -178], [0, -134]] },
  { title: "Indian Ocean islands", bounds: [[-21, 54], [8, 74]] },
  { title: "European microstates", bounds: [[41, 5], [48, 13]] },
];

/* ---------------- state ---------------- */

let advisories = null;          // full document {meta, countries}
let byIso3 = new Map();
let visas = null;               // {meta, entries}
let visaByIso3 = new Map();
let destIndex = new Map();      // iso3 -> {iso3, name} union of both datasets
let countriesGeo = null;
let subregionsGeo = null;
let map, countriesLayer, subregionsLayer, markersGroup;
let insetMaps = [];
let historyByIso = {};          // iso3 -> [{t, level, updated}]
let mode = localStorage.getItem(STORE.mode) === "visa" ? "visa" : "advice";
let activeLevels = new Set([0, 1, 2, 3, 4]);
let activeVisaCats = new Set(VISA_ORDER);
let watchlistOnly = false;
let recentOnly = false;
let activeRegion = "";
let compareSet = [];            // iso3s, max 3, insertion order

const RECENT_DAYS = 30;
const REGION_VIEWS = {
  "Africa":      [[-36, -20], [38, 52]],
  "Americas":    [[-57, -170], [72, -30]],
  "Asia":        [[-12, 42], [56, 150]],
  "Europe":      [[34, -25], [72, 46]],
  "Middle East": [[12, 24], [42, 64]],
  "Pacific":     [[-48, 110], [25, 230]],
};
let palette = localStorage.getItem(STORE.palette) === "cb" ? "cb" : "standard";
let watchlist = new Set(JSON.parse(localStorage.getItem(STORE.watchlist) || "[]"));
let selectedIso = null;
let featureBounds = new Map();  // iso3 -> L.LatLngBounds

const $ = (id) => document.getElementById(id);

// Escape any third-party text (scraped names/summaries/visa notes) before it
// goes into innerHTML. Upstream is semi-trusted but not ours to trust.
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/* ---------------- helpers ---------------- */

function colour(level) { return PALETTES[palette][level || 0]; }
function visaColour(cat) { return VISA_PALETTES[palette][cat || "none"]; }

function fillFor(iso3) {
  if (mode === "visa") {
    const v = visaByIso3.get(iso3);
    return visaColour(v ? v.category : "none");
  }
  const c = byIso3.get(iso3);
  return colour(c ? c.level : 0);
}

function daysSinceUpdate(iso3) {
  const c = byIso3.get(iso3);
  if (!c || !c.updated) return Infinity;
  return (Date.now() - new Date(c.updated + "T00:00:00").getTime()) / 864e5;
}

function isRecent(iso3) { return daysSinceUpdate(iso3) <= RECENT_DAYS; }

function countryVisible(iso3) {
  if (watchlistOnly && !watchlist.has(iso3)) return false;
  if (recentOnly && !isRecent(iso3)) return false;
  if (activeRegion) {
    const c = byIso3.get(iso3);
    if (!c || c.region !== activeRegion) return false;
  }
  if (mode === "visa") {
    const v = visaByIso3.get(iso3);
    return activeVisaCats.has(v ? v.category : "none");
  }
  const c = byIso3.get(iso3);
  return activeLevels.has(c ? (c.level || 0) : 0);
}

function fmtDate(iso) {
  if (!iso) return "unknown";
  try {
    return new Date(iso + (iso.length === 10 ? "T00:00:00" : ""))
      .toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch { return iso; }
}

function saveWatchlist() {
  localStorage.setItem(STORE.watchlist, JSON.stringify([...watchlist]));
}

/* ---------------- map styling ---------------- */

function countryStyle(feature) {
  const iso3 = feature.properties.iso3;
  const visible = countryVisible(iso3);
  return {
    fillColor: fillFor(iso3),
    fillOpacity: visible ? 0.82 : 0.06,
    color: "#0d1117",
    weight: 0.7,
    opacity: visible ? 0.9 : 0.25,
  };
}

function subregionStyle(feature) {
  const p = feature.properties;
  // sub-region advisory shading only applies in advice mode
  const visible = mode === "advice" && countryVisible(p.iso3);
  return {
    fillColor: colour(p.level),
    fillOpacity: visible ? (p.partial ? 0.55 : 0.9) : 0,
    color: "#0d1117",
    weight: 0.6,
    opacity: visible ? 0.9 : 0,
    dashArray: p.partial ? "4 3" : null,
  };
}

function markerStyle(rec) {
  const visible = countryVisible(rec.iso3);
  return {
    radius: 5.5,
    fillColor: fillFor(rec.iso3),
    fillOpacity: visible ? 0.95 : 0.08,
    color: "#ffffff",
    weight: 1.2,
    opacity: visible ? 0.95 : 0.15,
  };
}

/* ---------------- tooltips / interaction ---------------- */

function tooltipHtml(iso3, subNote) {
  const c = byIso3.get(iso3);
  const v = visaByIso3.get(iso3);
  const name = (c && c.name) || (v && v.name) || iso3;

  if (mode === "visa") {
    let html = `<div class="map-tip"><span class="tip-name">${escHtml(name)}</span><br>`;
    if (v) {
      html += `<span class="tip-level" style="color:${visaColour(v.category)}">${VISA_LABELS[v.category]}</span>
        <div class="tip-summary">${escHtml(v.requirement)}${v.allowedStay ? " — stay " + escHtml(v.allowedStay) : ""}</div>`;
    } else {
      html += `<span class="tip-level" style="color:${visaColour("none")}">No visa data</span>`;
    }
    if (c) html += `<div class="tip-sub">Advice: ${LEVEL_LABELS[c.level || 0]}</div>`;
    return html + "</div>";
  }

  if (!c) return `<div class="map-tip"><span class="tip-name">${escHtml(name)}</span><br><span class="tip-level" style="color:${colour(0)}">No Smartraveller advice</span></div>`;
  const lvl = c.level || 0;
  let html = `<div class="map-tip">
    <span class="tip-name">${escHtml(c.name)}</span><br>
    <span class="tip-level" style="color:${colour(lvl)}">${LEVEL_LABELS[lvl]}</span>
    <div class="tip-summary">${escHtml(c.summary || "")}</div>`;
  if (subNote) html += `<div class="tip-sub">${escHtml(subNote)}</div>`;
  else if (c.subRegions && c.subRegions.some(s => s.level > lvl))
    html += `<div class="tip-sub">⚠ Higher advice levels apply in some areas</div>`;
  html += "</div>";
  return html;
}

function attachCountryEvents(layer, iso3, name) {
  layer.on("mouseover", (e) => {
    e.target.setStyle({ weight: 2, color: "#ffffff" });
  });
  layer.on("mouseout", (e) => {
    const f = e.target.feature;
    // sub-region features carry a level property; country features don't
    e.target.setStyle(f.properties.level ? subregionStyle(f) : countryStyle(f));
  });
  layer.on("click", () => openDetail(iso3, name));
  layer.bindTooltip(() => tooltipHtml(iso3), { sticky: true, className: "map-tip-wrap" });
}

/* ---------------- detail panel ---------------- */

function openDetail(iso3, fallbackName) {
  const c = byIso3.get(iso3);
  const v = visaByIso3.get(iso3);
  selectedIso = iso3;
  const panel = $("detail-panel");
  panel.hidden = false;
  $("detail-name").textContent = (c && c.name) || (v && v.name) || fallbackName || iso3;

  const lvl = c ? (c.level || 0) : 0;
  const chip = $("detail-level");
  chip.textContent = `Level ${lvl || "–"}: ${LEVEL_LABELS[lvl]}`;
  chip.style.background = colour(lvl);
  chip.style.color = (palette === "cb" && lvl === 2) || lvl === 0 ? "#111" : "#fff";

  $("detail-updated").textContent = c && c.updated ? `Advice last updated: ${fmtDate(c.updated)}` : "";
  $("detail-summary").textContent = c ? (c.summary || "") :
    "This destination has no Smartraveller travel advice.";

  const latestBox = $("detail-latest");
  if (c && c.latestUpdate) {
    latestBox.hidden = false;
    $("detail-latest-text").textContent = c.latestUpdate;
  } else {
    latestBox.hidden = true;
  }

  const visaBox = $("detail-visa");
  if (v) {
    visaBox.hidden = false;
    const vchip = $("detail-visa-chip");
    vchip.textContent = VISA_LABELS[v.category];
    vchip.style.background = visaColour(v.category);
    vchip.style.color = (palette === "cb" && v.category === "voa") || v.category === "none" ? "#111" : "#fff";
    $("detail-visa-req").textContent = v.requirement;
    $("detail-visa-stay").textContent = v.allowedStay ? `Allowed stay: ${v.allowedStay}` : "";
    $("detail-visa-notes").textContent = v.notes || "";
  } else {
    visaBox.hidden = true;
  }

  const subsDiv = $("detail-subregions");
  subsDiv.innerHTML = "";
  if (c && c.subRegions && c.subRegions.length) {
    const title = document.createElement("div");
    title.className = "subregions-title";
    title.textContent = "Area-specific advice";
    subsDiv.appendChild(title);
    for (const s of c.subRegions) {
      const div = document.createElement("div");
      div.className = "subregion";
      div.style.borderLeftColor = colour(s.level);
      const lab = document.createElement("span");
      lab.className = "sub-level";
      lab.style.color = colour(s.level);
      lab.textContent = LEVEL_LABELS[s.level] || `Level ${s.level}`;
      div.appendChild(lab);
      div.appendChild(document.createTextNode(s.text));
      subsDiv.appendChild(div);
    }
  }

  renderHistoryBlock(iso3);

  const link = $("detail-link");
  if (c && c.url) { link.href = c.url; link.style.display = "block"; }
  else link.style.display = "none";

  updateStarButton();
  updateCompareButton();
  $("detail-close").focus({ preventScroll: true });
}

function renderHistoryBlock(iso3) {
  const box = $("detail-history");
  box.innerHTML = "";
  const entries = historyByIso[iso3];
  if (!entries || !entries.length) return;
  const title = document.createElement("div");
  title.className = "subregions-title";
  title.textContent = "Advice history";
  box.appendChild(title);
  const ul = document.createElement("ul");
  ul.className = "history-list";
  const shown = entries.slice(-8).reverse();  // newest first
  shown.forEach((e, i) => {
    const prev = entries[entries.indexOf(shown[i]) - 1];
    const li = document.createElement("li");
    const date = document.createElement("span");
    date.className = "hist-date";
    date.textContent = fmtDate(e.t);
    const what = document.createElement("span");
    const isFirst = entries.indexOf(e) === 0;
    if (isFirst) {
      what.textContent = `Tracking began — ${LEVEL_LABELS[e.level || 0]}`;
    } else if (prev && prev.level !== e.level) {
      what.innerHTML = `Level changed to <b style="color:${colour(e.level)}">${LEVEL_LABELS[e.level || 0]}</b>` +
        ` (was ${LEVEL_LABELS[prev.level || 0]})`;
    } else {
      what.textContent = `Advice revised (still ${LEVEL_LABELS[e.level || 0]})`;
    }
    li.appendChild(date);
    li.appendChild(what);
    ul.appendChild(li);
  });
  box.appendChild(ul);
}

function updateStarButton() {
  const starred = selectedIso && watchlist.has(selectedIso);
  const btn = $("detail-star");
  btn.textContent = starred ? "★" : "☆";
  btn.setAttribute("aria-pressed", String(!!starred));
  btn.title = starred ? "Remove from watchlist" : "Add to watchlist";
}

/* ---------------- legend & filters ---------------- */

function renderLegend() {
  const legend = $("legend");
  legend.querySelectorAll(".legend-row, .legend-note").forEach(el => el.remove());
  legend.querySelector(".legend-title").firstChild.textContent =
    mode === "visa" ? "Visa requirement " : "Advice level ";

  const addRow = (swatch, label, count, isOn, toggle) => {
    const row = document.createElement("button");
    row.className = "legend-row" + (isOn ? "" : " off");
    row.setAttribute("aria-pressed", String(isOn));
    row.innerHTML =
      `<span class="legend-swatch" style="background:${swatch}"></span>
       <span class="legend-label">${label}</span>
       <span class="legend-count">${count}</span>`;
    row.addEventListener("click", () => { toggle(); restyleAll(); });
    legend.appendChild(row);
  };

  const note = document.createElement("div");
  note.className = "legend-note";

  if (mode === "visa") {
    const counts = {};
    if (visas) for (const e of visas.entries) counts[e.category] = (counts[e.category] || 0) + 1;
    for (const cat of VISA_ORDER) {
      addRow(visaColour(cat), VISA_LABELS[cat], counts[cat] || 0, activeVisaCats.has(cat),
        () => activeVisaCats.has(cat) ? activeVisaCats.delete(cat) : activeVisaCats.add(cat));
    }
    const meta = (visas && visas.meta) || {};
    const srcUrl = meta.source || "https://en.wikipedia.org/wiki/Visa_requirements_for_Australian_citizens";
    const licUrl = meta.licenseUrl || "https://creativecommons.org/licenses/by-sa/4.0/";
    const fetched = meta.fetchedAt ? ", fetched " + fmtDate(meta.fetchedAt.slice(0, 10)) : "";
    note.innerHTML = `For Australian passports. Source:
      <a href="${srcUrl}" target="_blank" rel="noopener">Wikipedia</a>
      (<a href="${licUrl}" target="_blank" rel="noopener">${meta.license || "CC BY-SA 4.0"}</a>)${fetched}
      — always confirm before booking.`;
  } else {
    const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    if (advisories) for (const c of advisories.countries) counts[c.level || 0]++;
    for (const lvl of [1, 2, 3, 4, 0]) {
      addRow(colour(lvl), LEVEL_LABELS[lvl], counts[lvl], activeLevels.has(lvl),
        () => activeLevels.has(lvl) ? activeLevels.delete(lvl) : activeLevels.add(lvl));
    }
    note.textContent = "Hatched/lighter areas: higher level applies to part of that region.";
  }
  legend.appendChild(note);
}

function setMode(m) {
  mode = m;
  localStorage.setItem(STORE.mode, m);
  $("mode-advice").setAttribute("aria-pressed", String(m === "advice"));
  $("mode-visa").setAttribute("aria-pressed", String(m === "visa"));
  if (subregionsLayer) {
    // province-level advisory overlay is meaningless in visa mode
    if (m === "advice") subregionsLayer.addTo(map);
    else subregionsLayer.remove();
  }
  restyleAll();
  if (selectedIso) openDetail(selectedIso);
}

function restyleAll() {
  if (countriesLayer) countriesLayer.setStyle(countryStyle);
  if (subregionsLayer) subregionsLayer.setStyle(subregionStyle);
  if (markersGroup) markersGroup.eachLayer(m => m.setStyle(markerStyle(m._country)));
  for (const im of insetMaps) {
    im.countries.setStyle(countryStyle);
    if (im.subs) im.subs.setStyle(subregionStyle);
    im.markers.eachLayer(m => m.setStyle(markerStyle(m._country)));
  }
  renderLegend();
}

/* ---------------- search ---------------- */

function setupSearch() {
  const input = $("search");
  const list = $("search-results");
  let items = [];
  let activeIdx = -1;

  function close() { list.hidden = true; activeIdx = -1; }

  function render(q) {
    list.innerHTML = "";
    const ql = q.trim().toLowerCase();
    if (!ql) { close(); return; }
    items = [...destIndex.values()]
      .filter(c => c.name.toLowerCase().includes(ql))
      .sort((a, b) => a.name.toLowerCase().indexOf(ql) - b.name.toLowerCase().indexOf(ql))
      .slice(0, 12);
    if (!items.length) { close(); return; }
    items.forEach((c, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.innerHTML = `<span>${escHtml(c.name)}</span>
        <span class="lvl-dot" style="background:${fillFor(c.iso3)}"></span>`;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
      list.appendChild(li);
    });
    list.hidden = false;
  }

  function choose(i) {
    const c = items[i];
    if (!c) return;
    close();
    input.value = c.name;
    zoomToCountry(c.iso3);
    openDetail(c.iso3, c.name);
  }

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    const lis = [...list.querySelectorAll("li")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) { render(input.value); return; }
      activeIdx = e.key === "ArrowDown"
        ? Math.min(activeIdx + 1, lis.length - 1)
        : Math.max(activeIdx - 1, 0);
      lis.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(activeIdx >= 0 ? activeIdx : 0);
    } else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

function computeFeatureBounds(feature) {
  // Bounds of the country's LARGEST polygon, so search-zoom and markers
  // target the main landmass rather than remote outliers (Natural Earth
  // bundles e.g. Tokelau into New Zealand, the Chathams cross the
  // antimeridian, French Polynesia scatters over 20°...).
  const g = feature.geometry;
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let best = null;
  for (const poly of polys) {
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const [lng, lat] of poly[0]) {   // outer ring only
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    const area = (maxLat - minLat) * (maxLng - minLng);
    if (!best || area > best.area) best = { area, minLat, maxLat, minLng, maxLng };
  }
  if (!best) return null;
  return L.latLngBounds([best.minLat, best.minLng], [best.maxLat, best.maxLng]);
}

function zoomToCountry(iso3) {
  const b = featureBounds.get(iso3);
  if (b) {
    map.fitBounds(b.pad(0.3), { maxZoom: 7 });
  }
}

/* ---------------- watchlist & change alerts ---------------- */

function toggleWatch(iso3) {
  if (watchlist.has(iso3)) watchlist.delete(iso3);
  else watchlist.add(iso3);
  saveWatchlist();
  updateStarButton();
  renderWatchlistPanel();
  if (watchlistOnly) restyleAll();
}

/* ---------------- dropdown panels ---------------- */

function closeDropPanels(except) {
  for (const id of ["watchlist-panel", "recent-panel"]) {
    if (id === except) continue;
    $(id).hidden = true;
    $(id === "watchlist-panel" ? "watchlist-toggle" : "recent-toggle")
      .setAttribute("aria-expanded", "false");
  }
}

function toggleDropPanel(panelId, btnId, renderFn) {
  const panel = $(panelId);
  const willOpen = panel.hidden;
  closeDropPanels(willOpen ? panelId : null);
  if (willOpen) renderFn();
  panel.hidden = !willOpen;
  $(btnId).setAttribute("aria-expanded", String(willOpen));
}

function dropItem(iso3, metaText, onRemove) {
  const rec = destIndex.get(iso3) || { iso3, name: iso3 };
  const li = document.createElement("li");
  const dot = document.createElement("span");
  dot.className = "lvl-dot";
  dot.style.background = fillFor(iso3);
  const name = document.createElement("span");
  name.className = "drop-name";
  name.textContent = rec.name;
  const meta = document.createElement("span");
  meta.className = "drop-meta";
  meta.textContent = metaText;
  li.appendChild(dot);
  li.appendChild(name);
  li.appendChild(meta);
  if (onRemove) {
    const un = document.createElement("button");
    un.className = "drop-unstar";
    un.textContent = "★";
    un.title = "Remove from watchlist";
    un.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    li.appendChild(un);
  }
  li.addEventListener("click", () => {
    closeDropPanels(null);
    zoomToCountry(iso3);
    openDetail(iso3, rec.name);
  });
  return li;
}

function renderWatchlistPanel() {
  const list = $("watchlist-list");
  list.innerHTML = "";
  const starred = [...watchlist].map(iso => destIndex.get(iso) || { iso3: iso, name: iso })
    .sort((a, b) => a.name.localeCompare(b.name));
  $("watchlist-empty").hidden = starred.length > 0;
  for (const rec of starred) {
    const c = byIso3.get(rec.iso3);
    const meta = c ? `L${c.level || "–"} · ${fmtDate(c.updated)}` : "no advice";
    list.appendChild(dropItem(rec.iso3, meta, () => {
      toggleWatch(rec.iso3);
    }));
  }
  $("watchlist-filter-cb").checked = watchlistOnly;
}

function renderRecentPanel() {
  const list = $("recent-list");
  list.innerHTML = "";
  const recent = advisories.countries
    .filter(c => c.iso3 && isRecent(c.iso3))
    .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""))
    .slice(0, 60);
  if (!recent.length) {
    const li = document.createElement("li");
    li.textContent = `No advice updates in the last ${RECENT_DAYS} days.`;
    list.appendChild(li);
    return;
  }
  for (const c of recent) {
    const days = Math.floor(daysSinceUpdate(c.iso3));
    const ago = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
    list.appendChild(dropItem(c.iso3, ago, null));
  }
  $("recent-filter-cb").checked = recentOnly;
}

function updateRecentBadge() {
  const n = advisories ? advisories.countries.filter(c => c.iso3 && isRecent(c.iso3)).length : 0;
  const btn = $("recent-toggle");
  btn.innerHTML = `⏱ Recent<span class="badge-count">${n}</span>`;
}

/* ---------------- compare ---------------- */

function updateCompareButton() {
  const btn = $("detail-compare");
  const inSet = selectedIso && compareSet.includes(selectedIso);
  btn.textContent = inSet ? "✓ In comparison" : "+ Compare";
}

function toggleCompare(iso3) {
  const i = compareSet.indexOf(iso3);
  if (i >= 0) compareSet.splice(i, 1);
  else {
    if (compareSet.length >= 3) compareSet.shift();  // keep the newest 3
    compareSet.push(iso3);
  }
  renderCompareBar();
  updateCompareButton();
}

function renderCompareBar() {
  const bar = $("compare-bar");
  const chips = $("compare-chips");
  chips.innerHTML = "";
  bar.hidden = compareSet.length === 0;
  $("compare-open").disabled = compareSet.length < 2;
  for (const iso of compareSet) {
    const rec = destIndex.get(iso) || { name: iso };
    const chip = document.createElement("span");
    chip.className = "cmp-chip";
    chip.title = "Remove from comparison";
    chip.innerHTML = `<span class="lvl-dot" style="background:${fillFor(iso)}"></span>${escHtml(rec.name)} ×`;
    chip.addEventListener("click", () => toggleCompare(iso));
    chips.appendChild(chip);
  }
}

function openCompare() {
  const wrap = $("compare-table-wrap");
  const cols = compareSet.map(iso => ({
    iso,
    rec: destIndex.get(iso) || { name: iso },
    c: byIso3.get(iso),
    v: visaByIso3.get(iso),
  }));
  const esc = escHtml;
  const advChip = (c) => c
    ? `<span class="level-chip" style="background:${colour(c.level)}">${LEVEL_LABELS[c.level || 0]}</span>`
    : `<span class="level-chip" style="background:${colour(0)};color:#111">No advice</span>`;
  const visaChip = (v) => v
    ? `<span class="level-chip" style="background:${visaColour(v.category)}">${VISA_LABELS[v.category]}</span>`
    : `<span class="level-chip" style="background:${visaColour("none")};color:#111">No data</span>`;
  const rows = [
    ["", cols.map(x => `<b>${esc(x.rec.name)}</b>`)],
    ["Region", cols.map(x => esc(x.c ? x.c.region : "—"))],
    ["Advice level", cols.map(x => advChip(x.c))],
    ["Last updated", cols.map(x => x.c && x.c.updated ? fmtDate(x.c.updated) : "—")],
    ["Latest update", cols.map(x => esc(x.c && x.c.latestUpdate ? x.c.latestUpdate.slice(0, 220) + (x.c.latestUpdate.length > 220 ? "…" : "") : "—"))],
    ["Higher-level areas", cols.map(x => {
      const n = x.c ? x.c.subRegions.filter(s => s.level > (x.c.level || 0)).length : 0;
      return n ? `${n} area${n > 1 ? "s" : ""} ⚠` : "None";
    })],
    ["Visa", cols.map(x => visaChip(x.v))],
    ["Allowed stay", cols.map(x => esc(x.v && x.v.allowedStay || "—"))],
    ["Full advice", cols.map(x => x.c ? `<a href="${x.c.url}" target="_blank" rel="noopener">Smartraveller ↗</a>` : "—")],
  ];
  let html = `<table class="cmp-table">`;
  html += rows.map(([label, cells], ri) =>
    `<tr>${ri === 0 ? "<th></th>" : `<th>${label}</th>`}${cells.map(c =>
      ri === 0 ? `<th>${c}</th>` : `<td>${c}</td>`).join("")}</tr>`).join("");
  html += "</table>";
  wrap.innerHTML = html;
  $("compare-overlay").hidden = false;
  $("compare-close").focus();
}

function checkChanges() {
  const lastSeen = JSON.parse(localStorage.getItem(STORE.lastSeen) || "null");
  const current = {};
  for (const c of advisories.countries) {
    if (c.iso3) current[c.iso3] = { level: c.level, updated: c.updated, name: c.name };
  }
  if (!lastSeen) {  // first run — just record, no alerts
    localStorage.setItem(STORE.lastSeen, JSON.stringify(current));
    return;
  }
  const changes = [];
  for (const iso of watchlist) {
    const now = current[iso], was = lastSeen[iso];
    if (!now || !was) continue;
    if (now.level !== was.level) {
      changes.push(`${now.name}: advice level changed from ` +
        `"${LEVEL_LABELS[was.level || 0]}" to "${LEVEL_LABELS[now.level || 0]}"`);
    } else if (now.updated !== was.updated) {
      changes.push(`${now.name}: advice updated on ${fmtDate(now.updated)} ` +
        `(previously ${fmtDate(was.updated)})`);
    }
  }
  // Silently refresh lastSeen for countries NOT on the watchlist, so stale
  // non-watched entries don't fire alerts if starred later.
  const merged = { ...current };
  for (const iso of watchlist) if (lastSeen[iso]) merged[iso] = lastSeen[iso];
  localStorage.setItem(STORE.lastSeen, JSON.stringify(merged));

  if (changes.length) {
    const ul = $("alert-list");
    ul.innerHTML = "";
    for (const ch of changes) {
      const li = document.createElement("li");
      li.textContent = ch;
      ul.appendChild(li);
    }
    $("alert-banner").hidden = false;
  }
}

function dismissAlerts() {
  const current = {};
  for (const c of advisories.countries) {
    if (c.iso3) current[c.iso3] = { level: c.level, updated: c.updated, name: c.name };
  }
  localStorage.setItem(STORE.lastSeen, JSON.stringify(current));
  $("alert-banner").hidden = true;
}

/* ---------------- freshness ---------------- */

function renderFreshness(statusDoc) {
  const meta = advisories && advisories.meta;
  const el = $("freshness-text");
  if (!meta || !meta.fetchedAt) { el.textContent = "No data yet"; return; }
  const dt = new Date(meta.fetchedAt);
  const ageH = (Date.now() - dt.getTime()) / 3.6e6;
  el.textContent = `Refreshed ${dt.toLocaleString(undefined,
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  el.title = "When the advisory data was last scraped";
  const stale = $("stale-banner");
  const problems = [];
  if (ageH > 36) problems.push("The data is more than 36 hours old and may be stale.");
  if (meta.errors && meta.errors.length)
    problems.push(`Last update had ${meta.errors.length} error(s); some entries may use cached details.`);
  if (statusDoc && statusDoc.ok === false && statusDoc.errors && statusDoc.errors.length)
    problems.push("The most recent refresh failed; showing the last good data.");
  if (problems.length) {
    stale.textContent = "⚠ " + problems.join(" ");
    stale.hidden = false;
  } else stale.hidden = true;
}

/* ---------------- inset mini-maps ---------------- */

let insetsBuilt = false;

function buildInsets() {
  insetsBuilt = true;
  const strip = $("insets-strip");
  strip.innerHTML = "";
  insetMaps = [];
  for (const cfg of INSETS) {
    const box = document.createElement("div");
    box.className = "inset";
    box.innerHTML = `<div class="inset-title">${cfg.title}</div>`;
    const mapDiv = document.createElement("div");
    mapDiv.className = "inset-map";
    box.appendChild(mapDiv);
    strip.appendChild(box);

    const bounds = L.latLngBounds(cfg.bounds);
    const im = L.map(mapDiv, {
      attributionControl: false, zoomControl: false, dragging: false,
      scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
      keyboard: false, touchZoom: false, zoomSnap: 0.1,
    });
    im.fitBounds(bounds);

    // Filter features to the inset's viewport to keep the mini-maps light.
    const filter = (f) => {
      const b = f._bbox;
      return b && bounds.intersects(b);
    };
    const countries = L.geoJSON(countriesGeo, {
      style: countryStyle, filter,
      onEachFeature: (f, layer) => attachCountryEvents(layer, f.properties.iso3, f.properties.name),
    }).addTo(im);
    let subs = null;
    if (subregionsGeo && subregionsGeo.features.length) {
      subs = L.geoJSON(subregionsGeo, {
        style: subregionStyle, filter,
        onEachFeature: (f, layer) => attachCountryEvents(layer, f.properties.iso3, f.properties.country),
      }).addTo(im);
    }
    const markers = L.layerGroup().addTo(im);
    addSmallCountryMarkers(markers, (latlng) => bounds.contains(latlng), 4.5);
    insetMaps.push({ map: im, countries, subs, markers });
  }
}

/* ---------------- small-country markers ---------------- */

function addSmallCountryMarkers(group, inBoundsFn, radius) {
  for (const c of destIndex.values()) {
    const b = featureBounds.get(c.iso3);
    if (!b) continue;
    const diag = Math.hypot(b.getNorth() - b.getSouth(), b.getEast() - b.getWest());
    if (diag > 2.2) continue;   // big enough to see/click as a polygon
    const centre = b.getCenter();
    if (inBoundsFn && !inBoundsFn(centre)) continue;
    const m = L.circleMarker(centre, markerStyle(c));
    if (radius) m.setStyle({ radius });
    m._country = c;
    m.bindTooltip(() => tooltipHtml(c.iso3), { sticky: true });
    m.on("click", () => openDetail(c.iso3, c.name));
    group.addLayer(m);
  }
}

/* ---------------- data loading & init ---------------- */

async function loadData(isReload) {
  // Relative data/ URLs work both locally (Flask maps them) and on the
  // static site (the deploy workflow copies the JSONs into data/).
  const [advRes, statusRes, visaRes, histRes] = await Promise.all([
    fetch("data/advisories.json", { cache: "no-store" }),
    fetch("data/status.json", { cache: "no-store" }).catch(() => null),
    fetch("data/visas.json", { cache: "no-store" }).catch(() => null),
    fetch("data/history.json", { cache: "no-store" }).catch(() => null),
  ]);
  if (!advRes.ok) throw new Error("advisories not available yet");
  advisories = await advRes.json();
  const statusDoc = statusRes && statusRes.ok ? await statusRes.json() : null;
  if (visaRes && visaRes.ok) {
    const doc = await visaRes.json();
    if (doc && doc.entries && doc.entries.length) visas = doc;
  }
  if (histRes && histRes.ok) {
    historyByIso = await histRes.json().catch(() => ({})) || {};
  }

  byIso3 = new Map();
  for (const c of advisories.countries) if (c.iso3) byIso3.set(c.iso3, c);
  visaByIso3 = new Map();
  if (visas) for (const e of visas.entries) visaByIso3.set(e.iso3, e);
  destIndex = new Map();
  for (const c of advisories.countries) if (c.iso3) destIndex.set(c.iso3, { iso3: c.iso3, name: c.name });
  if (visas) for (const e of visas.entries) {
    if (!destIndex.has(e.iso3)) destIndex.set(e.iso3, { iso3: e.iso3, name: e.name });
  }

  if (isReload) {
    const sub = await fetch("data/subregions.geojson", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null).catch(() => null);
    if (sub) {
      subregionsGeo = sub;
      indexBboxes(subregionsGeo);
      if (subregionsLayer) { subregionsLayer.remove(); }
      subregionsLayer = makeSubregionLayer();
      if (mode === "advice") subregionsLayer.addTo(map);
    }
    restyleAll();
    if (insetsBuilt) buildInsets();  // rebuild only if already constructed
    if (selectedIso) openDetail(selectedIso);
  }
  renderFreshness(statusDoc);
  checkChanges();
  renderLegend();
  updateRecentBadge();
}

function indexBboxes(geo) {
  for (const f of geo.features) {
    if (f._bbox) continue;
    try { f._bbox = L.geoJSON(f).getBounds(); } catch { f._bbox = null; }
  }
}

function makeSubregionLayer() {
  return L.geoJSON(subregionsGeo, {
    style: subregionStyle,
    onEachFeature: (f, layer) => {
      layer.on("click", () => openDetail(f.properties.iso3, f.properties.country));
      layer.bindTooltip(() => {
        const p = f.properties;
        const note = `${p.name}: ${LEVEL_LABELS[p.level]}` +
          (p.partial ? " (applies to part of this area)" : "");
        return tooltipHtml(p.iso3, note);
      }, { sticky: true });
    },
  });
}

async function init() {
  map = L.map("map", {
    minZoom: 1.4, maxZoom: 10, zoomSnap: 0.2, worldCopyJump: true,
    maxBounds: [[-75, -260], [88, 260]], maxBoundsViscosity: 0.5,
    zoomControl: false,
  }).setView([18, 12], 2);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  // Load geo + advisories in parallel; advisories may not exist on first boot
  const geoP = fetch("data/countries.geojson").then(r => r.json());
  const subP = fetch("data/subregions.geojson").then(r => r.ok ? r.json() : { type: "FeatureCollection", features: [] }).catch(() => ({ type: "FeatureCollection", features: [] }));

  let tries = 0;
  for (;;) {
    try { await loadData(false); break; }
    catch (e) {
      tries++;
      $("freshness-text").textContent = "Waiting for first data scrape… (takes a few minutes)";
      await new Promise(r => setTimeout(r, 5000));
      if (tries > 120) { $("freshness-text").textContent = "Could not load data — check the server log."; return; }
    }
  }

  countriesGeo = await geoP;
  subregionsGeo = await subP;
  indexBboxes(countriesGeo);
  indexBboxes(subregionsGeo);

  countriesLayer = L.geoJSON(countriesGeo, {
    style: countryStyle,
    onEachFeature: (f, layer) => {
      attachCountryEvents(layer, f.properties.iso3, f.properties.name);
    },
  }).addTo(map);

  // record bounds for search-zoom and small-country markers
  countriesLayer.eachLayer(l => {
    const iso = l.feature.properties.iso3;
    if (iso) featureBounds.set(iso, computeFeatureBounds(l.feature));
  });

  subregionsLayer = makeSubregionLayer();
  if (mode === "advice") subregionsLayer.addTo(map);

  markersGroup = L.layerGroup().addTo(map);
  addSmallCountryMarkers(markersGroup, null, null);

  const missing = advisories.countries.filter(c => c.iso3 && !featureBounds.get(c.iso3));
  if (missing.length) console.warn("Destinations with no polygon on the map:", missing.map(c => c.name));

  // insets are built lazily on first expand (strip starts collapsed)
  renderLegend();
  setupSearch();

  /* wire up controls */
  $("detail-close").addEventListener("click", () => { $("detail-panel").hidden = true; selectedIso = null; });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("compare-overlay").hidden) { $("compare-overlay").hidden = true; return; }
    if (!$("watchlist-panel").hidden || !$("recent-panel").hidden) { closeDropPanels(null); return; }
    $("detail-panel").hidden = true; selectedIso = null;
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".drop-wrap, #alert-view-watchlist")) closeDropPanels(null);
  });
  $("detail-star").addEventListener("click", () => selectedIso && toggleWatch(selectedIso));
  $("detail-compare").addEventListener("click", () => selectedIso && toggleCompare(selectedIso));
  $("alert-dismiss").addEventListener("click", dismissAlerts);
  $("alert-view-watchlist").addEventListener("click", () =>
    toggleDropPanel("watchlist-panel", "watchlist-toggle", renderWatchlistPanel));
  $("mode-advice").addEventListener("click", () => setMode("advice"));
  $("mode-visa").addEventListener("click", () => setMode("visa"));
  $("mode-advice").setAttribute("aria-pressed", String(mode === "advice"));
  $("mode-visa").setAttribute("aria-pressed", String(mode === "visa"));

  $("watchlist-toggle").addEventListener("click", () =>
    toggleDropPanel("watchlist-panel", "watchlist-toggle", renderWatchlistPanel));
  $("watchlist-filter-cb").addEventListener("change", (e) => {
    watchlistOnly = e.currentTarget.checked;
    restyleAll();
  });
  $("recent-toggle").addEventListener("click", () =>
    toggleDropPanel("recent-panel", "recent-toggle", renderRecentPanel));
  $("recent-filter-cb").addEventListener("change", (e) => {
    recentOnly = e.currentTarget.checked;
    restyleAll();
  });
  $("region-filter").addEventListener("change", (e) => {
    activeRegion = e.currentTarget.value;
    restyleAll();
    if (activeRegion && REGION_VIEWS[activeRegion]) {
      map.fitBounds(L.latLngBounds(REGION_VIEWS[activeRegion]), { animate: true });
    } else if (!activeRegion) {
      map.setView([18, 12], 2);
    }
  });
  $("compare-open").addEventListener("click", openCompare);
  $("compare-clear").addEventListener("click", () => {
    compareSet = [];
    renderCompareBar();
    updateCompareButton();
  });
  $("compare-close").addEventListener("click", () => { $("compare-overlay").hidden = true; });
  $("compare-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
  $("palette-toggle").addEventListener("click", (e) => {
    palette = palette === "standard" ? "cb" : "standard";
    localStorage.setItem(STORE.palette, palette);
    e.currentTarget.setAttribute("aria-pressed", String(palette === "cb"));
    restyleAll();
    if (selectedIso) openDetail(selectedIso);
  });
  $("palette-toggle").setAttribute("aria-pressed", String(palette === "cb"));
  $("insets-toggle").addEventListener("click", (e) => {
    const strip = $("insets-strip");
    const collapsed = strip.classList.toggle("collapsed");
    e.currentTarget.textContent = collapsed ? "Show" : "Hide";
    e.currentTarget.setAttribute("aria-expanded", String(!collapsed));
    if (!collapsed) {
      if (!insetsBuilt) buildInsets();
      else insetMaps.forEach(im => im.map.invalidateSize());
    }
  });
}

init();
