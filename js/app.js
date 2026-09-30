import { DEFAULT_CATEGORIES, FALLBACK_CATEGORY, ROUTE_CATEGORY } from './categories.js';
import { haversineKm, hasCoords, parseCoords, formatKm, geocode } from './geo.js';
import { parseFile, parseGeoJSON, parseLinks, assignCategory, buildGpx } from './importers.js';
import { loadUi, saveUi, readPref, writePref, downloadBackup, newId, newTripKey, loadLocalBackup, clearLocalBackup } from './store.js';
import {
  LocalBackend, SharedBackend, sharingConfigured, tripKeyFromUrl,
  rememberedTripKey, rememberTripKey, forgetTripKey, shareUrl,
} from './backend.js';
import { createMap } from './map.js';
import { FIXED_AIRBNB } from './config.js';
import { icon, categoryIcon, categoryStyle } from './icons.js';

const MALLORCA_CENTER = { lat: 39.62, lng: 2.95 };
const SYNC_INTERVAL_MS = 20000;

// Fest hinterlegte Unterkunft aus config.js (hat Vorrang vor allem, was in der App gesetzt wurde).
const fixedAirbnb = FIXED_AIRBNB && Number.isFinite(FIXED_AIRBNB.lat) && Number.isFinite(FIXED_AIRBNB.lng)
  ? { label: String(FIXED_AIRBNB.label || 'Unterkunft'), lat: FIXED_AIRBNB.lat, lng: FIXED_AIRBNB.lng, url: FIXED_AIRBNB.url || '', mapsUrl: FIXED_AIRBNB.mapsUrl || '' }
  : null;

const state = {
  places: [],
  airbnb: fixedAirbnb,
  customCategories: [],
  // Hin- & Rückflug: { outDate, outTime, backDate, backTime }, alle Felder optional.
  flights: {},
  // Importierte GPX-Strecken (Linien statt Punkte) – separat von places, siehe renderRoutes().
  routes: [],
  ui: loadUi(),
};

let backend = new LocalBackend(() => state);
let activeId = null;
let pickMode = false;
let geocodeRunning = false;
let pendingWrites = 0;
// Erst speichern, wenn die Orte geladen sind – sonst würde eine leere Liste den Speicher überschreiben.
let dataLoaded = false;
let lastSync = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const memberName = () => String(readPref('name') || '').trim();

// --- Kategorien ------------------------------------------------------------------

// Eigene Kategorien landen im HTML (auch aus Backups oder von Mitreisenden) – daher Werte absichern.
function sanitizeCategory(c) {
  return {
    id: String(c.id || '').replace(/[^a-z0-9-]/gi, '') || `kategorie-${Math.random().toString(36).slice(2, 6)}`,
    label: String(c.label || 'Kategorie').slice(0, 40),
    emoji: String(c.emoji || '📍').replace(/[<>&"']/g, '').slice(0, 8) || '📍',
    color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#8C8074',
    keywords: Array.isArray(c.keywords) ? c.keywords.map(String) : [],
  };
}

// Anzeige-Reihenfolge: Standard, eigene, zuletzt "Sonstiges".
function displayCategories() {
  const fallback = DEFAULT_CATEGORIES.find((c) => c.id === FALLBACK_CATEGORY);
  return [...DEFAULT_CATEGORIES.filter((c) => c.id !== FALLBACK_CATEGORY), ...state.customCategories, fallback];
}
// Für die Erkennung haben eigene Kategorien Vorrang.
const classifyCategories = () => [...state.customCategories, ...DEFAULT_CATEGORIES];
function catOf(id) {
  return displayCategories().find((c) => c.id === id) || DEFAULT_CATEGORIES.find((c) => c.id === FALLBACK_CATEGORY);
}

// Auswahllisten können kein SVG anzeigen: dort nur Name (eigene Kategorien mit Emoji).
const optionLabel = (c) => `${c.icon ? '' : `${c.emoji} `}${escapeHtml(c.label)}`;

// "12,1 km" → Zahl in Serifenschrift, Einheit klein und gedämpft.
function distanceHtml(km) {
  const [value, unit] = formatKm(km).split(' ');
  return `${value}<small>${unit}</small>`;
}

// --- Speichern ----------------------------------------------------------------------

function applyData(data) {
  state.places = Array.isArray(data.places) ? data.places : [];
  state.routes = Array.isArray(data.routes) ? data.routes : [];
  state.airbnb = fixedAirbnb || data.airbnb || null;
  state.customCategories = (data.customCategories || []).map(sanitizeCategory);
  state.flights = data.flights && typeof data.flights === 'object' ? data.flights : {};
}

// Führt eine Speicher-Operation aus. Schlägt sie in einer gemeinsamen Reise fehl,
// wird der Serverstand neu geladen, damit die Anzeige nicht von der Datenbank abweicht.
async function persist(op, failMsg = 'Änderung konnte nicht gespeichert werden') {
  if (!dataLoaded) {
    toast('Die Orte werden noch geladen – bitte kurz warten und noch einmal versuchen.');
    return false;
  }
  pendingWrites++;
  try {
    await op(backend);
    lastSync = new Date();
    return true;
  } catch (err) {
    toast(`${failMsg}: ${err.message}`);
    if (backend.kind === 'shared') await refresh();
    return false;
  } finally {
    pendingWrites--;
  }
}

const persistSettings = () =>
  persist((b) => b.saveSettings({ airbnb: state.airbnb, customCategories: state.customCategories, flights: state.flights }));

let lastSignature = '';

async function refresh({ fit = false } = {}) {
  if (pendingWrites > 0 && !fit) return;
  try {
    const data = await backend.load();
    lastSync = new Date();
    const signature = JSON.stringify(data);
    if (signature === lastSignature && !fit) {
      if (shareDialog.open) renderShareDialog();
      return;
    }
    lastSignature = signature;
    applyData(data);
    dataLoaded = true;
    render({ fit });
  } catch (err) {
    if (backend.kind === 'shared') setSyncStatus(`Keine Verbindung (${err.message})`);
    else toast(`Orte konnten nicht geladen werden: ${err.message}`);
  }
}

// --- Karte -------------------------------------------------------------------------

const mapView = createMap($('#map'), {
  onMapClick: (latlng) => {
    if (!pickMode) return;
    setPickMode(false);
    setAirbnb({ label: `Gewählter Punkt (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`, lat: latlng.lat, lng: latlng.lng });
  },
  onMarkerClick: (id) => selectPlace(id, { fly: false, scrollList: true }),
  getInsets: mapInsets,
});

// --- Handy: Liste als Blatt über der Karte ------------------------------------------------
// Unter 900px liegt die Seitenleiste als Blatt unten über der randlosen Karte (wie auf dem Desktop
// schwebend, nur von unten). Drei Höhen: „peek“ (nur Suche), „half“ (Standard), „full“ (ganze Liste).
// Die Höhen selbst stehen in styles.css (--sheet-h); hier wird nur umgeschaltet.

const isMobile = () => window.matchMedia('(max-width: 899px)').matches;
const SHEET_STATES = ['peek', 'half', 'full'];
const SHEET_PEEK_PX = 150; // muss zu --sheet-h bei [data-sheet="peek"] in styles.css passen

function sheetState() {
  return $('.layout').dataset.sheet || 'half';
}

function setSheet(next) {
  if (!SHEET_STATES.includes(next)) return;
  $('.layout').dataset.sheet = next;
  $('#sheet-handle').setAttribute('aria-expanded', String(next === 'full'));
}

// Wie viele Pixel der Karte an jedem Rand verdeckt sind. Aus dem Zielzustand berechnet statt aus den
// aktuellen Maßen, weil das Blatt beim Umschalten noch animiert, während die Karte schon losfliegt.
function mapInsets() {
  const mapEl = $('#map');
  const m = mapEl.getBoundingClientRect();
  if (!m.height) return {};
  const row = $('.panel-row').getBoundingClientRect();
  let top = row.height ? Math.max(0, row.bottom - m.top) : 0;
  if (isMobile()) {
    const state = sheetState();
    const bottom = state === 'peek' ? SHEET_PEEK_PX : state === 'half' ? m.height * 0.5 : m.height;
    if (m.height - bottom - top < 120) top = 0; // offene Box: nicht auf einen Streifen quetschen
    return { top, bottom: Math.min(bottom, m.height - 40) };
  }
  const left = Math.max(0, $('.sidebar').getBoundingClientRect().right - m.left);
  if (m.height - top < 160) top = 0;
  return { top, left };
}

(() => {
  const handle = $('#sheet-handle');
  handle.setAttribute('aria-expanded', 'false');
  // Tippen: halb ↔ ganz (aus „peek“ auf halb). Wischen auf dem Griff: hoch = größer, runter = kleiner.
  handle.addEventListener('click', () => {
    const cur = sheetState();
    setSheet(cur === 'half' ? 'full' : 'half');
  });
  let startY = null;
  handle.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  handle.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (Math.abs(dy) < 30) return; // kurzer Tipp → normales click
    e.preventDefault(); // kein zusätzliches click nach dem Wischen
    const i = SHEET_STATES.indexOf(sheetState());
    setSheet(SHEET_STATES[Math.max(0, Math.min(SHEET_STATES.length - 1, i + (dy < 0 ? 1 : -1)))]);
  });
  // Suchen braucht Platz für Tastatur und Treffer
  $('#search').addEventListener('focus', () => { if (isMobile()) setSheet('full'); });
})();

// --- Ableitungen -------------------------------------------------------------------

function placesWithDistance() {
  const a = state.airbnb;
  return state.places.map((p) => ({
    ...p,
    distance: a && hasCoords(p) ? haversineKm(a.lat, a.lng, p.lat, p.lng) : null,
  }));
}

function filterBase(places) {
  const q = norm(state.ui.search.trim());
  if (!q) return places;
  return places.filter((p) =>
    norm(`${p.name} ${p.address} ${p.note} ${p.listName} ${p.addedBy || ''} ${catOf(p.category).label}`).includes(q));
}

function sortPlaces(list) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'de');
  const order = displayCategories().map((c) => c.id);
  const sorters = {
    distance: (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || byName(a, b),
    name: byName,
    category: (a, b) => order.indexOf(a.category) - order.indexOf(b.category) || (a.distance ?? Infinity) - (b.distance ?? Infinity) || byName(a, b),
    recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  };
  const key = state.ui.sort === 'distance' && !state.airbnb ? 'name' : state.ui.sort;
  return list.sort(sorters[key] || byName);
}

// --- Rendering -----------------------------------------------------------------------

let lastVisible = [];

function render({ fit = false } = {}) {
  const all = placesWithDistance();
  const base = filterBase(all);
  const selected = new Set(state.ui.categories);
  const visible = sortPlaces(selected.size ? base.filter((p) => selected.has(p.category)) : base);
  lastVisible = visible;

  if (activeId && !visible.some((p) => p.id === activeId)) activeId = null;
  // Gelöschte Routen (z. B. von jemand anderem in der Reise entfernt) aus der Auswahl nehmen.
  state.ui.visibleRoutes = state.ui.visibleRoutes.filter((id) => state.routes.some((r) => r.id === id));
  const visibleRoutes = state.routes.filter((r) => state.ui.visibleRoutes.includes(r.id));

  renderAirbnb();
  renderFlights();
  renderChips(base);
  renderList(visible, all.length);
  renderRoutes();
  renderShareState();

  mapView.setPlaces(visible, catOf, activeId);
  mapView.setAirbnb(state.airbnb);
  mapView.setRoutes(visibleRoutes);
  if (fit) mapView.fitTo(visible, state.airbnb);

  saveUi(state.ui);
}

function renderAirbnb() {
  const a = state.airbnb;
  // Links kommen von der fest hinterlegten Unterkunft (config.js, falls genutzt) oder – im Normalfall –
  // von den optional selbst eingetragenen Links (state.airbnb.url/.mapsUrl, siehe #airbnb-links-form).
  const links = fixedAirbnb || a;
  $('#airbnb-label').textContent = a ? a.label : 'Noch nicht festgelegt';
  $('#airbnb-label').classList.toggle('is-set', !!a);
  $('#btn-airbnb-clear').hidden = !a || !!fixedAirbnb;
  // Feste Unterkunft: Suche und Kartenauswahl ausblenden, stattdessen Link zum Inserat.
  $('#airbnb-form').hidden = !!fixedAirbnb;
  $('#btn-pick').hidden = !!fixedAirbnb;
  if (fixedAirbnb) $('#airbnb-results').hidden = true;
  // Null-sicher: lädt der Browser noch ein älteres index.html aus dem Cache, darf der Start nicht abbrechen.
  const link = $('#airbnb-link');
  if (link) {
    link.hidden = !links?.url;
    if (links?.url) link.href = links.url;
  }
  const mapsLink = $('#airbnb-maps-link');
  if (mapsLink) {
    mapsLink.hidden = !links?.mapsUrl;
    if (links?.mapsUrl) mapsLink.href = links.mapsUrl;
  }
  // "Links hinzufügen" nur bei einer selbst gesetzten (nicht fest hinterlegten) Unterkunft anbieten.
  const linksBtn = $('#btn-airbnb-links');
  if (linksBtn) linksBtn.hidden = !a || !!fixedAirbnb;
  $('.airbnb .link-row')?.classList.toggle('is-stacked', !!fixedAirbnb);
}

// Trägt Datum/Uhrzeit von Hin- und Rückflug in die Felder ein. Ein Feld, das gerade
// bearbeitet wird, bleibt unangetastet, sonst würde ein Abgleich während des Tippens stören.
function renderFlights() {
  const f = state.flights || {};
  const setVal = (id, value) => {
    const el = $(`#${id}`);
    if (el && document.activeElement !== el) el.value = value || '';
  };
  setVal('flight-out-date', f.outDate);
  setVal('flight-out-time', f.outTime);
  setVal('flight-back-date', f.backDate);
  setVal('flight-back-time', f.backTime);
}

// Rennrad-Routen: eigener Abschnitt unter den Orten, gleicher Aufbau wie die Ortsliste, aber jede
// Zeile ist ein Kippschalter – standardmäßig ist state.ui.visibleRoutes leer, also keine Route auf der Karte.
function renderRoutes() {
  const list = $('#route-list');
  if (!list) return; // Null-sicher: altes index.html im Cache
  const empty = $('#route-empty');
  const count = $('#route-count');
  const visible = new Set(state.ui.visibleRoutes);
  if (count) {
    count.textContent = state.routes.length
      ? `${visible.size} von ${state.routes.length} ${state.routes.length === 1 ? 'Route' : 'Routen'} eingeblendet`
      : '';
  }
  if (empty) empty.hidden = state.routes.length > 0;
  list.innerHTML = state.routes.map((r) => {
    const on = visible.has(r.id);
    const hm = formatHm(r.elevationGainM);
    return `<li class="place route-item${on ? ' is-on' : ''}" data-id="${r.id}" style="${categoryStyle(ROUTE_CATEGORY)}">
      <button type="button" class="place-main" data-action="toggle-route" aria-pressed="${on}" title="${on ? 'Auf der Karte ausblenden' : 'Auf der Karte einblenden'}">
        <span class="place-icon" aria-hidden="true">${categoryIcon(ROUTE_CATEGORY, { size: 18, stroke: 1.7 })}</span>
        <span class="place-body">
          <span class="place-name">${escapeHtml(r.name)}</span>
          <span class="place-meta">${hm ? `${icon('trending-up', { size: 13, stroke: 2.2 })} ${hm}` : escapeHtml(ROUTE_CATEGORY.label)}</span>
        </span>
        ${r.distanceKm != null ? `<span class="place-dist">${distanceHtml(r.distanceKm)}</span>` : ''}
        <span class="route-switch" aria-hidden="true"></span>
      </button>
      <button type="button" class="route-action" data-action="download-route" aria-label="Route „${escapeHtml(r.name)}“ als GPX herunterladen" title="Als GPX herunterladen">${icon('download', { size: 15, stroke: 1.9 })}</button>
      <button type="button" class="route-action is-danger" data-action="delete-route" aria-label="Route „${escapeHtml(r.name)}“ entfernen" title="Entfernen">${icon('trash', { size: 15, stroke: 1.9 })}</button>
    </li>`;
  }).join('');
}

// GPX-Download: bevorzugt die beim Import gespeicherte Datei in voller Auflösung mit Höhen (gemeinsame
// Reise: Tabelle route_files; lokal: nur in dieser Sitzung). Sonst wird sie aus den Kartenpunkten
// erzeugt – gröber (max. 800 Punkte) und ohne Höhenangaben, z. B. bei älteren Importen.
const gpxCache = new Map();

async function downloadRouteGpx(route) {
  let gpx = gpxCache.get(route.id);
  if (!gpx && backend.routeGpx) {
    try { gpx = await backend.routeGpx(route.id); } catch { gpx = null; }
  }
  const reduced = !gpx;
  if (reduced) gpx = buildGpx(route.name, route.points);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${route.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'route'}.gpx`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (reduced) toast('GPX aus den Kartenpunkten erstellt (ohne Höhen) – für volle Genauigkeit Route neu importieren.');
}

// Höhenmeter bergauf, z. B. „1.230 Hm“; leer bei Routen ohne Höhendaten (ältere Importe, GPX ohne <ele>)
function formatHm(m) {
  return Number.isFinite(m) ? `${Math.round(m).toLocaleString('de-DE')} Hm` : '';
}

function renderChips(base) {
  const counts = new Map();
  for (const p of base) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  const selected = new Set(state.ui.categories);
  const used = new Set(state.places.map((p) => p.category));

  const chips = displayCategories()
    .filter((c) => used.has(c.id) || selected.has(c.id) || !state.places.length)
    .map((c) => {
      const n = counts.get(c.id) || 0;
      return `<button type="button" class="chip${n ? '' : ' is-empty'}" data-cat="${c.id}" aria-pressed="${selected.has(c.id)}" style="${categoryStyle(c)}">
        <span class="chip-icon">${categoryIcon(c, { size: 15 })}</span>${escapeHtml(c.label)}<span class="chip-count">${n}</span>
      </button>`;
    });

  $('#category-chips').innerHTML =
    `<button type="button" class="chip chip-all" data-cat="" aria-pressed="${!selected.size}">Alle<span class="chip-count">${base.length}</span></button>` +
    chips.join('');
}

function renderList(visible, total) {
  const list = $('#place-list');
  const empty = $('#empty-state');
  $('#result-count').innerHTML = total
    ? `<strong>${visible.length} ${visible.length === 1 ? 'Ort' : 'Orte'}</strong> von ${total}`
    : '';

  if (!visible.length) {
    list.innerHTML = '';
    empty.hidden = false;
    empty.innerHTML = total
      ? `<div class="empty-arch" aria-hidden="true">${icon('search', { size: 24, stroke: 1.6 })}</div>
         <h3>Nichts gefunden</h3>
         <p>Kein Ort passt zu deinen Filtern.</p>
         <button type="button" class="btn btn-ghost" data-empty="reset">Filter zurücksetzen</button>`
      : `<div class="empty-arch" aria-hidden="true">${icon('glass', { size: 44, stroke: 2.4 })}</div>
         <h3>Noch keine Orte</h3>
         <p>Importiere deine gespeicherten Orte aus Google Maps – oder starte mit ein paar Beispielen.</p>
         <div class="empty-actions">
           ${restoreHint()}
           <button type="button" class="btn btn-primary" data-empty="import">Orte importieren</button>
           <button type="button" class="btn-link" data-empty="sample">Beispielorte laden</button>
         </div>`;
    return;
  }
  empty.hidden = true;

  const cats = displayCategories();
  list.innerHTML = visible.map((p) => {
    const c = catOf(p.category);
    const gmaps = p.url || (hasCoords(p) ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`);
    const dist = p.distance != null
      ? `<span class="place-dist">${distanceHtml(p.distance)}</span>`
      : !hasCoords(p) ? '<span class="place-dist is-missing" title="Kein Standort">ohne Standort</span>' : '';
    return `<li class="place${p.id === activeId ? ' is-active' : ''}" data-id="${p.id}" style="${categoryStyle(c)}">
      <button type="button" class="place-main" data-action="select" aria-expanded="${p.id === activeId}">
        <span class="place-icon" aria-hidden="true">${categoryIcon(c, { size: 18, stroke: 1.7 })}</span>
        <span class="place-body">
          <span class="place-name">${escapeHtml(p.name)}</span>
          <span class="place-meta">${escapeHtml(c.label)}${p.address ? ` · ${escapeHtml(p.address)}` : ''}</span>
        </span>
        ${dist}
      </button>
      <div class="place-details">
        ${p.note ? `<p class="place-note">${escapeHtml(p.note)}</p>` : ''}
        ${p.addedBy ? `<p class="place-by">Hinzugefügt von ${escapeHtml(p.addedBy)}</p>` : ''}
        <div class="place-actions">
          <label class="cat-select-wrap">
            <span class="visually-hidden">Kategorie</span>
            <select class="cat-select" data-action="category">
              ${cats.map((k) => `<option value="${k.id}"${k.id === p.category ? ' selected' : ''}>${optionLabel(k)}</option>`).join('')}
            </select>
          </label>
          ${!hasCoords(p) ? '<button type="button" class="chip-btn" data-action="geocode">Standort suchen</button>' : ''}
          <a class="chip-btn" href="${escapeHtml(gmaps)}" target="_blank" rel="noopener">Google Maps ${icon('external', { size: 12, stroke: 2.2 })}</a>
          <button type="button" class="chip-btn chip-btn-icon danger" data-action="delete" aria-label="Entfernen" title="Entfernen">${icon('trash', { size: 15, stroke: 1.9 })}</button>
        </div>
      </div>
    </li>`;
  }).join('');
}

// --- Auswahl ------------------------------------------------------------------------

function selectPlace(id, { fly = true, scrollList = false } = {}) {
  const toggleOff = activeId === id && fly;
  activeId = toggleOff ? null : id;
  $$('#place-list .place').forEach((li) => {
    const on = li.dataset.id === activeId;
    li.classList.toggle('is-active', on);
    $('.place-main', li).setAttribute('aria-expanded', String(on));
  });
  mapView.setActive(activeId);
  if (isMobile() && activeId) {
    // Ort aus der Liste gewählt: Karte muss sichtbar sein. Marker angetippt: Eintrag muss sichtbar sein.
    if (fly && sheetState() === 'full') setSheet('half');
    if (scrollList && sheetState() === 'peek') setSheet('half');
  }
  if (activeId && fly) mapView.focusPlace(activeId);
  if (activeId && scrollList) {
    const li = $(`#place-list .place[data-id="${CSS.escape(activeId)}"]`);
    // auf dem Handy erst nach dem Aufziehen des Blatts scrollen (Animation 0,25 s)
    setTimeout(() => li?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), isMobile() ? 280 : 0);
  }
}

// --- Airbnb ---------------------------------------------------------------------------

function setAirbnb(airbnb) {
  if (fixedAirbnb) return;
  state.airbnb = airbnb;
  if (airbnb && state.ui.sort !== 'distance') state.ui.sort = 'distance';
  $('#sort').value = state.ui.sort;
  $('#airbnb-results').hidden = true;
  render();
  persistSettings();
  if (airbnb) {
    mapView.centerOn([airbnb.lat, airbnb.lng], Math.max(mapView.map.getZoom(), 11));
    toast('Airbnb gesetzt – Entfernungen werden jetzt berechnet.');
  }
}

function setPickMode(on) {
  pickMode = on;
  $('#pick-banner').hidden = !on;
  $('#map').classList.toggle('is-picking', on);
  if (on && isMobile()) {
    // Karte freimachen: Liste nach unten, offene Boxen zu (sonst verdecken sie die Karte)
    setSheet('peek');
    $$('.panel-row details[open]').forEach((d) => { d.open = false; });
  }
}

$('#airbnb-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('#airbnb-input').value.trim();
  if (!value) return;
  const coords = parseCoords(value);
  if (coords) {
    setAirbnb({ label: value.startsWith('http') ? `Pin (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})` : value, ...coords });
    $('#airbnb-input').value = '';
    return;
  }
  const results = $('#airbnb-results');
  results.hidden = false;
  results.innerHTML = '<li class="muted">Suche …</li>';
  try {
    const hits = await geocode(value, MALLORCA_CENTER);
    results.innerHTML = hits.length
      ? hits.map((h, i) => `<li><button type="button" data-hit="${i}">${escapeHtml(h.label)}</button></li>`).join('')
      : '<li class="muted">Nichts gefunden. Versuche es mit Ort und Straße oder einem Maps-Link.</li>';
    results.onclick = (ev) => {
      const btn = ev.target.closest('[data-hit]');
      if (!btn) return;
      const h = hits[Number(btn.dataset.hit)];
      setAirbnb({ label: h.label.split(',').slice(0, 3).join(','), lat: h.lat, lng: h.lng });
      $('#airbnb-input').value = '';
    };
  } catch (err) {
    results.innerHTML = `<li class="muted">${escapeHtml(err.message)}</li>`;
  }
});

$('#btn-pick').addEventListener('click', () => setPickMode(!pickMode));
$('#btn-pick-cancel').addEventListener('click', () => setPickMode(false));
$('#btn-airbnb-clear').addEventListener('click', () => {
  state.airbnb = fixedAirbnb;
  render();
  persistSettings();
});

$('#btn-airbnb-links')?.addEventListener('click', () => {
  const form = $('#airbnb-links-form');
  const opening = form.hidden;
  form.hidden = !opening;
  if (opening) {
    $('#airbnb-link-input').value = state.airbnb?.url || '';
    $('#airbnb-mapslink-input').value = state.airbnb?.mapsUrl || '';
    $('#airbnb-link-input').focus();
  }
});

$('#airbnb-links-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.airbnb) return;
  const url = $('#airbnb-link-input').value.trim();
  const mapsUrl = $('#airbnb-mapslink-input').value.trim();
  state.airbnb = { ...state.airbnb, url, mapsUrl };
  $('#airbnb-links-form').hidden = true;
  render();
  persistSettings();
  toast('Links gespeichert');
});

// --- Hin- & Rückreise --------------------------------------------------------------------

// id="flight-out-date" → state.flights.outDate, usw.
const FLIGHT_FIELDS = {
  'flight-out-date': 'outDate',
  'flight-out-time': 'outTime',
  'flight-back-date': 'backDate',
  'flight-back-time': 'backTime',
};
for (const [id, key] of Object.entries(FLIGHT_FIELDS)) {
  $(`#${id}`)?.addEventListener('change', async (e) => {
    state.flights = { ...state.flights, [key]: e.target.value };
    if (await persistSettings()) toast('Flugzeiten gespeichert');
  });
}

// --- Filter ------------------------------------------------------------------------------

$('#search').value = state.ui.search;
$('#sort').value = state.ui.sort;

$('#search').addEventListener('input', (e) => {
  state.ui.search = e.target.value;
  render();
});
$('#sort').addEventListener('change', (e) => {
  state.ui.sort = e.target.value;
  render();
});
$('#category-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const id = chip.dataset.cat;
  if (!id) state.ui.categories = [];
  else {
    const set = new Set(state.ui.categories);
    set.has(id) ? set.delete(id) : set.add(id);
    state.ui.categories = [...set];
  }
  render();
});

function resetFilters() {
  state.ui.categories = [];
  state.ui.search = '';
  $('#search').value = '';
  render({ fit: true });
}

// --- Liste ---------------------------------------------------------------------------------

$('#place-list').addEventListener('click', async (e) => {
  const li = e.target.closest('.place');
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!li || !action) return;
  const id = li.dataset.id;
  const place = state.places.find((p) => p.id === id);
  if (!place) return;

  if (action === 'select') selectPlace(id);
  if (action === 'delete') {
    if (!confirm(`„${place.name}“ entfernen?`)) return;
    state.places = state.places.filter((p) => p.id !== id);
    render();
    persist((b) => b.deletePlace(id), 'Ort konnte nicht entfernt werden');
  }
  if (action === 'geocode') {
    await geocodeMissing([id]);
    selectPlace(id);
  }
});

$('#place-list').addEventListener('change', (e) => {
  if (e.target.dataset.action !== 'category') return;
  const id = e.target.closest('.place').dataset.id;
  const place = state.places.find((p) => p.id === id);
  if (!place) return;
  place.category = e.target.value;
  render();
  persist((b) => b.updatePlace(id, { category: place.category }));
  toast(`Kategorie geändert: ${catOf(place.category).label}`);
});

$('#route-list')?.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const id = e.target.closest('[data-id]')?.dataset.id;
  const route = state.routes.find((r) => r.id === id);
  if (!action || !route) return;

  if (action === 'toggle-route') {
    const set = new Set(state.ui.visibleRoutes);
    const turningOn = !set.has(id);
    if (turningOn) set.add(id); else set.delete(id);
    state.ui.visibleRoutes = [...set];
    render();
    if (turningOn) {
      if (isMobile() && sheetState() === 'full') setSheet('half');
      mapView.fitToRoute(route);
    }
  }
  if (action === 'download-route') await downloadRouteGpx(route);
  if (action === 'delete-route') {
    if (!confirm(`Route „${route.name}“ entfernen?`)) return;
    state.routes = state.routes.filter((r) => r.id !== id);
    state.ui.visibleRoutes = state.ui.visibleRoutes.filter((rid) => rid !== id);
    render();
    persist((b) => b.deleteRoute(id), 'Route konnte nicht entfernt werden');
  }
});

// Sicherung anbieten, wenn die lokale Liste leer ist, aber ein früherer Stand existiert.
function restoreHint() {
  const backup = backend.kind === 'local' && dataLoaded ? loadLocalBackup() : null;
  return backup
    ? `<button type="button" class="btn btn-ghost" data-empty="restore">${backup.places.length} frühere Orte wiederherstellen</button>`
    : '';
}

async function restoreBackup() {
  const backup = loadLocalBackup();
  if (!backup) return;
  // Eigene Kategorien zuerst, damit die Orte ihre Kategorie behalten.
  const known = new Set(state.customCategories.map((c) => c.id));
  const missing = (backup.customCategories || []).map(sanitizeCategory).filter((c) => !known.has(c.id));
  if (missing.length) {
    state.customCategories.push(...missing);
    await persistSettings();
  }
  const { added } = await addPlaces(backup.places);
  const restoredRoutes = await restoreRoutes(backup.routes);
  clearLocalBackup();
  render({ fit: true });
  toast(`${added.length} Orte${restoredRoutes ? ` und ${restoredRoutes} Route(n)` : ''} wiederhergestellt`);
}

$('#empty-state').addEventListener('click', (e) => {
  const what = e.target.closest('[data-empty]')?.dataset.empty;
  if (what === 'restore') restoreBackup();
  if (what === 'reset') resetFilters();
  if (what === 'import') openImport();
  if (what === 'sample') loadSample();
});

// --- Import -----------------------------------------------------------------------------

const importDialog = $('#import-dialog');

function openImport() {
  $('#import-category').innerHTML =
    '<option value="auto">Automatisch erkennen</option>' +
    displayCategories().map((c) => `<option value="${c.id}">${optionLabel(c)}</option>`).join('');
  $('#import-log').innerHTML = '';
  selectImportTab('links'); // Start immer auf „Links einfügen“ – der häufigste Weg, Orte hinzuzufügen
  importDialog.showModal();
}

function log(msg, type = '') {
  const el = document.createElement('p');
  el.className = `log-line ${type}`;
  el.textContent = msg;
  $('#import-log').append(el);
  el.scrollIntoView({ block: 'nearest' });
}

const coordKey = (p) => `${norm(p.name)}|${hasCoords(p) ? `${p.lat.toFixed(4)},${p.lng.toFixed(4)}` : '-'}`;

// Fügt neue Orte dem Zustand hinzu (ohne Duplikate) und speichert sie.
async function addPlaces(raws, override = 'auto') {
  const urls = new Set(state.places.map((p) => p.url).filter(Boolean));
  const keys = new Set(state.places.map(coordKey));
  const cats = classifyCategories();
  const by = memberName();
  const added = [];
  let dupes = 0;

  for (const raw of raws) {
    const place = {
      id: newId(),
      name: String(raw.name || 'Unbenannter Ort').trim().slice(0, 300),
      address: String(raw.address || '').slice(0, 500),
      lat: Number.isFinite(raw.lat) ? raw.lat : null,
      lng: Number.isFinite(raw.lng) ? raw.lng : null,
      url: String(raw.url || '').slice(0, 2000),
      note: String(raw.note || '').slice(0, 2000),
      listName: String(raw.listName || '').slice(0, 200),
      addedBy: String(raw.addedBy || by).slice(0, 80),
      addedAt: raw.addedAt || Date.now(),
    };
    if ((place.url && urls.has(place.url)) || keys.has(coordKey(place))) {
      dupes++;
      continue;
    }
    place.category = assignCategory(raw, cats, override);
    if (place.url) urls.add(place.url);
    keys.add(coordKey(place));
    state.places.push(place);
    added.push(place);
  }

  if (added.length) {
    render();
    const ok = await persist((b) => b.addPlaces(added), 'Orte konnten nicht gespeichert werden');
    if (!ok) return { added: [], dupes };
  }
  return { added, dupes };
}

// Übernimmt Routen aus einem Backup (Datei-Import oder automatische Sicherung), ohne Duplikate.
async function restoreRoutes(routes) {
  const known = new Set(state.routes.map((r) => r.id));
  const missing = (routes || []).filter((r) => r?.points?.length && !known.has(r.id));
  if (!missing.length) return 0;
  state.routes.push(...missing);
  render();
  await persist((b) => b.addRoutes(missing), 'Routen konnten nicht wiederhergestellt werden');
  return missing.length;
}

async function importRaw(raws, sourceLabel) {
  const override = $('#import-category-field').hidden ? 'auto' : $('#import-category').value || 'auto';
  const { added, dupes } = await addPlaces(raws, override);
  const missing = added.filter((p) => !hasCoords(p));
  log(
    `${sourceLabel}: ${added.length} neue Orte${dupes ? `, ${dupes} bereits vorhanden` : ''}${missing.length ? `, ${missing.length} ohne Standort` : ''}.`,
    added.length ? 'ok' : '',
  );
  return { added, missing };
}

// Fügt eine importierte GPX-Route hinzu. Keine Kategorie-Erkennung nötig – die Art steht fest.
async function addRoute(parsed, sourceLabel) {
  const route = {
    id: newId(),
    name: String(parsed.name || 'Route').trim().slice(0, 300),
    category: ROUTE_CATEGORY.id,
    points: parsed.points,
    distanceKm: parsed.distanceKm,
    elevationGainM: parsed.elevationGainM ?? null,
    elevationLossM: parsed.elevationLossM ?? null,
    addedBy: memberName(),
    addedAt: Date.now(),
  };
  state.routes.push(route);
  render();
  if (parsed.gpx) gpxCache.set(route.id, parsed.gpx);
  const ok = await persist((b) => b.addRoutes([route], { [route.id]: parsed.gpx }), 'Route konnte nicht gespeichert werden');
  if (!ok) {
    state.routes = state.routes.filter((r) => r.id !== route.id);
    render();
    return;
  }
  log(`${sourceLabel}: Route „${route.name}“ importiert (${formatKm(route.distanceKm)}${route.elevationGainM != null ? `, ${formatHm(route.elevationGainM)}` : ''}, standardmäßig ausgeblendet).`, 'ok');
}

async function handleFiles(files) {
  const allAdded = [];
  const allMissing = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const result = parseFile(file.name, text);
      if (result.kind === 'gpx') {
        await addRoute(result.route, file.name);
        continue;
      }
      if (result.kind === 'backup') {
        const b = result.backup;
        const known = new Set(state.customCategories.map((c) => c.id));
        state.customCategories.push(...(b.customCategories || []).map(sanitizeCategory).filter((c) => !known.has(c.id)));
        if (!state.airbnb && b.airbnb) state.airbnb = b.airbnb;
        await persistSettings();
        const restoredRoutes = await restoreRoutes(b.routes);
        if (restoredRoutes) log(`${file.name}: ${restoredRoutes} Route(n) aus dem Backup übernommen.`, 'ok');
      }
      const { added, missing } = await importRaw(result.places, file.name);
      allAdded.push(...added);
      allMissing.push(...missing);
    } catch (err) {
      log(`${file.name}: konnte nicht gelesen werden (${err.message})`, 'error');
    }
  }
  finishImport(allAdded, allMissing);
}

function finishImport(added, missing) {
  render({ fit: added.length > 0 });
  if (added.length) toast(`${added.length} Orte importiert`);
  if (missing.length) {
    if ($('#import-geocode').checked) geocodeMissing(missing.map((p) => p.id));
    else log('Orte ohne Standort erscheinen in der Liste, aber nicht auf der Karte. Über „Standort suchen“ kannst du sie ergänzen.');
  }
}

async function geocodeMissing(ids) {
  if (geocodeRunning) return toast('Standortsuche läuft bereits …');
  geocodeRunning = true;
  let found = 0;
  try {
    for (let i = 0; i < ids.length; i++) {
      const place = state.places.find((p) => p.id === ids[i]);
      if (!place || hasCoords(place)) continue;
      toast(`Suche Standorte … ${i + 1}/${ids.length}`, { sticky: true });
      const near = state.airbnb || MALLORCA_CENTER;
      let hits = await geocode([place.name, place.address].filter(Boolean).join(', '), near);
      if (!hits.length && place.address) hits = await geocode(place.address, near);
      if (hits.length) {
        place.lat = hits[0].lat;
        place.lng = hits[0].lng;
        if (!place.address) place.address = hits[0].label.split(',').slice(0, 3).join(',');
        found++;
        render();
        await persist((b) => b.updatePlace(place.id, { lat: place.lat, lng: place.lng, address: place.address }));
      } else {
        log(`Kein Standort gefunden für „${place.name}“.`, 'error');
      }
    }
    toast(`${found} von ${ids.length} Standorten gefunden`);
    if (ids.length > 1) log(`Standortsuche fertig: ${found} von ${ids.length} gefunden.`, found ? 'ok' : '');
  } catch (err) {
    toast(`Standortsuche abgebrochen: ${err.message}`);
    log(`Standortsuche abgebrochen: ${err.message}`, 'error');
  } finally {
    geocodeRunning = false;
    render();
  }
}

async function loadSample() {
  try {
    const res = await fetch('data/sample-places.json');
    const data = await res.json();
    const { added } = await addPlaces(parseGeoJSON(data, 'Beispiele'));
    if (!state.airbnb) {
      state.airbnb = { label: 'Beispiel-Airbnb in Sóller', lat: 39.7671, lng: 2.7153 };
      await persistSettings();
    }
    importDialog.close();
    render({ fit: true });
    toast(added.length ? `${added.length} Beispielorte geladen` : 'Beispielorte sind schon da');
  } catch (err) {
    toast(`Beispiele konnten nicht geladen werden (${err.message})`);
  }
}

$('#btn-import').addEventListener('click', openImport);
$('#btn-sample').addEventListener('click', loadSample);
$('#file-input').addEventListener('change', (e) => {
  handleFiles([...e.target.files]);
  e.target.value = '';
});

const dropzone = $('#dropzone');
['dragenter', 'dragover'].forEach((t) =>
  dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-over');
  }));
['dragleave', 'drop'].forEach((t) =>
  dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-over');
  }));
dropzone.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));

$('#btn-parse-links').addEventListener('click', async () => {
  const text = $('#links-input').value.trim();
  if (!text) return;
  const { added, missing } = await importRaw(parseLinks(text, 'Eingefügt'), 'Eingefügte Links');
  $('#links-input').value = '';
  finishImport(added, missing);
});

function selectImportTab(name) {
  $$('.tab', importDialog).forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  });
  $$('.tab-panel', importDialog).forEach((p) => (p.hidden = p.dataset.panel !== name));
  // Kategorie-Auswahl und GPX-Hinweis nur bei Dateien: Links werden automatisch zugeordnet,
  // die Kategorie lässt sich danach in der Liste pro Ort ändern.
  $('#import-category-field').hidden = name !== 'file';
  $('#import-gpx-hint').hidden = name !== 'file';
}

$$('.tab', importDialog).forEach((tab) => tab.addEventListener('click', () => selectImportTab(tab.dataset.tab)));

// Dialoge: Schließen-Buttons + Klick auf den Hintergrund
$$('dialog').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
  });
});

// --- Teilen / gemeinsame Reise ------------------------------------------------------------

const shareDialog = $('#share-dialog');

function setSyncStatus(text) {
  const el = $('#sync-status');
  if (el) el.textContent = text;
}

function renderShareState() {
  const shared = backend.kind === 'shared';
  $('#btn-share').classList.toggle('is-shared', shared);
  $('#btn-share .btn-label').textContent = shared ? 'Gemeinsam' : 'Teilen';
  if (shareDialog.open) renderShareDialog();
}

function renderShareDialog() {
  const body = $('#share-body');
  if (backend.kind === 'shared') {
    const time = lastSync ? lastSync.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
    body.innerHTML = `
      <p class="share-text">Alle mit diesem Link sehen dieselben Orte und können welche hinzufügen, ändern und löschen. Teile ihn nur mit Leuten, die mitplanen sollen.</p>
      <div class="share-link">
        <label class="visually-hidden" for="share-link">Link zur Reise</label>
        <input id="share-link" type="text" readonly value="${escapeHtml(shareUrl(backend.key))}">
        <button id="btn-copy-link" class="btn btn-primary" type="button">Link kopieren</button>
      </div>
      <p class="hint" id="sync-status">Zuletzt abgeglichen um ${time} · aktualisiert sich alle 20 Sekunden</p>
      <button id="btn-leave-trip" class="btn-link muted" type="button">Reise auf diesem Gerät verlassen</button>`;
  } else if (sharingConfigured()) {
    const n = state.places.length;
    body.innerHTML = `
      <p class="share-text">${n ? `Deine ${n} Orte liegen` : 'Deine Orte liegen'} gerade nur in diesem Browser. Starte eine gemeinsame Reise: Die Orte werden hochgeladen, und alle mit dem Link sehen dieselbe Liste – auf jedem Gerät, auch unterwegs.</p>
      <button id="btn-start-trip" class="btn btn-primary" type="button">Gemeinsame Reise starten</button>`;
  } else {
    body.innerHTML = `
      <p class="share-text">Damit andere mitplanen können, braucht die App eine kleine Datenbank (Supabase, kostenlos). Die Einrichtung dauert etwa 15 Minuten – Schritt für Schritt in <strong>ANLEITUNG.md</strong> im Projektordner.</p>
      <p class="hint">Bis dahin bleiben deine Orte in diesem Browser gespeichert.</p>`;
  }
}

function openShare() {
  $('#member-name').value = memberName();
  renderShareDialog();
  shareDialog.showModal();
}

async function startTrip() {
  const btn = $('#btn-start-trip');
  btn.disabled = true;
  btn.textContent = 'Wird eingerichtet …';
  try {
    const key = newTripKey();
    const shared = await SharedBackend.connect(key);
    const by = memberName();
    const places = state.places.map((p) => ({ ...p, addedBy: p.addedBy || by }));
    await shared.saveSettings({ airbnb: state.airbnb, customCategories: state.customCategories });
    if (places.length) await shared.addPlaces(places);
    switchTo(shared);
    toast('Gemeinsame Reise gestartet – jetzt den Link teilen');
    await refresh({ fit: true });
  } catch (err) {
    toast(`Reise konnte nicht gestartet werden: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Gemeinsame Reise starten';
  }
}

function switchTo(next) {
  backend = next;
  if (next.kind === 'shared') {
    rememberTripKey(next.key);
    history.replaceState(null, '', shareUrl(next.key));
  } else {
    forgetTripKey();
    history.replaceState(null, '', location.pathname);
  }
  renderShareState();
}

async function leaveTrip() {
  if (!confirm('Reise auf diesem Gerät verlassen? Die gemeinsamen Orte bleiben erhalten – du kommst über den Link jederzeit zurück.')) return;
  switchTo(new LocalBackend(() => state));
  await refresh({ fit: true });
  toast('Du siehst wieder deine lokalen Orte');
}

async function copyLink() {
  const input = $('#share-link');
  try {
    await navigator.clipboard.writeText(input.value);
    toast('Link kopiert');
  } catch {
    input.select();
    toast('Link markiert – jetzt kopieren');
  }
}

$('#btn-share').addEventListener('click', openShare);
$('#share-body').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  if (id === 'btn-start-trip') startTrip();
  if (id === 'btn-copy-link') copyLink();
  if (id === 'btn-leave-trip') leaveTrip();
});
$('#member-name').addEventListener('input', (e) => writePref('name', e.target.value.trim().slice(0, 40)));

// --- Kategorien verwalten -------------------------------------------------------------------

const categoryDialog = $('#category-dialog');

function renderCategoryManager() {
  const counts = new Map();
  for (const p of state.places) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  const custom = new Set(state.customCategories.map((c) => c.id));
  $('#category-manage-list').innerHTML = displayCategories().map((c) => `
    <li style="${categoryStyle(c)}">
      <span class="place-icon" aria-hidden="true">${categoryIcon(c, { size: 16, stroke: 1.7 })}</span>
      <span class="cm-label">${escapeHtml(c.label)}</span>
      <span class="cm-count">${counts.get(c.id) || 0}</span>
      ${custom.has(c.id) ? `<button type="button" class="btn-link muted" data-delete-cat="${c.id}">Löschen</button>` : '<span class="cm-fixed">Standard</span>'}
    </li>`).join('');
}

$('#category-manage-list').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-delete-cat]')?.dataset.deleteCat;
  if (!id) return;
  const cat = catOf(id);
  if (!confirm(`Kategorie „${cat.label}“ löschen? Orte darin werden zu „Sonstiges“.`)) return;
  const affected = state.places.filter((p) => p.category === id);
  state.customCategories = state.customCategories.filter((c) => c.id !== id);
  affected.forEach((p) => { p.category = FALLBACK_CATEGORY; });
  state.ui.categories = state.ui.categories.filter((c) => c !== id);
  renderCategoryManager();
  render();
  await persistSettings();
  for (const p of affected) await persist((b) => b.updatePlace(p.id, { category: FALLBACK_CATEGORY }));
});

$('#category-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const label = String(f.get('label')).trim();
  if (!label) return;
  const slug = norm(label).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kategorie';
  state.customCategories.push(sanitizeCategory({
    id: `${slug}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    emoji: String(f.get('emoji')).trim(),
    color: String(f.get('color')),
    keywords: String(f.get('keywords') || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
  }));
  e.target.reset();
  renderCategoryManager();
  render();
  persistSettings();
  toast(`Kategorie „${label}“ angelegt`);
});

// --- Menü -------------------------------------------------------------------------------------

$('.menu-panel').addEventListener('click', async (e) => {
  const what = e.target.closest('[data-menu]')?.dataset.menu;
  if (!what) return;
  $('.menu').open = false;
  if (what === 'categories') {
    renderCategoryManager();
    categoryDialog.showModal();
  }
  if (what === 'backup') downloadBackup(state);
  if (what === 'fit') mapView.fitTo(lastVisible, state.airbnb);
  if (what === 'reset') {
    const where = backend.kind === 'shared' ? ' – für alle in dieser gemeinsamen Reise' : '';
    if (!confirm(`Wirklich alle Orte, das Airbnb und eigene Kategorien löschen${where}?`)) return;
    state.places = [];
    state.airbnb = fixedAirbnb;
    state.customCategories = [];
    state.ui.categories = [];
    $('#search').value = '';
    state.ui.search = '';
    render({ fit: true });
    await persist((b) => b.deleteAllPlaces());
    await persistSettings();
  }
});
document.addEventListener('click', (e) => {
  const menu = $('.menu');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickMode) setPickMode(false);
});

// --- Toast ------------------------------------------------------------------------------------

let toastTimer;
function toast(msg, { sticky = false } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

// --- Start ------------------------------------------------------------------------------------

async function boot() {
  try {
    render();
  } catch (err) {
    console.error(err);
  }
  const key = tripKeyFromUrl() || rememberedTripKey();
  if (key) {
    if (!sharingConfigured()) {
      toast('Dieser Link gehört zu einer gemeinsamen Reise, aber die Datenbank ist hier nicht eingerichtet.');
    } else {
      try {
        switchTo(await SharedBackend.connect(key));
      } catch (err) {
        toast(`Gemeinsame Reise nicht erreichbar: ${err.message}`);
      }
    }
  }
  await refresh({ fit: true });

  // Gemeinsame Reise: regelmäßig und beim Zurückkehren in die App abgleichen.
  setInterval(() => {
    if (backend.kind === 'shared' && document.visibilityState === 'visible') refresh();
  }, SYNC_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (backend.kind === 'shared' && document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('hashchange', () => {
    const next = tripKeyFromUrl();
    if (next && next !== backend.key) location.reload();
  });
}

// Welche Version läuft gerade? (Zahl aus index.html, von deploy.sh erhöht) – hilft zu erkennen,
// ob z. B. die App auf dem Home-Bildschirm noch einen alten Stand zeigt.
$('#app-version').textContent = `Version ${document.querySelector('link[href*="styles.css"]')?.href.match(/v=([\d.-]+)/)?.[1] || '–'}`;

boot();
window.addEventListener('resize', () => mapView.invalidate());
