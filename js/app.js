import { DEFAULT_CATEGORIES, FALLBACK_CATEGORY, ROUTE_CATEGORY, routeColor } from './categories.js';
import { haversineKm, hasCoords, parseCoords, formatKm, geocode, formatReservation, routeUrl, homeRouteUrl } from './geo.js';
import { parseFile, parseGeoJSON, parseLinks, assignCategory, buildGpx } from './importers.js';
import { loadUi, saveUi, readPref, writePref, downloadBackup, newId, newTripKey, loadLocalBackup, clearLocalBackup } from './store.js';
import { expandMapsLinks, hasShortMapsLinks,
  DemoBackend, SharedBackend, OfflineBackend, sharingConfigured, tripKeyFromUrl,
  rememberedTripKey, rememberTripKey, forgetTripKey, shareUrl, rememberTripCode, forgetTripCode, validTripCodeChars,
} from './backend.js';
import { createMap } from './map.js';
import { sanitizeHours, hoursStale, openAt, hoursStatus } from './hours.js';
import { cachedPois, loadPois, sanitizePois, POI_TYPES } from './pois.js';
import { FIXED_AIRBNB, GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_MAP_ID } from './config.js';
import { icon, categoryIcon, categoryStyle } from './icons.js';
import { formatEuro, formatChf, toRappen, toEuroCents, cachedRate, loadRate, parseAmount, parseShare, computeBalances, settle, splitCents, sharesOf, expenseTotal, isTransfer, coffeeTurns, sanitizeParticipants, sanitizeExpense } from './cash.js';

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
  // Importierte GPX-Strecken (Linien statt Punkte) – separat von places, siehe renderRoutes().
  routes: [],
  // Reisekasse: [{ id, name }] und Rechnungen (siehe js/cash.js)
  participants: [],
  expenses: [],
  cashMissing: false, // gemeinsame Reise, aber Tabelle/Spalte in Supabase fehlt noch
  cashExtrasMissing: false, // gemeinsame Reise, aber Spalten für Franken/Aufteilung/Ausgleich fehlen noch
  ui: loadUi(),
};

// Ohne gültigen Reise-Link läuft die Demo (Beispieldaten nur im Speicher); mit Link + Code die gemeinsame Reise
let backend = new DemoBackend(() => state);
// „…/#demo“ zeigt immer die Demo – auch auf Geräten, die sich eine Reise gemerkt haben (die bleibt gemerkt)
const demoForced = /(?:^#|&)demo\b/i.test(location.hash);
let activeId = null;
let pickMode = false;
let airbnbFormAuto = false; // Unterkunft-Formular nur geöffnet, weil noch keine Unterkunft eingetragen war
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
  for (const p of state.places) if (p.hours) p.hours = sanitizeHours(p.hours);
  state.routes = Array.isArray(data.routes) ? data.routes : [];
  for (const r of state.routes) r.pois = sanitizePois(r.pois);
  state.airbnb = fixedAirbnb || data.airbnb || null;
  state.customCategories = (data.customCategories || []).map(sanitizeCategory);
  state.participants = sanitizeParticipants(data.participants);
  state.expenses = (data.expenses || []).map(sanitizeExpense).filter(Boolean);
  state.cashMissing = Boolean(data.cashMissing);
  state.cashExtrasMissing = Boolean(data.cashExtrasMissing);
  state.hoursMissing = Boolean(data.hoursMissing);
  state.poisMissing = Boolean(data.poisMissing);
}

// Führt eine Speicher-Operation aus. Schlägt sie in einer gemeinsamen Reise fehl,
// wird der Serverstand neu geladen, damit die Anzeige nicht von der Datenbank abweicht.
async function persist(op, failMsg = 'Änderung konnte nicht gespeichert werden') {
  if (!dataLoaded) {
    toast('Die Orte werden noch geladen – bitte kurz warten und noch einmal versuchen.');
    return false;
  }
  pendingWrites++;
  let failed = false;
  try {
    await op(backend);
    lastSync = new Date();
    return true;
  } catch (err) {
    toast(backend.offline ? 'Ohne Netz lässt sich nichts ändern – sobald wieder Verbindung besteht, klappt es.'
      : /row-level security/i.test(err.message)
      ? `${failMsg}: Zugriff abgelehnt – vermutlich wurde der Zugangscode geändert.`
      : `${failMsg}: ${err.message}`);
    failed = true;
    return false;
  } finally {
    pendingWrites--;
    // Erst nach dem Herunterzählen neu laden – vorher bricht refresh() wegen des laufenden Schreibvorgangs ab.
    // Signatur leeren, damit der Serverstand auch dann übernommen wird, wenn er sich nicht geändert hat.
    // Läuft absichtlich ohne await: Die Aufrufer setzen ihre Änderung zuerst zurück, danach gilt der Server.
    if (failed && backend.kind === 'shared') {
      lastSignature = '';
      refresh();
    }
  }
}

const persistSettings = () =>
  persist((b) => b.saveSettings({ airbnb: state.airbnb, customCategories: state.customCategories }));

let lastSignature = '';

async function refresh({ fit = false } = {}) {
  if (pendingWrites > 0 && !fit) return;
  if (document.getElementById('code-dialog').open) return; // Zugangscode wird gerade abgefragt
  if (backend.offline && navigator.onLine && await reconnect()) return;
  try {
    const data = await backend.load();
    if (!backend.offline) lastSync = new Date();
    const signature = JSON.stringify(data);
    if (signature === lastSignature && !fit) {
      if (shareDialog.open) renderShareDialog();
      return;
    }
    lastSignature = signature;
    if (backend.kind === 'shared' && !backend.offline) saveOfflineSnapshot(backend.key, data);
    applyData(data);
    dataLoaded = true;
    render({ fit });
  } catch (err) {
    // Zugangscode inzwischen geändert (oder auf diesem Gerät nie eingegeben): neu abfragen
    if (err.code === 'CODE_REQUIRED') return showCodeLogin(backend.key, true);
    if (backend.kind === 'shared') setSyncStatus(`Keine Verbindung (${err.message})`);
    else toast(`Orte konnten nicht geladen werden: ${err.message}`);
  }
}

// --- Karte -------------------------------------------------------------------------

const mapOptions = {
  // Popup beim Antippen einer eingeblendeten Etappe: alle Angaben wie in der aufgeklappten Liste
  routePopup: (r, color) => routePopupHtml(r, color),
  // true = Klick verarbeitet (die Google-Variante zeigt sonst Details zu angetippten Google-Orten)
  onMapClick: (latlng) => {
    if (!pickMode) return false;
    setPickMode(false);
    // Bezeichnung und Adresse aus dem Formular übernehmen; die Route führt weiterhin zur Adresse
    const name = $('#airbnb-name-input').value.trim().slice(0, 120);
    const address = $('#airbnb-address-input').value.trim().slice(0, 300);
    const url = cleanLink($('#airbnb-url-input').value) || '';
    const mapsUrl = cleanLink($('#airbnb-maps-input').value) || '';
    setAirbnb({ ...(state.airbnb || {}), name, address, url, mapsUrl, label: airbnbLabel(name, address) || `Gewählter Punkt (${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)})`, lat: latlng.lat, lng: latlng.lng });
    return true;
  },
  onMarkerClick: (id) => selectPlace(id, { fly: false, scrollList: true }),
  onLocateMessage: (kind, detail) => locateProblem(kind, detail),
  getInsets: mapInsets,
};

// Kartenvariante: Standard Google Maps, OpenStreetMap (Leaflet) als Alternative – umschaltbar über den
// Schalter „Google | OSM“ auf der Karte oder per ?karte=google|osm in der Adresse (beides wird pro Gerät
// gemerkt). Ohne API-Schlüssel in config.js immer OpenStreetMap, ohne Schalter.
const MAP_VARIANTS = ['osm', 'google'];
const mapParam = new URLSearchParams(location.search).get('karte');
if (MAP_VARIANTS.includes(mapParam)) writePref('map', mapParam);
const wantedMap = MAP_VARIANTS.includes(mapParam) ? mapParam : readPref('map') || 'google';
// Ohne Netz OpenStreetMap: Google Maps lädt offline keine Karte, gesehene OSM-Kacheln hält sw.js vor.
// „Ohne Netz“ heisst: der Browser meldet offline, oder die App ist in dieser Sitzung schon auf den
// gespeicherten Stand ausgewichen (Handy mit Empfang, aber ohne Daten meldet sich oft trotzdem „online“).
const OFFLINE_MAP_FLAG = 'llocs.offlineMap';
const offlineSession = (() => { try { return sessionStorage.getItem(OFFLINE_MAP_FLAG) === '1'; } catch { return false; } })();
const mapVariant = wantedMap === 'google' && GOOGLE_MAPS_API_KEY && navigator.onLine && !offlineSession ? 'google' : 'osm';

const mapView = mapVariant === 'google' ? createGoogleMapView($('#map')) : createMap($('#map'), mapOptions);
if (mapVariant === 'osm') mountMapSwitch('osm');

// Schalter „Google | OSM“ unten rechts auf der Karte. Bei Google sitzt er vorne in der Knopfreihe von
// map-google.js (Satellit), bei OpenStreetMap in einer eigenen Reihe. shown = angezeigte Karte.
function mountMapSwitch(shown) {
  if (!GOOGLE_MAPS_API_KEY) return;
  const parent = $('#map').parentElement;
  let row = parent.querySelector('.gmap-tools');
  if (!row || shown === 'osm') {
    row?.remove(); // Knopfreihe einer gescheiterten Google-Karte
    row = document.createElement('div');
    row.className = 'gmap-tools map-tools-osm';
    parent.append(row);
  }
  const sw = document.createElement('div');
  sw.className = 'map-switch';
  sw.setAttribute('role', 'group');
  sw.setAttribute('aria-label', 'Kartenart');
  sw.innerHTML = [['google', 'Google'], ['osm', 'OSM']]
    .map(([v, label]) => `<button type="button" data-map="${v}" aria-pressed="${v === shown}"${v === 'osm' ? ' title="OpenStreetMap"' : ''}>${label}</button>`)
    .join('');
  sw.addEventListener('click', (e) => {
    const next = e.target.closest('[data-map]')?.dataset.map;
    if (next && next !== shown) switchMap(next);
  });
  row.prepend(sw);
}

function switchMap(next) {
  writePref('map', next);
  // ?karte=… aus der Adresse entfernen, sonst würde es die neue Wahl beim Neuladen überschreiben. Danach
  // ausdrücklich neu laden: location.replace() mit gleicher Adresse und „#reise=…“ lädt nicht neu.
  const url = new URL(location.href);
  url.searchParams.delete('karte');
  history.replaceState(null, '', url.href);
  location.reload();
}

// Google lädt asynchron: bis dahin nimmt ein Platzhalter alle Aufrufe an, danach wird neu gezeichnet.
// Scheitert Google (Schlüssel, Netz, Zeitüberschreitung), übernimmt automatisch OpenStreetMap.
function createGoogleMapView(el) {
  let impl = null;
  const view = { map: { getZoom: () => impl?.map.getZoom() ?? 9 } };
  for (const k of ['setPlaces', 'setAirbnb', 'setActive', 'focusPlace', 'fitTo', 'setRoutes', 'fitToRoute', 'centerOn', 'setPois', 'searchPlaces', 'openSearchResult', 'clearSearchMarker', 'locate', 'invalidate']) {
    view[k] = (...args) => impl?.[k](...args);
  }
  const ready = (m, shown) => {
    impl = m;
    view.map = m.map;
    mountMapSwitch(shown);
    if (shown === 'google') initMapSearch();
    render({ fit: true });
  };
  import('./map-google.js')
    .then(({ createGoogleMap, categoryFromGoogleTypes }) => createGoogleMap(el, {
      ...mapOptions,
      apiKey: GOOGLE_MAPS_API_KEY,
      mapId: GOOGLE_MAPS_MAP_ID,
      onAddPlace: (g) => addGooglePlace(g, categoryFromGoogleTypes(g.types)),
      onError: (msg) => toast(msg, { sticky: true }),
    }))
    .then((m) => ready(m, 'google'))
    .catch((err) => {
      console.error(err);
      toast(`Google Maps nicht verfügbar (${err.message}) – OpenStreetMap wird angezeigt.`);
      el.innerHTML = '';
      ready(createMap(el, mapOptions), 'osm');
    });
  return view;
}

// --- Suche auf der Google-Karte ---------------------------------------------------------------
// Ein Feld in der Boxen-Reihe über der Karte. Treffer: oben passende eigene Orte (aus den gerade
// sichtbaren), darunter Google-Vorschläge. Ein Google-Treffer öffnet das Detailfenster mit
// „Zu unseren Orten hinzufügen“; ein eigener Ort wird wie aus der Liste ausgewählt.
function initMapSearch() {
  const box = $('#map-search');
  const input = $('#map-search-input');
  const list = $('#map-search-results');
  const clearBtn = $('#map-search-clear');
  box.hidden = false;
  let items = [];
  let active = -1;
  let seq = 0;
  let timer = 0;

  const place = () => {
    const r = input.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 6}px`;
    list.style.width = `${r.width}px`;
    list.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 24)}px`;
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const row = (it, i, title, sub, iconHtml) => `<li role="option" id="msr-${i}" aria-selected="${i === active}">
      <button type="button" class="msr-item" data-i="${i}" tabindex="-1">${iconHtml}<span class="msr-text"><strong>${escapeHtml(title)}</strong>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></button>
    </li>`;
  function draw(note = '') {
    const own = items.filter((it) => it.kind === 'own');
    const goo = items.filter((it) => it.kind === 'google');
    let html = '';
    if (own.length) {
      html += '<li class="msr-head" role="presentation">Eure Orte</li>';
      html += own.map((it) => {
        const c = catOf(it.place.category);
        return row(it, items.indexOf(it), it.place.name, [c.label, it.place.address].filter(Boolean).join(' · '),
          `<span class="msr-icon" style="${categoryStyle(c)}">${categoryIcon(c, { size: 15, stroke: 2 })}</span>`);
      }).join('');
    }
    if (goo.length || note) html += '<li class="msr-head" role="presentation">Google Maps</li>';
    html += goo.map((it) => row(it, items.indexOf(it), it.name, it.sub, `<span class="msr-icon msr-google">${icon('pin', { size: 15, stroke: 2 })}</span>`)).join('');
    if (note) html += `<li class="msr-note" role="presentation">${escapeHtml(note)}</li>`;
    if (!html) return close();
    list.innerHTML = html;
    place();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `msr-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  async function search(q) {
    const my = ++seq;
    const n = norm(q);
    const own = n
      ? lastVisible.filter((p) => hasCoords(p) && (norm(p.name).includes(n) || norm(p.address).includes(n))).slice(0, 4)
      : [];
    items = own.map((p) => ({ kind: 'own', place: p }));
    active = -1;
    if (q.length < 2) return draw();
    draw('Suche läuft …');
    try {
      const found = (await mapView.searchPlaces(q)) || [];
      if (my !== seq) return; // inzwischen weitergetippt
      items = [...items, ...found.map((g) => ({ kind: 'google', ...g }))];
      draw(found.length ? '' : 'Keine Treffer bei Google.');
    } catch (err) {
      if (my === seq) draw(err.message);
    }
  }

  async function pick(i) {
    const it = items[i];
    if (!it) return;
    close();
    input.blur(); // Handy: Tastatur schliessen, damit die Karte frei ist
    if (isMobile() && sheetState() === 'full') setSheet('half');
    if (it.kind === 'own') {
      input.value = it.place.name;
      if (activeId === it.place.id) mapView.focusPlace(it.place.id);
      else selectPlace(it.place.id, { fly: true, scrollList: true });
      return;
    }
    input.value = it.name;
    try {
      await mapView.openSearchResult(it.placeId);
    } catch (err) {
      toast(err.message, { sticky: true });
    }
  }

  function clear() {
    input.value = '';
    clearBtn.hidden = true;
    items = [];
    seq++;
    close();
    mapView.clearSearchMarker();
  }

  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    clearTimeout(timer);
    const q = input.value.trim();
    timer = setTimeout(() => search(q), q.length < 2 ? 0 : 250); // nicht bei jedem Buchstaben fragen
  });
  input.addEventListener('focus', () => { if (items.length) draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) pick(active >= 0 ? active : 0);
    } else if (e.key === 'Escape') {
      if (!list.hidden) close();
      else clear();
    }
  });
  clearBtn.addEventListener('click', () => { clear(); input.focus(); });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-i]');
    if (btn) pick(Number(btn.dataset.i));
  });
  document.addEventListener('pointerdown', (e) => {
    if (!list.hidden && !box.contains(e.target) && !list.contains(e.target)) close();
  });
  addEventListener('resize', () => { if (!list.hidden) place(); });
  $('.panel-row').addEventListener('scroll', () => { if (!list.hidden) place(); }, { passive: true });
}

// --- Öffnungszeiten ----------------------------------------------------------------------------
// Menü „Öffnungszeiten laden“: für alle Orte ohne (oder mit veralteten) Öffnungszeiten bei Google nachschlagen.
// Strände und Aussichtspunkte werden übersprungen – dort gibt es keine. Neue Orte aus dem Google-Fenster
// bringen ihre Öffnungszeiten gleich mit.
const HOURS_SKIP = new Set(['strand', 'aussicht']);
let hoursLoading = false;
async function loadOpeningHours() {
  if (hoursLoading) return;
  if (!GOOGLE_MAPS_API_KEY) return toast('Für Öffnungszeiten fehlt der Google-API-Schlüssel in js/config.js.', { sticky: true });
  if (backend.kind === 'shared' && state.hoursMissing) {
    return toast('Öffnungszeiten sind in der Datenbank noch nicht eingerichtet – bitte supabase/schema.sql im Supabase SQL Editor ausführen.', { sticky: true });
  }
  const todo = state.places.filter((p) => hasCoords(p) && !HOURS_SKIP.has(p.category) && hoursStale(p.hours));
  if (!todo.length) return toast('Die Öffnungszeiten sind bei allen Orten aktuell.');
  hoursLoading = true;
  let done = 0;
  let found = 0;
  toast(`Öffnungszeiten werden geladen … 0 von ${todo.length}`, { sticky: true });
  try {
    const { lookupHours } = await import('./map-google.js');
    await lookupHours(GOOGLE_MAPS_API_KEY, todo, async (p, hours) => {
      done++;
      if (hours.p) found++;
      const place = state.places.find((x) => x.id === p.id);
      if (!place) return;
      const before = place.hours;
      place.hours = hours;
      const ok = await persist((b) => b.updatePlace(place.id, { hours }), 'Öffnungszeiten konnten nicht gespeichert werden');
      if (!ok) {
        place.hours = before;
        throw new Error('Speichern fehlgeschlagen');
      }
      toast(`Öffnungszeiten werden geladen … ${done} von ${todo.length}`, { sticky: true });
    });
    toast(`Öffnungszeiten geladen: bei ${found} von ${todo.length} Orten gefunden.${found ? ' Filter „Jetzt offen“ steht oben bei den Arten.' : ''}`);
  } catch (err) {
    toast(`Öffnungszeiten nicht vollständig geladen – ${err.message}`, { sticky: true });
  } finally {
    hoursLoading = false;
    render();
  }
}

// „Offen bis …“ / „Jetzt offen“ hängen von der Uhrzeit ab: jede Minute prüfen, ob sich ein Status geändert hat
let hoursSig = '';
setInterval(() => {
  if (!state.places.some((p) => p.hours?.p)) return;
  const sig = state.places.map((p) => hoursStatus(p.hours)?.text || '').join('|');
  if (sig === hoursSig) return;
  hoursSig = sig;
  render();
}, 60000);

// Aus dem Google-Detailfenster: Ort in die eigene Liste übernehmen. Rückgabe steuert den Knopftext.
async function addGooglePlace(g, categoryId) {
  const { added, dupes } = await addPlaces([{ name: g.name, address: g.address, lat: g.lat, lng: g.lng, url: g.url, hours: g.hours }], categoryId || 'auto');
  if (added.length) {
    toast(`„${added[0].name}“ hinzugefügt (${catOf(added[0].category).label})`);
    return 'added';
  }
  if (dupes) {
    toast('Dieser Ort ist schon in eurer Liste.');
    return 'dupe';
  }
  return 'error';
}

// --- Handy: Liste als Blatt über der Karte ------------------------------------------------
// Unter 900px liegt die Seitenleiste als Blatt unten über der randlosen Karte (wie auf dem Desktop
// schwebend, nur von unten). Höhen: „hidden“ (ganz eingeklappt, nur Knopf „Orte & Filter“),
// „half“ (Standard), „full“ (ganze Liste).
// Die Höhen selbst stehen in styles.css (--sheet-h); hier wird nur umgeschaltet.

const isMobile = () => window.matchMedia('(max-width: 899px)').matches;
const SHEET_STATES = ['hidden', 'half', 'full'];
const SHEET_HIDDEN_PX = 66; // Platz für den Knopf „Orte & Filter“, siehe [data-sheet="hidden"] in styles.css

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
    const bottom = state === 'hidden' ? SHEET_HIDDEN_PX : state === 'half' ? m.height * 0.5 : m.height;
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
  // Tippen: halb ↔ ganz. Wischen auf dem Griff: hoch = größer, runter = kleiner (halb → ganz eingeklappt).
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
    if (e.cancelable) e.preventDefault(); // kein zusätzliches click nach dem Wischen (nur wenn der Browser es zulässt)
    // Langer Wisch nach unten klappt direkt ganz ein; sonst eine Stufe weiter
    const step = dy > 220 ? -SHEET_STATES.length : dy < 0 ? 1 : -1;
    const i = SHEET_STATES.indexOf(sheetState());
    setSheet(SHEET_STATES[Math.max(0, Math.min(SHEET_STATES.length - 1, i + step))]);
  });
  // Eingeklappt: ein Tipp auf „Orte & Filter“ holt das Blatt auf halbe Höhe zurück
  $('#sheet-open').addEventListener('click', () => setSheet('half'));
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
    norm(`${p.name} ${p.address} ${p.note} ${p.listName} ${p.addedBy || ''} ${catOf(p.category).label} ${p.reservation ? 'reserviert' : ''} ${p.starred ? 'favorit' : ''}`).includes(q));
}

// Nächster Termin zuerst; Reservierungen ohne Datum/Uhrzeit ans Ende, darunter nach Name
function sortByReservation(list) {
  const key = (p) => `${p.reservation?.date || '9999-99-99'}T${p.reservation?.time || '99:99'}`;
  return list.sort((a, b) => key(a).localeCompare(key(b)) || a.name.localeCompare(b.name, 'de'));
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
let listItems = new Map(); // Ortsliste: id → { html, el } (siehe patchList)

function render({ fit = false } = {}) {
  const all = placesWithDistance();
  const base = filterBase(all);
  const selected = new Set(state.ui.categories);
  // Filter „Reserviert“ lässt sich mit den Kategorien kombinieren und sortiert nach Termin statt nach Entfernung
  if (state.ui.reserved && !state.places.some((p) => p.reservation)) state.ui.reserved = false;
  if (state.ui.starred && !state.places.some((p) => p.starred)) state.ui.starred = false;
  if (state.ui.openNow && !state.places.some((p) => p.hours?.p)) state.ui.openNow = false;
  // „Reserviert“, „Favoriten“ und „Jetzt offen“ lassen sich kombinieren (alles muss zutreffen)
  const now = new Date();
  const pool = base.filter((p) => (!state.ui.reserved || p.reservation) && (!state.ui.starred || p.starred)
    && (!state.ui.openNow || openAt(p.hours, now) === true));
  const filtered = selected.size ? pool.filter((p) => selected.has(p.category)) : pool;
  const visible = state.ui.reserved ? sortByReservation(filtered) : sortPlaces(filtered);
  lastVisible = visible;

  if (activeId && !visible.some((p) => p.id === activeId)) activeId = null;
  // Gelöschte Routen (z. B. von jemand anderem in der Reise entfernt) aus der Auswahl nehmen.
  state.ui.visibleRoutes = state.ui.visibleRoutes.filter((id) => state.routes.some((r) => r.id === id));
  // In Einschalt-Reihenfolge zeichnen: die zuletzt eingeblendete Route liegt oben
  const visibleRoutes = state.ui.visibleRoutes
    .map((id) => state.routes.findIndex((r) => r.id === id))
    .filter((i) => i >= 0)
    .map((i) => ({ ...state.routes[i], color: routeColor(i).ink }));

  renderAirbnb();
  renderChips(base, pool);
  renderList(visible, all.length);
  renderRoutes();
  renderShareState();
  renderCash();
  $('#sheet-open-count').textContent = visible.length;

  mapView.setPlaces(visible, catOf, activeId);
  mapView.setAirbnb(state.airbnb);
  mapView.setRoutes(visibleRoutes);
  mapView.setPois(visibleRoutes.flatMap((r) => poisAlong(r) || []));
  if (fit) mapView.fitTo(visible, state.airbnb);

  saveUi(state.ui);
}

// Bezeichnung und Adresse einer Unterkunft. Ältere Einträge haben nur label: „Name · Adresse“ wird
// aufgeteilt; „Pin (…)“, „Gewählter Punkt (…)“ und reine Koordinaten gelten nicht als Adresse.
function airbnbParts(a) {
  if (!a) return { name: '', address: '' };
  if (a.name || a.address) return { name: a.name || '', address: a.address || '' };
  const label = String(a.label || '').trim();
  const i = label.lastIndexOf(' · ');
  const rest = i >= 0 ? label.slice(i + 3).trim() : label;
  const isAddress = /[a-zäöü]{3}/i.test(rest) && !/^(Pin|Gewählter Punkt)\b/.test(rest);
  return { name: i >= 0 ? label.slice(0, i).trim() : '', address: isAddress ? rest : '' };
}

function renderAirbnb() {
  const a = state.airbnb;
  // Anzeige: Bezeichnung + Adresse (ohne Adresse: die bisherige Bezeichnung, z. B. „Pin (…)“)
  const { name, address } = airbnbParts(a);
  $('#airbnb-name').textContent = name;
  $('#airbnb-name').hidden = !name;
  $('#airbnb-label').textContent = a ? address || (name ? '' : a.label) : 'Noch nicht festgelegt';
  $('#airbnb-label').classList.toggle('is-set', !!a);
  const route = $('#airbnb-route');
  route.hidden = !a;
  if (a) route.href = homeRouteUrl(a);
  // Link zum Inserat: nur noch anzeigen, falls früher einer eingetragen wurde (oder fest in config.js)
  const url = safeHttpUrl((fixedAirbnb || a)?.url);
  $('#airbnb-link').hidden = !url;
  if (url) $('#airbnb-link').href = url;
  // Feste Unterkunft (config.js): nicht bearbeitbar. Ohne Unterkunft gleich das Formular zeigen.
  $('#btn-airbnb-edit').hidden = !!fixedAirbnb || !a;
  $('#btn-airbnb-edit').textContent = a && !address ? 'Bezeichnung & Adresse ergänzen' : 'Bearbeiten';
  // Das automatisch geöffnete Formular wieder schliessen, sobald eine Unterkunft da ist (z. B. nach dem Laden)
  if (!a && !fixedAirbnb && $('#airbnb-form').hidden) openAirbnbForm({ auto: true });
  else if (a && airbnbFormAuto) closeAirbnbForm();
}

// --- Rennrad: Fahrzeit, Stopps unterwegs, Wetter -------------------------------------------

// Fahrzeit ohne Pausen: Strecke im gewählten Grundtempo plus Zuschlag fürs Klettern. Die Steigleistung
// wächst mit dem Tempo (25 km/h → 750 Hm/h). Grobe Faustregel; Abfahrten werden nicht abgezogen.
const BIKE_SPEEDS = [18, 20, 22, 25, 28, 30, 32];
const bikeSpeed = () => { const v = Number(readPref('bikeSpeed')); return BIKE_SPEEDS.includes(v) ? v : 25; };
function rideHours(r, speed = bikeSpeed()) {
  if (!Number.isFinite(r.distanceKm) || r.distanceKm <= 0) return null;
  const climb = Number.isFinite(r.elevationGainM) ? r.elevationGainM / (speed * 30) : 0;
  return r.distanceKm / speed + climb;
}
function formatDuration(hours) {
  const min = Math.max(5, Math.round((hours * 60) / 5) * 5);
  return min < 60 ? `ca. ${min} min` : `ca. ${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

// Kaffee-Stopps: eigene Orte der Arten Kaffee und Rennrad-Hotspot, höchstens 500 m von der Strecke entfernt,
// in Fahrtrichtung sortiert. Abstand flach genähert – auf Inselgröße auf wenige Meter genau.
const STOP_CATEGORIES = new Set(['kaffee', 'rennrad']);
const STOP_RADIUS_M = 500;
// Ergebnis je Strecke merken, solange sich die Kaffee-/Rennrad-Orte nicht ändern (wird sonst bei jedem
// Zeichnen der Liste für jede Strecke neu gerechnet)
const stopsCache = new WeakMap(); // route.points → { sig, stops }
function stopsAlong(route) {
  const pts = route.points;
  if (!pts?.length) return [];
  const sig = state.places
    .filter((p) => STOP_CATEGORIES.has(p.category) && hasCoords(p))
    .map((p) => `${p.id}|${p.lat}|${p.lng}|${p.name}`)
    .join('\n');
  const hit = stopsCache.get(pts);
  if (hit?.sig === sig) return hit.stops.map((s) => ({ ...s, place: state.places.find((p) => p.id === s.place.id) || s.place }));
  const candidates = state.places.filter((p) => STOP_CATEGORIES.has(p.category) && hasCoords(p));
  const stops = nearRoute(pts, candidates).map(({ item, along, distM }) => ({ place: item, along, distM }));
  stopsCache.set(pts, { sig, stops });
  return stops;
}

// Punkte (mit lat/lng) höchstens STOP_RADIUS_M neben der Strecke, in Fahrtrichtung sortiert:
// [{ item, along, distM }] – along = Punktindex + Anteil bis zum nächsten Punkt (für Kilometer und Fahrzeit)
function nearRoute(pts, items) {
  const kx = 111320 * Math.cos((pts[0][0] * Math.PI) / 180);
  const ky = 110540;
  const xy = pts.map(([lat, lng]) => [lng * kx, lat * ky]);
  // Umgebendes Rechteck per Schleife: Math.min(...xs) scheitert in Safari ab ca. 65 000 Punkten
  const box = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [x, y] of xy) {
    if (x < box[0]) box[0] = x;
    if (x > box[1]) box[1] = x;
    if (y < box[2]) box[2] = y;
    if (y > box[3]) box[3] = y;
  }
  box[0] -= STOP_RADIUS_M; box[1] += STOP_RADIUS_M; box[2] -= STOP_RADIUS_M; box[3] += STOP_RADIUS_M;
  const near = [];
  for (const p of items) {
    const x = p.lng * kx;
    const y = p.lat * ky;
    if (x < box[0] || x > box[1] || y < box[2] || y > box[3]) continue;
    let best = Infinity;
    let along = 0;
    for (let i = 0; i < xy.length; i++) {
      const [ax, ay] = xy[i];
      const [bx, by] = xy[i + 1] || xy[i];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d < best) { best = d; along = i + t; }
    }
    if (best <= STOP_RADIUS_M) near.push({ item: p, along, distM: best });
  }
  return near.sort((a, b) => a.along - b.along);
}

// Kilometer und Höhenmeter bergauf bis zu jedem Kartenpunkt. Die Kartenpunkte sind ausgedünnt – Distanz und
// Höhenmeter der Etappe (aus der vollen GPX-Datei) werden deshalb anteilig darauf verteilt.
const profileCache = new WeakMap(); // route.points → { km, up, hasEle }
function routeProfile(pts) {
  let prof = profileCache.get(pts);
  if (prof) return prof;
  const km = [0];
  const up = [0];
  let hasEle = false;
  for (let i = 1; i < pts.length; i++) {
    km.push(km[i - 1] + haversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    const a = pts[i - 1][2];
    const b = pts[i][2];
    if (Number.isFinite(a) && Number.isFinite(b)) hasEle = true;
    up.push(up[i - 1] + (Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : 0));
  }
  prof = { km, up, hasEle };
  profileCache.set(pts, prof);
  return prof;
}

// Bis zur Stelle „along“ (siehe nearRoute): gefahrene Kilometer und Fahrzeit in Stunden (wie rideHours)
function progressAt(r, along, speed = bikeSpeed()) {
  const { km, up, hasEle } = routeProfile(r.points);
  const last = km.length - 1;
  const i = Math.max(0, Math.min(Math.floor(along), last));
  const j = Math.min(i + 1, last);
  const t = Math.max(0, Math.min(1, along - i));
  const mapKm = km[last] || 1;
  const totalKm = Number.isFinite(r.distanceKm) && r.distanceKm > 0 ? r.distanceKm : mapKm;
  const k = ((km[i] + t * (km[j] - km[i])) / mapKm) * totalKm;
  const gain = Number.isFinite(r.elevationGainM) ? r.elevationGainM : 0;
  const climb = hasEle && up[last] > 0
    ? ((up[i] + t * (up[j] - up[i])) / up[last]) * (gain || up[last])
    : gain * (k / totalKm);
  return { km: k, hours: k / speed + climb / (speed * 30) };
}

// Startzeit für die Ankunftszeiten (jedes Gerät merkt sich seine); Fahrtag wie beim Wetter (ab 15 Uhr: morgen)
const rideStart = () => { const v = readPref('rideStart'); return /^\d{2}:\d{2}$/.test(v || '') ? v : '09:00'; };
const hhmm = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
function arrivalAt(hours) {
  const start = new Date(`${weatherDay().day}T${rideStart()}:00`);
  return new Date(start.getTime() + hours * 3600000);
}

// Kaffee-Stopps mit Kilometer, Ankunftszeit und ob dann geöffnet ist (true/false/null = unbekannt).
// Der Stopp am nächsten zur Streckenmitte (zwischen 30 und 70 %) ist als Halbzeit-Pause markiert.
function stopPlan(r) {
  const stops = stopsAlong(r);
  if (!stops.length) return [];
  const total = progressAt(r, r.points.length - 1).km || 1;
  const plan = stops.map((st) => {
    const pr = progressAt(r, st.along);
    const at = arrivalAt(pr.hours);
    return { ...st, km: pr.km, at, open: openAt(st.place.hours, at), halfway: false };
  });
  let best = Infinity;
  let half = null;
  for (const s of plan) {
    const f = s.km / total;
    if (f >= 0.3 && f <= 0.7 && Math.abs(f - 0.5) < best) { best = Math.abs(f - 0.5); half = s; }
  }
  if (half) half.halfway = true;
  return plan;
}

const stopMeta = (s) => `km ${Math.round(s.km)} · ${hhmm(s.at)}${s.open === true ? ' · offen' : s.open === false ? ' · geschlossen' : ''}`;

// --- Trinkwasser und Velo-Werkstätten entlang der Etappen (OpenStreetMap, siehe pois.js) -------------------
// Einmal geladen (beim Import der GPX-Datei bzw. beim ersten Öffnen älterer Etappen) und dann bei der Etappe
// in der Datenbank gespeichert – alle Mitreisenden sehen dieselben Punkte, auch ohne Netz.
// Die öffentlichen Overpass-Server sind zeitweise überlastet: nach einem Fehlschlag nach 2 Minuten erneut versuchen.
const POI_RETRY_MS = 2 * 60 * 1000;
const poiLoading = new Map(); // route.id → { status: 'loading' | 'failed', at }
const poiSaved = new Set(); // route.id: Speichern schon versucht (nicht bei jedem Zeichnen erneut)
function poisFor(r) {
  if (Array.isArray(r.pois)) return r.pois;
  const cached = cachedPois(r); // älterer Stand nur auf diesem Gerät → für alle speichern
  if (cached) {
    saveRoutePois(r.id, cached);
    return cached;
  }
  const prev = poiLoading.get(r.id);
  const retry = prev?.status === 'failed' && Date.now() - prev.at > POI_RETRY_MS;
  if ((!prev || retry) && navigator.onLine && r.points?.length) {
    poiLoading.set(r.id, { status: 'loading', at: Date.now() });
    loadPois(r)
      .then((items) => {
        poiLoading.delete(r.id);
        saveRoutePois(r.id, items);
      })
      .catch((err) => {
        console.warn('Trinkwasser/Velo nicht ladbar:', err.message);
        poiLoading.set(r.id, { status: 'failed', at: Date.now() });
        setTimeout(() => render(), POI_RETRY_MS + 1000);
      })
      .finally(() => render());
  }
  return null;
}

// Punkte bei der Etappe ablegen und in der Datenbank speichern (still im Hintergrund: klappt es nicht, z. B.
// ohne Netz oder bevor die Spalte „pois“ existiert, bleiben sie auf diesem Gerät gemerkt)
function saveRoutePois(id, items) {
  const route = state.routes.find((x) => x.id === id);
  const pois = sanitizePois(items);
  if (!route || !pois || poiSaved.has(id)) return;
  poiSaved.add(id);
  route.pois = pois;
  if (backend.kind === 'shared' && (state.poisMissing || backend.offline)) return;
  backend.updateRoute(id, { pois }).catch((err) => console.warn('Trinkwasser/Velo nicht gespeichert:', err.message));
}

// Punkte höchstens STOP_RADIUS_M neben der Strecke, mit Kilometer: [{ id, type, name, lat, lng, km, routeName }]
const poiAlongCache = new WeakMap(); // Liste aus pois.js → { pts, name, list }
function poisAlong(r) {
  const items = poisFor(r);
  if (!items) return null;
  const hit = poiAlongCache.get(items);
  if (hit && hit.pts === r.points && hit.name === r.name) return hit.list;
  const list = nearRoute(r.points, items).map(({ item, along }) => ({ ...item, km: progressAt(r, along).km, routeName: r.name }));
  poiAlongCache.set(items, { pts: r.points, name: r.name, list });
  return list;
}

// Zeile „Wasser & Velo“ in den Etappen-Details
function poiDetailHtml(r) {
  const list = poisAlong(r);
  if (!list) {
    const status = poiLoading.get(r.id)?.status;
    if (status === 'failed') return '<span class="muted">nicht verfügbar</span> <button type="button" class="btn-link" data-action="retry-pois">erneut versuchen</button>';
    return navigator.onLine ? '<span class="muted">wird geladen …</span>' : '<span class="muted">ohne Netz nicht verfügbar</span>';
  }
  const water = list.filter((x) => x.type === 'water');
  const bike = list.filter((x) => x.type !== 'water');
  // Trinkwasser: je Kilometer nur einen Eintrag (in Orten stehen oft mehrere Brunnen beieinander)
  const seen = new Set();
  const waterKm = water.filter((x) => { const k = Math.round(x.km); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);
  const btn = (x, label) => `<button type="button" class="route-stop route-poi poi-${x.type}" data-action="show-poi" data-lat="${x.lat}" data-lng="${x.lng}" title="${escapeHtml(POI_TYPES[x.type].label)}${x.name ? `: ${escapeHtml(x.name)}` : ''}">${icon(POI_TYPES[x.type].icon, { size: 12, stroke: 2.4 })}${label}</button>`;
  const parts = [];
  if (waterKm.length) parts.push(waterKm.map((x) => btn(x, `km ${Math.round(x.km)}`)).join(''));
  if (bike.length) parts.push(bike.slice(0, 6).map((x) => btn(x, `${escapeHtml(x.name || POI_TYPES[x.type].label)} · km ${Math.round(x.km)}`)).join(''));
  return parts.length ? parts.join('') : '<span class="muted">keine Brunnen oder Velo-Werkstätten in der Nähe gefunden</span>';
}

// Wetter am Startpunkt jeder Route – „als wäre jeder Tag ein Fahrtag“: heute für die Fahrstunden 9–16 Uhr,
// ab 15 Uhr schon für morgen. Daten von Open-Meteo (kostenlos, ohne Schlüssel; übermittelt werden nur die
// Startkoordinaten), höchstens einmal pro Stunde abgefragt und im Browser gemerkt.
const WEATHER_PREF = 'weather';
let weather = (() => { const w = readPref(WEATHER_PREF); return w && w.byCoord ? w : null; })();
let weatherLoading = false;
let weatherFailedAt = 0;
const startKey = (route) => (route.points?.length ? `${route.points[0][0].toFixed(2)},${route.points[0][1].toFixed(2)}` : '');
const compass = (deg) => ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

function weatherDay() {
  const now = new Date();
  const tomorrow = now.getHours() >= 15;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (tomorrow ? 1 : 0));
  return { day: d.toLocaleDateString('sv-SE'), label: tomorrow ? 'Morgen' : 'Heute' };
}

// Stundenwerte eines Tages → Kurzfassung für die Fahrstunden (9–16 Uhr)
function summarizeRideHours(hourly, day) {
  const idx = (hourly?.time || []).flatMap((t, i) => (t.startsWith(day) && Number(t.slice(11, 13)) >= 9 && Number(t.slice(11, 13)) <= 16 ? [i] : []));
  if (!idx.length) return null;
  const vals = (k) => idx.map((i) => hourly[k]?.[i]).filter((v) => Number.isFinite(v));
  const temp = vals('temperature_2m');
  const rain = vals('precipitation_probability');
  const wind = vals('wind_speed_10m');
  const gust = vals('wind_gusts_10m');
  const dir = vals('wind_direction_10m');
  if (!temp.length || !wind.length) return null;
  // Mittlere Windrichtung als Vektormittel (sonst ergäbe 350° und 10° fälschlich Süd)
  const rad = (d) => (d * Math.PI) / 180;
  const sx = dir.reduce((s, d) => s + Math.sin(rad(d)), 0);
  const sy = dir.reduce((s, d) => s + Math.cos(rad(d)), 0);
  return {
    tMin: Math.round(Math.min(...temp)), tMax: Math.round(Math.max(...temp)),
    rain: rain.length ? Math.round(Math.max(...rain)) : null,
    wind: Math.round(Math.max(...wind)), gust: gust.length ? Math.round(Math.max(...gust)) : null,
    dir: dir.length ? (((Math.atan2(sx, sy) * 180) / Math.PI) + 360) % 360 : null,
  };
}

async function ensureWeather() {
  if (weatherLoading || Date.now() - weatherFailedAt < 5 * 60 * 1000) return;
  const starts = [...new Set(state.routes.map(startKey).filter(Boolean))];
  if (!starts.length) return;
  const { day, label } = weatherDay();
  if (weather && weather.day === day && Date.now() - weather.fetched < 60 * 60 * 1000 && starts.every((k) => k in weather.byCoord)) return;
  weatherLoading = true;
  try {
    const params = new URLSearchParams({
      latitude: starts.map((k) => k.split(',')[0]).join(','),
      longitude: starts.map((k) => k.split(',')[1]).join(','),
      hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
      timezone: 'Europe/Madrid',
      forecast_days: '2',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : [data];
    const byCoord = {};
    starts.forEach((k, i) => { byCoord[k] = summarizeRideHours(list[i]?.hourly, day); });
    weather = { fetched: Date.now(), day, label, byCoord };
    writePref(WEATHER_PREF, weather);
    renderRoutes();
  } catch (err) {
    weatherFailedAt = Date.now();
    console.warn('Wetter nicht abrufbar:', err.message);
  } finally {
    weatherLoading = false;
  }
}

// Wetter-Kurzfassung für die zugeklappte Zeile: höchste Temperatur und Wind; orange, wenn es ungemütlich wird
function routeWeather(route) {
  const w = weather?.byCoord?.[startKey(route)];
  if (!w || weather.day !== weatherDay().day) return null;
  return { ...w, rough: w.wind >= 30 || (w.gust ?? 0) >= 45 || (w.rain ?? 0) >= 50 };
}
function weatherPill(route) {
  const w = routeWeather(route);
  if (!w) return '';
  return `<span class="route-wx${w.rough ? ' is-rough' : ''}" title="${weather.label} 9–16 Uhr am Start">${icon('wind', { size: 12, stroke: 2.2 })}${w.tMax}° · ${w.wind} km/h</span>`;
}
function weatherDetail(route) {
  const w = routeWeather(route);
  if (!w) return weatherLoading ? 'wird geladen …' : 'gerade nicht verfügbar';
  return [
    `${w.tMin === w.tMax ? w.tMax : `${w.tMin}–${w.tMax}`}°`,
    w.rain != null ? `Regen ${w.rain} %` : '',
    `Wind ${w.wind} km/h${w.dir != null ? ` aus ${compass(w.dir)}` : ''}${w.gust != null ? `, Böen ${w.gust}` : ''}`,
  ].filter(Boolean).join(' · ');
}

// Popup einer Etappe auf der Karte: Kennzahlen, Wetter, Kaffee-Stopps, Links und „Details in der Liste“.
// Wird beim Antippen frisch erzeugt (siehe map.js); Klicks darin verarbeitet der Listener weiter unten.
function routePopupHtml(r, color) {
  const hm = formatHm(r.elevationGainM);
  const hours = rideHours(r);
  const stats = [
    r.distanceKm != null ? formatKm(r.distanceKm) : '',
    hm ? `${icon('trending-up', { size: 12, stroke: 2.2 })}${hm}` : '',
    hours != null ? `${icon('clock', { size: 12, stroke: 2.2 })}${formatDuration(hours)}` : '',
  ].filter(Boolean).map((t) => `<span class="route-meta-part">${t}</span>`).join('<span class="route-meta-sep">·</span>');
  const w = routeWeather(r);
  const stops = stopPlan(r);
  const pois = poisAlong(r);
  const waterN = pois ? new Set(pois.filter((x) => x.type === 'water').map((x) => Math.round(x.km))).size : 0;
  const bikeN = pois ? pois.filter((x) => x.type !== 'water').length : 0;
  const poiText = [waterN ? `${waterN}× Trinkwasser` : '', bikeN ? `${bikeN}× Velo-Werkstatt` : ''].filter(Boolean).join(' · ');
  const url = safeHttpUrl(r.url);
  const activity = safeHttpUrl(r.activityUrl);
  const links = [
    url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Tour ↗</a>` : '',
    r.ridden ? (activity ? `<a href="${escapeHtml(activity)}" target="_blank" rel="noopener">${icon('check', { size: 12, stroke: 2.6 })}Gefahren ↗</a>` : `<span>${icon('check', { size: 12, stroke: 2.6 })}Gefahren</span>`) : '',
  ].filter(Boolean).join('<span class="route-meta-sep">·</span>');
  return `<div class="popup route-popup">
    <span class="popup-cat" style="${categoryStyle({ ...ROUTE_CATEGORY, ink: color })}">${escapeHtml(ROUTE_CATEGORY.label)}</span>
    <strong class="popup-name">${escapeHtml(r.name)}</strong>
    ${stats ? `<span class="route-popup-stats">${stats}</span>` : ''}
    ${w ? `<span class="route-popup-row${w.rough ? ' is-rough' : ''}">${icon('wind', { size: 13, stroke: 2 })}<span><strong>${escapeHtml(weather.label)}:</strong> ${weatherDetail(r)}</span></span>` : ''}
    ${stops.length ? `<span class="route-popup-row">${icon('coffee', { size: 13, stroke: 2 })}<span class="route-popup-stops">${stops.map((st) => `<button type="button" class="route-stop${st.halfway ? ' is-halfway' : ''}${st.open === false ? ' is-closed' : ''}" data-popup-stop="${escapeHtml(st.place.id)}" title="${escapeHtml(stopMeta(st))}">${escapeHtml(st.place.name)} <small>${hhmm(st.at)}</small></button>`).join('')}</span></span>` : ''}
    ${poiText ? `<span class="route-popup-row">${icon('droplet', { size: 13, stroke: 2 })}<span>${poiText} entlang der Strecke</span></span>` : ''}
    ${links ? `<span class="route-popup-links">${links}</span>` : ''}
    <button type="button" class="popup-link route-popup-more" data-popup-route="${escapeHtml(r.id)}">Details in der Liste ${icon('arrow-right', { size: 12, stroke: 2.4 })}</button>
  </div>`;
}

// „Rechnung erfassen“ im Detailfenster eines Orts auf der Karte
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-popup-cash]');
  if (!btn) return;
  e.preventDefault();
  const place = state.places.find((p) => p.id === btn.dataset.popupCash);
  if (place) openCashFor(place);
});

// Klicks im Etappen-Popup. Capture-Phase, weil Leaflet Klicks in Popups nicht weiterreicht.
document.addEventListener('click', (e) => {
  const stop = e.target.closest('[data-popup-stop]');
  const more = e.target.closest('[data-popup-route]');
  if (!stop && !more) return;
  e.preventDefault();
  if (stop) {
    const id = stop.dataset.popupStop;
    if (!state.places.some((p) => p.id === id)) return;
    if (!lastVisible.some((p) => p.id === id)) resetFilters();
    selectPlace(id, { fly: true, scrollList: true });
    return;
  }
  const id = more.dataset.popupRoute;
  if (!state.routes.some((r) => r.id === id)) return;
  mapView.map.closePopup?.();
  expandedRouteId = id;
  editingRouteLink = null;
  renderRoutes();
  if (isMobile() && sheetState() === 'hidden') setSheet('half');
  $(`#route-list li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}, true);

// Espresso-Etappen: eigener Abschnitt unter den Orten. Zugeklappt nur Name, Kennzahlen und Wetter-Etikett;
// ein Tipp klappt die Details auf (Wetter, Stopps, Links, Aktionen) – wie bei den Orten, immer nur eine.
// Ein- und ausblenden auf der Karte macht der Schalter rechts (state.ui.visibleRoutes, standardmäßig leer).
let expandedRouteId = null;

function renderRoutes() {
  const list = $('#route-list');
  if (!list) return; // Null-sicher: altes index.html im Cache
  const empty = $('#route-empty');
  const count = $('#route-count');
  const visible = new Set(state.ui.visibleRoutes);
  if (count) {
    count.textContent = state.routes.length
      ? `${visible.size} von ${state.routes.length} ${state.routes.length === 1 ? 'Etappe' : 'Etappen'} eingeblendet`
      : '';
  }
  if (empty) empty.hidden = state.routes.length > 0;
  const speedBox = $('#route-speed');
  if (speedBox) {
    speedBox.hidden = !state.routes.length;
    $('#bike-speed').value = String(bikeSpeed());
    const startInput = $('#ride-start');
    if (startInput && document.activeElement !== startInput) startInput.value = rideStart();
  }
  if (expandedRouteId && !state.routes.some((r) => r.id === expandedRouteId)) expandedRouteId = null;
  // Offenes Link-Feld übersteht das Neuzeichnen (z. B. Abgleich alle 20 s) samt Eingabe und Fokus
  const draftInput = $('.route-link-form input', list);
  const draft = draftInput ? { value: draftInput.value, focused: document.activeElement === draftInput } : null;
  if (editingRouteLink && editingRouteLink !== expandedRouteId) editingRouteLink = null;
  const linkForm = (r, field) => {
    const activity = field === 'activityUrl';
    // novalidate: Links ohne „https://“ (z. B. „strava.com/…“) ergänzt normalizeLink – der Browser würde sie sonst still ablehnen
    return `<form class="route-link-form" data-action="save-route-link" data-field="${field}" autocomplete="off" novalidate>
          <input type="url" inputmode="url" placeholder="${activity ? 'Link zur gefahrenen Aktivität (Strava …)' : 'Link zur Tour (Strava, Komoot …)'}" aria-label="${activity ? 'Link zur Aktivität' : 'Link zur Tour'}" value="${escapeHtml(r[field] || '')}">
          <button class="btn btn-small" type="submit">Speichern</button>
          <button class="btn-link muted" type="button" data-action="cancel-route-link">Abbrechen</button>
        </form>`;
  };
  const linkHtml = (url, label, action) => `<a class="route-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label} ↗</a>
    <button class="btn-link muted" type="button" data-action="${action}">Ändern</button>`;

  list.innerHTML = state.routes.map((r, i) => {
    const on = visible.has(r.id);
    const open = expandedRouteId === r.id;
    const colors = { ...ROUTE_CATEGORY, ...routeColor(i) }; // gleiche Farbe wie die Linie auf der Karte
    const hm = formatHm(r.elevationGainM);
    const hours = rideHours(r);
    // Kennzahlen in einer Zeile; Symbol/Wert jeweils als Einheit, damit beim Umbrechen nichts auseinanderfällt
    const stats = [
      r.distanceKm != null ? `<span class="route-meta-part">${formatKm(r.distanceKm)}</span>` : '',
      hm ? `<span class="route-meta-part">${icon('trending-up', { size: 13, stroke: 2.2 })}${hm}</span>` : '',
      hours != null ? `<span class="route-meta-part">${icon('clock', { size: 13, stroke: 2.2 })}${formatDuration(hours)}</span>` : '',
    ].filter(Boolean).join('<span class="route-meta-sep">·</span>') || escapeHtml(ROUTE_CATEGORY.label);

    let details = '';
    if (open) {
      const editing = editingRouteLink === r.id ? editingRouteField : null;
      const stops = stopPlan(r);
      const url = safeHttpUrl(r.url);
      const activity = safeHttpUrl(r.activityUrl);
      const tour = url ? linkHtml(url, escapeHtml(linkLabel(url)), 'edit-route-link')
        : `<button class="btn-link muted route-link-add" type="button" data-action="edit-route-link">${icon('link', { size: 13, stroke: 2 })}Tour-Link</button>`;
      const ridden = !r.ridden ? ''
        : activity ? linkHtml(activity, `${icon('check', { size: 13, stroke: 2.6 })}Gefahren · ${escapeHtml(linkLabel(activity))}`, 'edit-activity-link')
        : `<button class="btn-link muted route-link-add" type="button" data-action="edit-activity-link">${icon('check', { size: 13, stroke: 2.6 })}Aktivität verlinken</button>`;
      details = `<div class="route-details">
        <div class="route-detail"><span class="route-detail-label">Wetter</span>
          <span><span class="${routeWeather(r)?.rough ? 'route-detail-warn' : ''}">${weatherDetail(r)}</span>
          <span class="muted">(${escapeHtml((weather?.label || weatherDay().label).toLowerCase())} 9–16 Uhr am Start)</span></span></div>
        <div class="route-detail"><span class="route-detail-label">Kaffee</span>
          <span class="route-stop-list">${stops.length
            ? stops.map((st) => `<button type="button" class="route-stop route-stop-plan${st.halfway ? ' is-halfway' : ''}${st.open === false ? ' is-closed' : ''}" data-action="show-stop" data-place="${escapeHtml(st.place.id)}" title="${Math.round(st.distM)} m neben der Strecke">
                <span class="route-stop-name">${st.halfway ? '<span class="route-stop-half">Halbzeit</span>' : ''}${escapeHtml(st.place.name)}</span>
                <span class="route-stop-meta">${stopMeta(st)}</span></button>`).join('')
              + `<span class="route-stop-note muted">Ankunft bei Start um ${rideStart()} (${escapeHtml(weatherDay().label.toLowerCase())}), ohne Pausen</span>`
            : '<span class="muted">keine Kaffees oder Hotspots in der Nähe</span>'}</span></div>
        <div class="route-detail"><span class="route-detail-label">Wasser & Velo</span>
          <span class="route-stop-list">${poiDetailHtml(r)}</span></div>
        <div class="route-detail"><span class="route-detail-label">Links</span>
          ${editing ? linkForm(r, editing) : `<span class="route-links">${tour}${ridden ? `<span class="route-meta-sep">·</span>${ridden}` : ''}</span>`}</div>
        <div class="route-detail-actions">
          <button type="button" class="btn btn-small" data-action="show-route">${icon('route', { size: 14, stroke: 2 })}Auf der Karte zeigen</button>
          <button type="button" class="route-action" data-action="download-route" aria-label="Etappe „${escapeHtml(r.name)}“ als GPX herunterladen" title="Als GPX herunterladen">${icon('download', { size: 15, stroke: 1.9 })}</button>
          <button type="button" class="route-action is-danger" data-action="delete-route" aria-label="Etappe „${escapeHtml(r.name)}“ entfernen" title="Entfernen">${icon('trash', { size: 15, stroke: 1.9 })}</button>
        </div>
      </div>`;
    }
    return `<li class="place route-item${on ? ' is-on' : ''}${r.ridden ? ' is-ridden' : ''}${open ? ' is-open' : ''}" data-id="${r.id}" style="${categoryStyle(colors)}">
      <div class="route-row">
        <button type="button" class="visit-toggle" data-action="ridden" aria-pressed="${!!r.ridden}" aria-label="${escapeHtml(r.name)} gefahren" title="${r.ridden ? 'Gefahren – antippen zum Entfernen' : 'Als gefahren markieren'}">${icon('check', { size: 16, stroke: 3 })}</button>
        <button type="button" class="place-main" data-action="expand-route" aria-expanded="${open}">
          <span class="place-icon" aria-hidden="true">${categoryIcon(ROUTE_CATEGORY, { size: 18, stroke: 1.7 })}</span>
          <span class="place-body">
            <span class="place-name">${escapeHtml(r.name)}</span>
            <span class="place-meta route-stats">${stats}${weatherPill(r)}</span>
          </span>
        </button>
        <button type="button" class="route-switch-btn" data-action="toggle-route" role="switch" aria-checked="${on}" aria-label="„${escapeHtml(r.name)}“ auf der Karte ${on ? 'ausblenden' : 'einblenden'}" title="${on ? 'Auf der Karte ausblenden' : 'Auf der Karte einblenden'}"><span class="route-switch" aria-hidden="true"></span></button>
      </div>
      ${details}
    </li>`;
  }).join('');
  const input = $('.route-link-form input', list);
  if (input && draft) {
    input.value = draft.value;
    if (draft.focused) input.focus();
  }
  ensureWeather();
}

// Link zur Tour (Strava, Komoot, …) bzw. zur gefahrenen Aktivität: Id der Route, deren Link-Feld gerade
// offen ist, und welches Feld ('url' oder 'activityUrl')
let editingRouteLink = null;
let editingRouteField = 'url';

// Nur http(s)-Links in href übernehmen – nie javascript: o. Ä. aus der Datenbank
const safeHttpUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

// „https://www.komoot.com/de-de/tour/123“ → „komoot.com“
function linkLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// Eingabe prüfen: ohne Schema wird https:// ergänzt; alles außer http(s) wird abgelehnt
function normalizeLink(value) {
  const v = value.trim();
  if (!v) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
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
  if (reduced) toast('GPX aus den Kartenpunkten erstellt (ohne Höhen) – für volle Genauigkeit Etappe neu importieren.');
}

// Höhenmeter bergauf, z. B. „1.230 Hm“; leer bei Routen ohne Höhendaten (ältere Importe, GPX ohne <ele>)
function formatHm(m) {
  return Number.isFinite(m) ? `${Math.round(m).toLocaleString('de-DE')} Hm` : '';
}

function renderChips(base, pool) {
  const counts = new Map();
  for (const p of pool) counts.set(p.category, (counts.get(p.category) || 0) + 1);
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

  // „Reserviert“ erscheint, sobald mindestens ein Ort reserviert ist
  const reservedCount = base.filter((p) => p.reservation).length;
  // „Favoriten“ ebenso, sobald mindestens ein Ort einen Stern hat
  const starredCount = base.filter((p) => p.starred).length;
  const starredChip = starredCount || state.ui.starred
    ? `<button type="button" class="chip chip-starred" data-filter="starred" aria-pressed="${!!state.ui.starred}">
        <span class="chip-icon">${icon('star', { size: 15, stroke: 2 })}</span>Favoriten<span class="chip-count">${starredCount}</span>
      </button>`
    : '';
  // „Jetzt offen“, sobald von mindestens einem Ort die Öffnungszeiten bekannt sind
  const now = new Date();
  const openCount = base.filter((p) => openAt(p.hours, now) === true).length;
  const openChip = state.ui.openNow || base.some((p) => p.hours?.p)
    ? `<button type="button" class="chip chip-open" data-filter="open" aria-pressed="${!!state.ui.openNow}">
        <span class="chip-icon">${icon('clock', { size: 15, stroke: 2 })}</span>Jetzt offen<span class="chip-count">${openCount}</span>
      </button>`
    : '';
  const reservedChip = reservedCount || state.ui.reserved
    ? `<button type="button" class="chip chip-reserved" data-filter="reserved" aria-pressed="${!!state.ui.reserved}">
        <span class="chip-icon">${icon('calendar-check', { size: 15, stroke: 2 })}</span>Reserviert<span class="chip-count">${reservedCount}</span>
      </button>`
    : '';

  const html = `<button type="button" class="chip chip-all" data-cat="" aria-pressed="${!selected.size}">Alle<span class="chip-count">${pool.length}</span></button>` +
    openChip + starredChip + reservedChip + chips.join('');
  // Nur bei Änderung neu setzen – so bleibt auf dem Handy auch die seitliche Scrollposition der Reihe stehen
  const box = $('#category-chips');
  if (box.dataset.html !== html) {
    box.innerHTML = html;
    box.dataset.html = html;
  }
}

// Startansicht: nur die ersten PLACES_PREVIEW Orte, der Rest ist über „Alle … anzeigen“ aufklappbar.
// Die Karte zeigt trotzdem alle Orte; zugeklappt wird nur die Liste.
const PLACES_PREVIEW = 3;
let placesExpanded = false;

function renderPlaceMore(count) {
  const btn = $('#place-more');
  const list = $('#place-list');
  const extra = count - PLACES_PREVIEW;
  list.classList.toggle('is-collapsed', !placesExpanded && extra > 0);
  btn.hidden = extra <= 0;
  if (extra <= 0) return;
  btn.setAttribute('aria-expanded', String(placesExpanded));
  btn.innerHTML = placesExpanded
    ? `Weniger anzeigen ${icon('chevron-up', { size: 15, stroke: 2.2 })}`
    : `Alle ${count} Orte anzeigen ${icon('chevron-down', { size: 15, stroke: 2.2 })}`;
}

$('#place-more').addEventListener('click', () => {
  placesExpanded = !placesExpanded;
  renderPlaceMore($$('#place-list .place').length);
  // Handy: aufgeklappte Liste braucht Platz → Blatt ganz hochziehen
  if (placesExpanded && isMobile()) setSheet('full');
  // Beim Zuklappen zurück an den Listenanfang, sonst steht man mitten im leeren Bereich
  if (!placesExpanded) $('.list-section .list-head')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

function renderList(visible, total) {
  const list = $('#place-list');
  const empty = $('#empty-state');
  renderPlaceMore(visible.length);
  $('#result-count').innerHTML = total
    ? `<strong>${visible.length} ${visible.length === 1 ? 'Ort' : 'Orte'}</strong> von ${total}${state.ui.reserved ? ' · nach Termin' : ''}`
    : '';
  // Beim Filter „Reserviert“ gilt die Termin-Reihenfolge – die Sortier-Auswahl würde nur verwirren
  $('.sort').hidden = !!state.ui.reserved;

  if (!visible.length) {
    list.replaceChildren();
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
  patchList(list, listItems, visible.map((p, i) => [p.id, placeItemHtml(p, i, cats)]));
  // Aufbewahrte Einträge gelöschter Orte vergessen
  if (listItems.size > visible.length) {
    const ids = new Set(state.places.map((p) => p.id));
    for (const id of listItems.keys()) if (!ids.has(id)) listItems.delete(id);
  }
}

// Ein Eintrag der Ortsliste als HTML (Vergleich mit dem bisherigen Stand in patchList)
function placeItemHtml(p, i, cats) {
  const c = catOf(p.category);
  const dist = p.distance != null
    ? `<span class="place-dist">${distanceHtml(p.distance)}</span>`
    : !hasCoords(p) ? '<span class="place-dist is-missing" title="Kein Standort">ohne Standort</span>' : '';
  const gf = !!p.glutenFree;
  const visited = !!p.visited;
  const res = p.reservation;
  // Reservieren nur bei Restaurants – eine bestehende Reservierung bleibt sichtbar, auch wenn die Kategorie wechselt
  const canReserve = p.category === RESERVABLE_CATEGORY || !!res;
  const hours = hoursStatus(p.hours);
  return `<li class="place${visited ? ' is-visited' : ''}${p.id === activeId ? ' is-active' : ''}${i >= PLACES_PREVIEW ? ' is-extra' : ''}" data-id="${p.id}" style="${categoryStyle(c)}">
    <div class="place-row">
    <button type="button" class="visit-toggle" data-action="visited" aria-pressed="${visited}" aria-label="${escapeHtml(p.name)} besucht" title="${visited ? 'Besucht – antippen zum Entfernen' : 'Als besucht markieren'}">${icon('check', { size: 16, stroke: 3 })}</button>
    <button type="button" class="place-main" data-action="select" aria-expanded="${p.id === activeId}">
      <span class="place-icon" aria-hidden="true">${categoryIcon(c, { size: 18, stroke: 1.7 })}</span>
      <span class="place-body">
        <span class="place-name">${escapeHtml(p.name)}</span>
        <span class="place-meta">${escapeHtml(c.label)}${p.address ? ` · ${escapeHtml(p.address)}` : ''}</span>
        ${res ? `<span class="place-res">${icon('calendar-check', { size: 13, stroke: 2.2 })}${escapeHtml(formatReservation(res))}</span>` : ''}
        ${hours ? `<span class="place-hours ${hours.open ? 'is-open' : 'is-closed'}">${escapeHtml(hours.text)}</span>` : ''}
      </span>
      ${dist}
    </button>
    <button type="button" class="star-toggle" data-action="starred" aria-pressed="${!!p.starred}" aria-label="${escapeHtml(p.name)} als Favorit" title="${p.starred ? 'Favorit – antippen zum Entfernen' : 'Als Favorit markieren'}">${icon('star', { size: 18, stroke: 2 })}</button>
    <button type="button" class="gf-toggle" data-action="gluten-free" aria-pressed="${gf}" aria-label="Glutenfrei" title="${gf ? 'Glutenfrei – antippen zum Entfernen' : 'Als glutenfrei markieren'}">${icon('wheat-off', { size: 17, stroke: 1.9 })}<span class="gf-label">GF</span></button>
    </div>
    <div class="place-details">
      ${p.note ? `<p class="place-note">${escapeHtml(p.note)}</p>` : ''}
      ${p.addedBy ? `<p class="place-by">Hinzugefügt von ${escapeHtml(p.addedBy)}</p>` : ''}
      ${canReserve ? reservationHtml(res) : ''}
      <div class="place-actions">
        <label class="cat-select-wrap">
          <span class="visually-hidden">Kategorie</span>
          <select class="cat-select" data-action="category">
            ${cats.map((k) => `<option value="${k.id}"${k.id === p.category ? ' selected' : ''}>${optionLabel(k)}</option>`).join('')}
          </select>
        </label>
        ${!hasCoords(p) ? '<button type="button" class="chip-btn" data-action="geocode">Standort suchen</button>' : ''}
        <a class="chip-btn route-btn" href="${escapeHtml(routeUrl(p))}" target="_blank" rel="noopener" title="Route von deinem Standort in Google Maps">${icon('navigation', { size: 14, stroke: 2.2 })}Route</a>
        <button type="button" class="chip-btn" data-action="cash" title="Rechnung für diesen Ort in den Ausgaben erfassen">${icon('receipt', { size: 14, stroke: 2 })}Rechnung</button>
        <button type="button" class="chip-btn chip-btn-icon danger" data-action="delete" aria-label="Entfernen" title="Entfernen">${icon('trash', { size: 15, stroke: 1.9 })}</button>
      </div>
    </div>
  </li>`;
}

// Liste nur dort ändern, wo sich ein Eintrag geändert hat: unveränderte Einträge bleiben stehen und
// werden höchstens umsortiert; ausgeblendete (z. B. weggefiltert) werden für später aufbewahrt. Die ganze
// Liste bei jedem Tipp neu aufzubauen ist bei vielen Orten auf dem Handy spürbar träge.
// rows: [[id, html], …] in Anzeigereihenfolge; cache: id → { html, el }.
function patchList(list, cache, rows) {
  const els = rows.map(([id, html]) => {
    let entry = cache.get(id);
    if (!entry || entry.html !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      entry = { html, el: tpl.content.firstElementChild };
      cache.set(id, entry);
    }
    return entry.el;
  });
  const wanted = new Set(els);
  let ref = list.firstElementChild;
  const dropRef = () => { const after = ref.nextElementSibling; ref.remove(); ref = after; };
  for (const el of els) {
    while (ref && !wanted.has(ref)) dropRef();
    if (el === ref) ref = ref.nextElementSibling;
    else list.insertBefore(el, ref);
  }
  while (ref) dropRef();
}

// --- Reservierung (nur Restaurants) ----------------------------------------------------
// place.reservation = { date: 'JJJJ-MM-TT', time: 'HH:MM' } (beide optional) oder nicht gesetzt.

const RESERVABLE_CATEGORY = 'restaurant';

function cleanReservation(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : '',
    time: /^\d{2}:\d{2}$/.test(r.time || '') ? r.time : '',
  };
}

function reservationHtml(res) {
  if (!res) {
    return `<button type="button" class="chip-btn res-mark" data-action="reserve">${icon('calendar-check', { size: 15, stroke: 2 })}Als reserviert markieren</button>`;
  }
  return `<div class="res-edit">
      <span class="res-title">${icon('calendar-check', { size: 15, stroke: 2.2 })}Reserviert</span>
      <div class="res-fields">
        <input type="date" data-action="res-date" value="${escapeHtml(res.date || '')}" aria-label="Datum der Reservierung">
        <input type="time" data-action="res-time" value="${escapeHtml(res.time || '')}" aria-label="Uhrzeit der Reservierung">
      </div>
      <button type="button" class="btn-link muted" data-action="unreserve">Reservierung entfernen</button>
    </div>`;
}

async function saveReservation(place, next, message) {
  const before = place.reservation || null;
  const value = next ? cleanReservation(next) : null;
  if (value) place.reservation = value; else delete place.reservation;
  render();
  const ok = await persist((b) => b.updatePlace(place.id, { reservation: value }),
    'Reservierung konnte nicht gespeichert werden (Spalte „reservation“ in Supabase angelegt?)');
  if (!ok) {
    if (before) place.reservation = before; else delete place.reservation;
    render();
    return;
  }
  toast(message);
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
  }
  if (activeId && fly) mapView.focusPlace(activeId);
  if (activeId && scrollList) {
    const li = $(`#place-list .place[data-id="${CSS.escape(activeId)}"]`);
    // Marker eines Orts angetippt, der in der zugeklappten Liste versteckt ist → Liste aufklappen
    if (li?.classList.contains('is-extra') && !placesExpanded) {
      placesExpanded = true;
      renderPlaceMore($$('#place-list .place').length);
    }
    // auf dem Handy erst nach dem Aufziehen des Blatts scrollen (Animation 0,25 s)
    setTimeout(() => li?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), isMobile() ? 280 : 0);
  }
}

// --- Airbnb ---------------------------------------------------------------------------
// state.airbnb = { name, address, label, lat, lng } – label = „Name · Adresse“ für Karte und ältere Versionen.

function setAirbnb(airbnb) {
  if (fixedAirbnb) return;
  state.airbnb = airbnb;
  if (airbnb && state.ui.sort !== 'distance') state.ui.sort = 'distance';
  $('#sort').value = state.ui.sort;
  closeAirbnbForm();
  render();
  persistSettings();
  if (airbnb) {
    mapView.centerOn([airbnb.lat, airbnb.lng], Math.max(mapView.map.getZoom(), 11));
    toast('Unterkunft gespeichert – Entfernungen werden jetzt berechnet.');
  }
}

const airbnbLabel = (name, address) => [name, address].filter(Boolean).join(' · ');

function openAirbnbForm({ auto = false } = {}) {
  airbnbFormAuto = auto;
  const a = state.airbnb;
  const { name, address } = airbnbParts(a);
  $('#airbnb-name-input').value = name;
  $('#airbnb-address-input').value = address;
  $('#airbnb-url-input').value = a?.url || '';
  $('#airbnb-maps-input').value = a?.mapsUrl || '';
  $('#airbnb-error').textContent = '';
  $('#btn-pick').hidden = true;
  $('#btn-airbnb-cancel').hidden = !a;
  $('#btn-airbnb-clear').hidden = !a;
  $('#airbnb-view').hidden = true; // beim Bearbeiten nur das Formular – „Abbrechen“ zeigt die Anzeige wieder
  $('#airbnb-form').hidden = false;
}

function closeAirbnbForm() {
  airbnbFormAuto = false;
  $('#airbnb-form').hidden = true;
  $('#airbnb-view').hidden = false;
  if (pickMode) setPickMode(false);
}

function setPickMode(on) {
  pickMode = on;
  $('#pick-banner').hidden = !on;
  $('#map').classList.toggle('is-picking', on);
  if (on && isMobile()) {
    // Karte freimachen: Liste ganz einklappen, offene Boxen zu (sonst verdecken sie die Karte)
    setSheet('hidden');
    $$('.panel-row details[open]').forEach((d) => { d.open = false; });
  }
}

$('#btn-airbnb-edit').addEventListener('click', () => {
  if ($('#airbnb-form').hidden) openAirbnbForm();
  else closeAirbnbForm();
});
$('#btn-airbnb-cancel').addEventListener('click', closeAirbnbForm);

// Link aus einem Eingabefeld: ohne Schema wird https:// ergänzt; '' = leer, null = kein gültiger http(s)-Link
function cleanLink(value) {
  const v = value.trim();
  if (!v) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

// Speichern. Position (Pin) in dieser Reihenfolge: aus dem Google-Maps-Link (genaue Ortsmarke) – sonst die
// bisherigen Koordinaten, wenn die Adresse gleich blieb – sonst Adresssuche (OpenStreetMap). Wird nichts
// gefunden, lässt sich der Punkt auf der Karte wählen. Die Route führt immer zur Adresse.
$('#airbnb-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#airbnb-name-input').value.trim().slice(0, 120);
  const address = $('#airbnb-address-input').value.trim().slice(0, 300);
  const url = cleanLink($('#airbnb-url-input').value);
  let mapsUrl = cleanLink($('#airbnb-maps-input').value);
  if (mapsUrl && hasShortMapsLinks(mapsUrl)) mapsUrl = (await expandMapsLinks(mapsUrl)).text;
  const error = $('#airbnb-error');
  error.textContent = '';
  if (!address) {
    error.textContent = 'Bitte die Adresse eintragen – sie ist das Ziel für die Route.';
    return;
  }
  if (url === null || mapsUrl === null) {
    error.textContent = 'Bitte einen gültigen Link eintragen (beginnt mit https://) oder das Feld leer lassen.';
    return;
  }
  const prev = state.airbnb;
  const entry = { ...(prev || {}), name, address, url, mapsUrl, label: airbnbLabel(name, address) };
  const pin = mapsUrl ? parseCoords(mapsUrl) : null;
  if (pin) {
    setAirbnb({ ...entry, ...pin });
    return;
  }
  // Kurzlink (maps.app.goo.gl) o. Ä. ohne Koordinaten: Pin über die Adresse, mit Hinweis
  const noCoordsHint = mapsUrl && mapsUrl !== prev?.mapsUrl
    ? 'Aus dem Google-Maps-Link liess sich keine Position lesen – der Pin wurde über die Adresse gesetzt.'
    : '';
  if (prev && airbnbParts(prev).address === address && hasCoords(prev)) {
    setAirbnb(entry);
    if (noCoordsHint) toast(noCoordsHint, { sticky: true });
    return;
  }
  const save = $('#btn-airbnb-save');
  save.disabled = true;
  save.textContent = 'Suche Adresse …';
  try {
    const [hit] = await geocode(address, MALLORCA_CENTER);
    if (!hit) throw new Error('nicht gefunden');
    setAirbnb({ ...entry, lat: hit.lat, lng: hit.lng });
    if (noCoordsHint) toast(noCoordsHint, { sticky: true });
  } catch (err) {
    error.textContent = err.message === 'nicht gefunden'
      ? 'Adresse nicht gefunden. Schreib sie genauer (Strasse, Nummer, Ort), füge den Google-Maps-Link ein oder wähle den Punkt auf der Karte.'
      : `Adresssuche nicht erreichbar (${err.message}). Füge den Google-Maps-Link ein oder wähle den Punkt auf der Karte.`;
    $('#btn-pick').hidden = false;
  } finally {
    save.disabled = false;
    save.textContent = 'Speichern';
  }
});

$('#btn-pick').addEventListener('click', () => setPickMode(!pickMode));
$('#btn-pick-cancel').addEventListener('click', () => setPickMode(false));
$('#btn-airbnb-clear').addEventListener('click', () => {
  state.airbnb = fixedAirbnb;
  closeAirbnbForm();
  render();
  persistSettings();
});

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
  if (chip.dataset.filter === 'starred') {
    state.ui.starred = !state.ui.starred;
    render();
    return;
  }
  if (chip.dataset.filter === 'open') {
    state.ui.openNow = !state.ui.openNow;
    render();
    return;
  }
  if (chip.dataset.filter === 'reserved') {
    state.ui.reserved = !state.ui.reserved;
    render();
    return;
  }
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
  state.ui.reserved = false;
  state.ui.starred = false;
  state.ui.openNow = false;
  state.ui.search = '';
  $('#search').value = '';
  render({ fit: true });
}

// --- Reisekasse -------------------------------------------------------------------------------
// Teilnehmende als feste Namensliste (state.participants), Rechnungen in state.expenses.
// Gerechnet wird in js/cash.js (Euro-Cent, Aufteilung gleich/nach Anteilen/nach Beträgen, Ausgleich).
// Rechnungen in Franken werden zum Tageskurs in Euro umgerechnet gespeichert (Kurs bleibt fest);
// „bezahlt“ im Ausgleich legt eine Rückzahlung an (kind: 'transfer'), die nur den Saldo verändert.

const cashDialog = $('#cash-dialog');
// Auswahl im Formular – bleibt beim Neuzeichnen (z. B. Abgleich alle 20 s) erhalten.
// splitValues: Eingaben je Person als Text (Anteile bzw. Beträge in der gewählten Währung)
const cashForm = { editingId: null, payer: null, shared: new Set(), currency: 'EUR', splitMode: 'equal', splitValues: {}, kind: null };
const todayIso = () => new Date().toLocaleDateString('sv-SE'); // JJJJ-MM-TT in Ortszeit
const personName = (id) => state.participants.find((p) => p.id === id)?.name || 'Unbekannt';
const cashBlocked = () => backend.kind === 'shared' && state.cashMissing;
// Spalten für Franken, Aufteilung und Ausgleich fehlen noch (SQL nicht erneut ausgeführt)
const extrasBlocked = () => backend.kind === 'shared' && state.cashExtrasMissing;
// Ausgleich in Franken: Tageskurs (siehe loadRate) und Klappzustand, der beim Neuzeichnen erhalten bleibt
let fx = cachedRate();
let fxLoading = false;
let cashSettleOpen = false;
let cashSplitSig = '';
const longDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : iso; };
const centsText = (cents) => (cents / 100).toFixed(2).replace('.', ',');
// Betrag einer Rechnung so, wie er erfasst wurde (Franken oder Euro)
const enteredMoney = (e) => (e.orig?.currency === 'CHF' ? formatChf(e.orig.cents) : formatEuro(e.amountCents));

// „2026-10-01“ → „Do 1.10.“
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}

function renderCash() {
  $('#cash-total').textContent = formatEuro(expenseTotal(state.expenses));
  if (cashDialog.open) renderCashDialog();
}

function resetCashForm() {
  cashForm.editingId = null;
  cashForm.payer = null; // muss bei jeder Rechnung bewusst gewählt werden – keine Vorauswahl
  cashForm.kind = null;
  cashForm.shared = new Set(state.participants.map((p) => p.id));
  cashForm.currency = 'EUR';
  cashForm.splitMode = 'equal';
  cashForm.splitValues = {};
  cashSplitSig = '';
  $('#cash-amount').value = '';
  $('#cash-what').value = '';
  $('#cash-date').value = todayIso();
  $('#cash-error').textContent = '';
  $('#cash-payer').classList.remove('is-missing');
  $('#cash-form-title').textContent = 'Rechnung erfassen';
  $('#cash-submit').textContent = 'Rechnung speichern';
  $('#cash-cancel').hidden = true;
}

function renderCashDialog() {
  const people = state.participants;
  // Personen, die inzwischen entfernt wurden (z. B. von Mitreisenden), aus der Auswahl nehmen
  if (cashForm.payer && !people.some((p) => p.id === cashForm.payer)) cashForm.payer = null;
  for (const id of [...cashForm.shared]) if (!people.some((p) => p.id === id)) cashForm.shared.delete(id);

  $('#cash-missing').hidden = !cashBlocked();
  $('#cash-extras-missing').hidden = cashBlocked() || !extrasBlocked();
  const used = new Set(state.expenses.flatMap((e) => [e.paidBy, ...e.sharedWith]));
  $('#cash-people').innerHTML = people.length
    ? people.map((p) => `<span class="cash-person">${escapeHtml(p.name)}<button type="button" class="cash-person-x" data-remove-person="${escapeHtml(p.id)}" aria-label="${escapeHtml(p.name)} entfernen" title="${used.has(p.id) ? 'Kommt in Rechnungen vor' : 'Entfernen'}">${icon('close', { size: 12, stroke: 2.6 })}</button></span>`).join('')
    : '<p class="hint">Noch niemand eingetragen.</p>';

  $('#cash-people-count').textContent = people.length ? `· ${people.length}` : '';
  $('#cash-list-count').textContent = state.expenses.length ? `· ${state.expenses.length}` : '';
  $('#cash-list-empty').hidden = state.expenses.length > 0;
  $('#cash-form').hidden = !people.length;
  $('#cash-form-hint').hidden = !!people.length;
  const chip = (p, on, attr) => `<button type="button" class="cash-chip" ${attr}="${escapeHtml(p.id)}" aria-pressed="${on}">${escapeHtml(p.name)}</button>`;
  $('#cash-payer').innerHTML = people.map((p) => chip(p, cashForm.payer === p.id, 'data-payer')).join('');
  if (cashForm.payer) $('#cash-payer').classList.remove('is-missing');
  // Kaffeerunde: wer ist dran? (ab zwei Personen; braucht die Spalte „kind“ in der Datenbank)
  const coffeeOk = people.length >= 2 && !extrasBlocked();
  $('#cash-coffee').hidden = !coffeeOk || !!cashForm.editingId || cashForm.kind === 'coffee';
  if (coffeeOk) {
    const turns = coffeeTurns(state.expenses, people);
    $('#cash-coffee-text').innerHTML = `☕ Nächste Kaffeerunde: <strong>${escapeHtml(turns[0].name)}</strong>
      <small>${turns.map((t) => `${escapeHtml(t.name)} ${t.rounds}`).join(' · ')}</small>`;
  }
  $('#cash-coffee-mode').hidden = cashForm.kind !== 'coffee';
  $('#cash-coffee-off').hidden = !!cashForm.editingId;
  $('#cash-shared').innerHTML = people.map((p) => chip(p, cashForm.shared.has(p.id), 'data-shared')).join('');

  // Währung und Aufteilung: Franken braucht einen Kurs, beides die neuen Spalten (gemeinsame Reise)
  const editingChf = state.expenses.find((x) => x.id === cashForm.editingId)?.orig?.currency === 'CHF';
  $$('.cash-cur-btn', cashDialog).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.cur === cashForm.currency));
    b.disabled = b.dataset.cur === 'CHF' && cashForm.currency !== 'CHF' && (extrasBlocked() || (!fx && !editingChf));
    b.title = b.disabled ? (extrasBlocked() ? 'Datenbank noch nicht erweitert (siehe Hinweis oben)' : 'Kein Wechselkurs verfügbar') : '';
  });
  $$('.cash-seg', cashDialog).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.split === cashForm.splitMode));
    b.disabled = b.dataset.split !== 'equal' && b.dataset.split !== cashForm.splitMode && extrasBlocked();
  });
  renderCashSplitRows();
  renderCashPreview();
  renderCashSummary();
  renderCashList();
}

// Eingabezeilen für Anteile bzw. Beträge – nur neu aufbauen, wenn sich Personen, Art oder Währung ändern,
// damit das Neuzeichnen (Abgleich) nicht mitten im Tippen das Feld leert
function renderCashSplitRows() {
  const box = $('#cash-split-rows');
  const ids = state.participants.map((p) => p.id).filter((id) => cashForm.shared.has(id));
  const sig = [cashForm.splitMode, cashForm.currency, ...ids].join('|');
  box.hidden = cashForm.splitMode === 'equal' || !ids.length;
  if (sig === cashSplitSig) return;
  cashSplitSig = sig;
  if (box.hidden) { box.innerHTML = ''; return; }
  const amounts = cashForm.splitMode === 'amounts';
  const unit = amounts ? (cashForm.currency === 'CHF' ? 'CHF' : '€') : 'Teil(e)';
  box.innerHTML = ids.map((id) => {
    const value = cashForm.splitValues[id] ?? (amounts ? '' : '1');
    return `<label class="cash-split-row"><span class="cash-split-name">${escapeHtml(personName(id))}</span>
      <input type="text" inputmode="decimal" data-split-id="${escapeHtml(id)}" value="${escapeHtml(value)}" placeholder="${amounts ? '0,00' : '1'}" aria-label="${amounts ? 'Betrag' : 'Anteil'} von ${escapeHtml(personName(id))}">
      <span class="cash-split-unit">${unit}</span></label>`;
  }).join('');
}

// Formular auswerten – für Vorschau und Speichern. Ergebnis: Euro-Betrag, optionale Franken-Angabe
// und Aufteilung, oder ein Fehlertext.
function readCashForm() {
  const entered = parseAmount($('#cash-amount').value); // in der gewählten Währung
  const ids = state.participants.map((p) => p.id).filter((id) => cashForm.shared.has(id));
  const chf = cashForm.currency === 'CHF';
  const editing = state.expenses.find((x) => x.id === cashForm.editingId);
  // Beim Bearbeiten einer Franken-Rechnung gilt weiter ihr ursprünglicher Kurs – der Saldo bleibt stabil
  const rate = chf ? (editing?.orig?.currency === 'CHF' ? editing.orig.rate : fx?.rate) : null;
  const money = (c) => (chf ? formatChf(c) : formatEuro(c));
  const r = { entered, ids, chf, rate, money, amountCents: null, orig: null, split: null, error: '', remaining: 0 };
  if (!entered) return r;
  if (chf && !rate) { r.error = 'Gerade kein Wechselkurs verfügbar – bitte in Euro erfassen.'; return r; }
  r.amountCents = chf ? toEuroCents(entered, rate) : entered;
  if (chf) r.orig = { currency: 'CHF', cents: entered, rate };
  if (cashForm.splitMode !== 'equal' && ids.length) {
    const amounts = cashForm.splitMode === 'amounts';
    const values = {};
    for (const id of ids) {
      const raw = cashForm.splitValues[id] ?? (amounts ? '' : '1');
      const v = amounts ? parseAmount(raw) : parseShare(raw);
      if (!v) {
        r.error = `Bitte für ${personName(id)} ${amounts ? 'einen Betrag' : 'einen Anteil grösser 0'} eintragen – oder bei „Für wen“ abwählen.`;
        return r;
      }
      values[id] = v;
    }
    if (amounts) {
      const sum = Object.values(values).reduce((a, b) => a + b, 0);
      r.remaining = entered - sum;
      if (r.remaining) {
        r.error = r.remaining > 0 ? `Noch ${money(r.remaining)} zu verteilen (Rechnung ${money(entered)}).` : `${money(-r.remaining)} zu viel verteilt (Rechnung ${money(entered)}).`;
        return r;
      }
    }
    r.split = { mode: cashForm.splitMode, values };
  }
  return r;
}

function renderCashPreview() {
  const r = readCashForm();
  const el = $('#cash-preview');
  if (!r.entered || !r.ids.length) { el.textContent = r.error; return; }
  if (r.error) { el.textContent = r.error; return; }
  const fxNote = r.chf ? `≈ ${formatEuro(r.amountCents)} (1 € = ${r.rate.toFixed(4)} CHF) · ` : '';
  const n = r.ids.length;
  if (!r.split) {
    el.textContent = fxNote + (n === 1 ? 'Ganz für 1 Person'
      : `Je ${formatEuro(Math.floor(r.amountCents / n))}${r.amountCents % n ? ' (±1 Cent)' : ''} für ${n} Personen`);
    return;
  }
  const shares = sharesOf({ id: cashForm.editingId || 'neu', amountCents: r.amountCents, sharedWith: r.ids, split: r.split });
  el.textContent = fxNote + r.ids.map((id) => `${personName(id)} ${formatEuro(shares.get(id))}`).join(' · ');
}

function renderCashSummary() {
  const box = $('#cash-summary');
  if (!state.expenses.length) {
    box.innerHTML = '<p class="hint">Noch keine Rechnungen erfasst.</p>';
    return;
  }
  const balances = computeBalances(state.expenses, state.participants);
  const total = expenseTotal(state.expenses);
  const anySettled = state.expenses.some(isTransfer);
  const saldo = (c) => c > 0
    ? `<span class="cash-pos">+${formatEuro(c)}</span>`
    : c < 0 ? `<span class="cash-neg">−${formatEuro(-c)}</span>` : '<span class="muted">±0</span>';
  const transfers = settle(balances);
  const paidBtn = (t) => `<button type="button" class="cash-paid-btn" data-settle-from="${escapeHtml(t.from)}" data-settle-to="${escapeHtml(t.to)}" data-settle-cents="${t.cents}"${extrasBlocked() ? ' disabled title="Datenbank noch nicht erweitert (siehe Hinweis oben)"' : ''}>${icon('check', { size: 13, stroke: 3 })}bezahlt</button>`;
  box.innerHTML = `
    <div class="cash-table-wrap">
      <table class="cash-table">
        <thead><tr><th scope="col">Person</th><th scope="col">Bezahlt</th><th scope="col">Anteil</th><th scope="col">Saldo</th></tr></thead>
        <tbody>${balances.map((b) => `<tr><th scope="row">${escapeHtml(b.name)}</th><td>${formatEuro(b.paid)}</td><td>${formatEuro(b.share)}</td><td>${saldo(b.balance)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th scope="row">Total</th><td>${formatEuro(total)}</td><td>${formatEuro(total)}</td><td></td></tr></tfoot>
      </table>
    </div>
    <p class="hint cash-legend">Anteil = was die Person verbraucht hat. Plus = bekommt Geld zurück, Minus = schuldet Geld.${anySettled ? ' Bereits bezahlte Ausgleichszahlungen sind im Saldo berücksichtigt.' : ''}</p>
    <details class="cash-settle cash-fold" id="cash-settle-fold"${cashSettleOpen ? ' open' : ''}>
      <summary class="cash-fold-head">
        <h4>Ausgleich <span class="cash-fold-count">· ${transfers.length ? `${transfers.length} ${transfers.length === 1 ? 'Zahlung' : 'Zahlungen'}` : 'alles ausgeglichen'}</span></h4>
        ${icon('chevron-down', { size: 18, stroke: 2.2, cls: 'cash-fold-chevron' })}
      </summary>
      <div class="cash-fold-body">
        ${transfers.length
          ? `<ul>${transfers.map((t) => `<li>
              <span class="cash-settle-who"><strong>${escapeHtml(personName(t.from))}</strong> ${icon('arrow-right', { size: 14, stroke: 2.4 })} <strong>${escapeHtml(personName(t.to))}</strong></span>
              <span class="cash-settle-amount">${fx ? formatChf(toRappen(t.cents, fx.rate)) : formatEuro(t.cents)}</span>
              ${fx ? `<span class="cash-eur">
                <button type="button" class="cash-eur-btn" aria-expanded="false" aria-label="Betrag in Euro anzeigen" title="In Euro">€</button>
                <span class="cash-eur-pop" hidden>${formatEuro(t.cents)}</span>
              </span>` : ''}
              ${paidBtn(t)}
            </li>`).join('')}</ul>`
          : '<p class="hint">Alles ausgeglichen – niemand schuldet jemandem etwas.</p>'}
        <p class="hint cash-fx">${fx
          ? `In Franken zum EZB-Referenzkurs vom ${longDate(fx.date)}: 1 € = ${fx.rate.toFixed(4)} CHF.${fx.fetched === todayIso() ? '' : fxLoading ? ' Tageskurs wird aktualisiert …' : ' Gerade kein Internet – letzter bekannter Kurs.'} Mit € den Euro-Betrag anzeigen.`
          : fxLoading ? 'Wechselkurs wird geladen …' : 'Wechselkurs gerade nicht abrufbar – Beträge in Euro.'}
          ${transfers.length ? ' Nach der Überweisung auf „bezahlt“ tippen – der Saldo wird für alle angepasst.' : ''}</p>
      </div>
    </details>`;
}

function renderCashList() {
  const list = $('#cash-list');
  if (!state.expenses.length) {
    list.innerHTML = '';
    return;
  }
  const allIds = state.participants.map((p) => p.id);
  const sorted = [...state.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.addedAt - a.addedAt);
  const amountHtml = (e) => `<span class="cash-item-amount">${enteredMoney(e)}${e.orig?.currency === 'CHF' ? `<span class="cash-item-sub">≈ ${formatEuro(e.amountCents)}</span>` : ''}</span>`;
  list.innerHTML = sorted.map((e) => {
    if (isTransfer(e)) {
      const meta = [shortDate(e.date), `${escapeHtml(personName(e.paidBy))} → ${escapeHtml(personName(e.sharedWith[0]))} bezahlt`].filter(Boolean).join(' · ');
      return `<li class="cash-item is-transfer">
        <div class="cash-item-main">
          <span class="cash-item-title">${icon('check', { size: 14, stroke: 3 })} Ausgleich</span>
          <span class="cash-item-meta">${meta}</span>
        </div>
        ${amountHtml(e)}
        <span class="cash-item-actions">
          <button type="button" class="cash-icon-btn is-danger" data-delete-expense="${escapeHtml(e.id)}" aria-label="Ausgleichszahlung rückgängig machen" title="Rückgängig">${icon('trash', { size: 15, stroke: 2 })}</button>
        </span>
      </li>`;
    }
    const forAll = allIds.length > 1 && allIds.every((id) => e.sharedWith.includes(id)) && e.sharedWith.length === allIds.length;
    let forText;
    if (e.split) {
      const shares = sharesOf(e);
      forText = `für ${e.sharedWith.map((id) => `${escapeHtml(personName(id))} ${formatEuro(shares.get(id))}`).join(', ')}`;
    } else {
      const each = Math.floor(e.amountCents / e.sharedWith.length);
      forText = `für ${escapeHtml(forAll ? 'alle' : e.sharedWith.map(personName).join(', '))}${e.sharedWith.length > 1 ? ` (je ${formatEuro(each)})` : ''}`;
    }
    const meta = [shortDate(e.date), `bezahlt von ${escapeHtml(personName(e.paidBy))}`, forText].filter(Boolean).join(' · ');
    return `<li class="cash-item${cashForm.editingId === e.id ? ' is-editing' : ''}">
      <div class="cash-item-main">
        <span class="cash-item-title">${e.kind === 'coffee' ? `${icon('coffee', { size: 14, stroke: 2.2 })} ` : ''}${escapeHtml(e.title || 'Rechnung')}</span>
        <span class="cash-item-meta">${meta}</span>
      </div>
      ${amountHtml(e)}
      <span class="cash-item-actions">
        <button type="button" class="cash-icon-btn" data-edit-expense="${escapeHtml(e.id)}" aria-label="Rechnung bearbeiten" title="Bearbeiten">${icon('pencil', { size: 15, stroke: 2 })}</button>
        <button type="button" class="cash-icon-btn is-danger" data-delete-expense="${escapeHtml(e.id)}" aria-label="Rechnung löschen" title="Löschen">${icon('trash', { size: 15, stroke: 2 })}</button>
      </span>
    </li>`;
  }).join('');
}

function openCash() {
  resetCashForm();
  cashSettleOpen = false;
  // Tageskurs holen (höchstens einmal pro Tag), danach Abrechnung und Franken-Knopf neu zeichnen
  fxLoading = fx?.fetched !== todayIso();
  loadRate().then((v) => {
    fxLoading = false;
    if (v) fx = v;
    if (cashDialog.open) renderCashDialog();
  });
  $('#cash-people-fold').open = !state.participants.length;
  $('#cash-form-fold').open = true;
  $('#cash-summary-fold').open = false;
  $('#cash-list-fold').open = false;
  renderCashDialog();
  cashDialog.showModal();
}

$('#cash-panel').addEventListener('click', openCash);

// Kaffeerunde: Formular vorbereiten (für alle, „Wofür“ = Kaffeerunde). Wer bezahlt hat, wird wie immer
// bewusst gewählt – der Hinweis oben sagt, wer dran wäre.
$('#cash-coffee-btn').addEventListener('click', () => {
  cashForm.kind = 'coffee';
  cashForm.shared = new Set(state.participants.map((p) => p.id));
  const what = $('#cash-what');
  if (!what.value.trim()) what.value = 'Kaffeerunde';
  $('#cash-form-fold').open = true;
  renderCashDialog();
  $('#cash-amount').focus();
});
$('#cash-coffee-off').addEventListener('click', () => {
  cashForm.kind = null;
  if ($('#cash-what').value.trim() === 'Kaffeerunde') $('#cash-what').value = '';
  renderCashDialog();
});

// Rechnung für einen Ort (aus der Liste oder dem Detailfenster auf der Karte): „Wofür“ ist vorausgefüllt
function openCashFor(place) {
  openCash();
  $('#cash-what').value = String(place.name || '').slice(0, 120);
}

$('#cash-person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#cash-person-input');
  const name = input.value.trim().slice(0, 30);
  if (!name) return;
  if (cashBlocked()) return toast('Die Ausgaben sind in der Datenbank noch nicht eingerichtet (siehe Hinweis oben).');
  if (state.participants.some((p) => norm(p.name) === norm(name))) return toast(`„${name}“ ist schon eingetragen`);
  const person = { id: newId(), name };
  state.participants.push(person);
  // Neue Person beim gerade offenen Formular gleich mit auswählen
  if (!cashForm.editingId) cashForm.shared.add(person.id);
  input.value = '';
  render();
  let merged = null;
  const ok = await persist(async (b) => { merged = await b.changeParticipants({ add: person }); }, 'Person konnte nicht gespeichert werden');
  if (!ok) {
    state.participants = state.participants.filter((p) => p.id !== person.id);
    render();
    return;
  }
  // Gemeinsame Reise: Liste vom Server übernehmen (enthält auch gleichzeitig hinzugefügte Personen)
  if (merged) {
    state.participants = sanitizeParticipants(merged);
    render();
  }
});

// Klappzustand „Ausgleich“ merken („toggle“ steigt nicht auf, daher in der Capture-Phase)
cashDialog.addEventListener('toggle', (e) => {
  if (e.target.id === 'cash-settle-fold') cashSettleOpen = e.target.open;
}, true);

// Eingaben bei Anteilen/Beträgen: Wert merken und nur die Vorschau aktualisieren (Fokus bleibt)
cashDialog.addEventListener('input', (e) => {
  const id = e.target.dataset?.splitId;
  if (!id) return;
  cashForm.splitValues[id] = e.target.value;
  renderCashPreview();
});

cashDialog.addEventListener('click', async (e) => {
  // Euro-Sprechblase: € zeigt/versteckt sie, jeder andere Klick schliesst offene Blasen
  const eurBtn = e.target.closest('.cash-eur-btn');
  $$('.cash-eur-btn', cashDialog).forEach((b) => {
    const open = b === eurBtn && b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    b.nextElementSibling.hidden = !open;
  });
  if (eurBtn) return;
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.removePerson) {
    const person = state.participants.find((p) => p.id === btn.dataset.removePerson);
    if (!person) return;
    if (state.expenses.some((x) => x.paidBy === person.id || x.sharedWith.includes(person.id))) {
      return toast(`„${person.name}“ kommt in Rechnungen vor – zuerst diese Rechnungen ändern oder löschen.`);
    }
    if (!confirm(`„${person.name}“ aus den Ausgaben entfernen?`)) return;
    const index = state.participants.findIndex((p) => p.id === person.id);
    state.participants = state.participants.filter((p) => p.id !== person.id);
    render();
    let merged = null;
    const ok = await persist(async (b) => { merged = await b.changeParticipants({ removeId: person.id }); }, `„${person.name}“ konnte nicht entfernt werden`);
    if (!ok) {
      if (!state.participants.some((p) => p.id === person.id)) state.participants.splice(Math.max(0, index), 0, person);
      render();
      return;
    }
    if (merged) {
      state.participants = sanitizeParticipants(merged);
      render();
    }
    return;
  }
  if (btn.dataset.payer) {
    cashForm.payer = btn.dataset.payer;
    if ($('#cash-error').textContent === PAYER_MISSING) $('#cash-error').textContent = '';
    renderCashDialog();
    return;
  }
  if (btn.dataset.shared) {
    const id = btn.dataset.shared;
    cashForm.shared.has(id) ? cashForm.shared.delete(id) : cashForm.shared.add(id);
    renderCashDialog();
    return;
  }
  if (btn.id === 'cash-all') {
    cashForm.shared = new Set(state.participants.map((p) => p.id));
    renderCashDialog();
    return;
  }
  if (btn.dataset.cur) {
    if (btn.dataset.cur === cashForm.currency) return;
    cashForm.currency = btn.dataset.cur;
    if (cashForm.splitMode === 'amounts') cashForm.splitValues = {}; // Beträge gelten in der alten Währung
    renderCashDialog();
    return;
  }
  if (btn.dataset.split) {
    const mode = btn.dataset.split;
    if (mode === cashForm.splitMode) return;
    cashForm.splitMode = mode;
    cashForm.splitValues = {};
    // Beträge: mit der gleichmässigen Aufteilung vorbelegen – dann nur noch anpassen
    const entered = parseAmount($('#cash-amount').value);
    const ids = state.participants.map((p) => p.id).filter((id) => cashForm.shared.has(id));
    if (mode === 'amounts' && entered && ids.length) {
      for (const [id, c] of splitCents(entered, ids, cashForm.editingId || 'neu')) cashForm.splitValues[id] = centsText(c);
    }
    renderCashDialog();
    return;
  }
  if (btn.dataset.settleFrom) {
    // Ausgleich als bezahlt markieren: nur, wenn die Zahlung noch genau so offen ist
    const { settleFrom: from, settleTo: to } = btn.dataset;
    const t = settle(computeBalances(state.expenses, state.participants)).find((x) => x.from === from && x.to === to);
    if (!t) return renderCashDialog();
    if (extrasBlocked()) return toast('Dafür bitte zuerst das SQL aus supabase/schema.sql nochmals ausführen (siehe Hinweis oben).');
    const shown = fx ? formatChf(toRappen(t.cents, fx.rate)) : formatEuro(t.cents);
    if (!confirm(`${personName(from)} hat ${personName(to)} ${shown} bezahlt?\n\nDer Saldo wird für alle angepasst; rückgängig machen geht in der Liste „Rechnungen“.`)) return;
    const exp = {
      id: newId(), kind: 'transfer', title: 'Ausgleich', amountCents: t.cents, paidBy: from, sharedWith: [to],
      date: todayIso(), addedBy: memberName(), addedAt: Date.now(),
      ...(fx ? { orig: { currency: 'CHF', cents: toRappen(t.cents, fx.rate), rate: fx.rate } } : {}),
    };
    state.expenses.push(exp);
    render();
    const ok = await persist((b) => b.addExpenses([exp]), 'Ausgleich konnte nicht gespeichert werden');
    if (!ok) { state.expenses = state.expenses.filter((x) => x.id !== exp.id); render(); return; }
    toast(`Als bezahlt markiert: ${personName(from)} → ${personName(to)}`);
    return;
  }
  if (btn.id === 'cash-cancel') {
    resetCashForm();
    renderCashDialog();
    return;
  }
  if (btn.dataset.editExpense) {
    const exp = state.expenses.find((x) => x.id === btn.dataset.editExpense);
    if (!exp || isTransfer(exp)) return;
    cashForm.editingId = exp.id;
    cashForm.payer = exp.paidBy;
    cashForm.kind = exp.kind === 'coffee' ? 'coffee' : null;
    cashForm.shared = new Set(exp.sharedWith);
    cashForm.currency = exp.orig?.currency === 'CHF' ? 'CHF' : 'EUR';
    cashForm.splitMode = exp.split?.mode || 'equal';
    cashForm.splitValues = {};
    for (const [id, v] of Object.entries(exp.split?.values || {})) {
      cashForm.splitValues[id] = exp.split.mode === 'amounts' ? centsText(v) : String(v).replace('.', ',');
    }
    cashSplitSig = '';
    $('#cash-amount').value = centsText(cashForm.currency === 'CHF' ? exp.orig.cents : exp.amountCents);
    $('#cash-what').value = exp.title;
    $('#cash-date').value = exp.date;
    $('#cash-error').textContent = '';
    $('#cash-form-title').textContent = 'Rechnung bearbeiten';
    $('#cash-submit').textContent = 'Änderungen speichern';
    $('#cash-cancel').hidden = false;
    renderCashDialog();
    $('#cash-form-fold').open = true; // falls zugeklappt: Formular zum Bearbeiten zeigen
    $('#cash-form-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (btn.dataset.deleteExpense) {
    const exp = state.expenses.find((x) => x.id === btn.dataset.deleteExpense);
    if (!exp) return;
    const question = isTransfer(exp)
      ? `Ausgleichszahlung ${personName(exp.paidBy)} → ${personName(exp.sharedWith[0])} über ${enteredMoney(exp)} rückgängig machen?`
      : `Rechnung „${exp.title || 'Rechnung'}“ über ${enteredMoney(exp)} löschen?`;
    if (!confirm(question)) return;
    state.expenses = state.expenses.filter((x) => x.id !== exp.id);
    if (cashForm.editingId === exp.id) resetCashForm();
    render();
    const ok = await persist((b) => b.deleteExpense(exp.id), 'Eintrag konnte nicht gelöscht werden');
    if (!ok) { if (!state.expenses.some((x) => x.id === exp.id)) state.expenses.push(exp); render(); return; }
    toast(isTransfer(exp) ? 'Ausgleich rückgängig gemacht' : 'Rechnung gelöscht');
  }
});

$('#cash-amount').addEventListener('input', renderCashPreview);

// Bestätigung direkt im Ausgaben-Fenster (eine Meldung am Bildschirmrand läge hinter dem Fenster) und kurz
// „✓ Gespeichert“ auf dem Knopf; solange ist er gesperrt, damit ein zweiter Tipp nicht leer absendet.
let cashSuccessTimer;
const PAYER_MISSING = 'Bitte bei „Bezahlt von“ auswählen, wer die Rechnung bezahlt hat.';
function showCashSuccess(text) {
  const box = $('#cash-success');
  const btn = $('#cash-submit');
  box.textContent = text;
  $('#cash-error').textContent = '';
  btn.disabled = true;
  btn.textContent = '✓ Gespeichert';
  clearTimeout(cashSuccessTimer);
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = cashForm.editingId ? 'Änderungen speichern' : 'Rechnung speichern';
  }, 1400);
  cashSuccessTimer = setTimeout(() => { box.textContent = ''; }, 6000);
}

$('#cash-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('#cash-submit').disabled) return;
  const error = $('#cash-error');
  $('#cash-success').textContent = '';
  const r = readCashForm();
  error.textContent = cashBlocked() ? 'Die Ausgaben sind in der Datenbank noch nicht eingerichtet (siehe Hinweis oben).'
    : !r.entered ? 'Bitte einen gültigen Betrag eingeben, z. B. 24.50 oder 24,50.'
    : !cashForm.payer ? PAYER_MISSING
    : !r.ids.length ? 'Bitte bei „Für wen“ mindestens eine Person auswählen.'
    : r.error ? r.error
    : (r.orig || r.split || cashForm.kind === 'coffee') && extrasBlocked() ? 'Franken und ungleiche Aufteilung gehen erst, wenn die Datenbank erweitert ist (siehe Hinweis oben).'
    : '';
  if (error.textContent === PAYER_MISSING) {
    // Auswahl rot umranden und ins Bild holen – auf dem Handy liegt sie oft weit über dem Knopf
    const pick = $('#cash-payer');
    pick.classList.add('is-missing');
    pick.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  if (error.textContent) return;

  const editing = state.expenses.find((x) => x.id === cashForm.editingId);
  const data = {
    title: $('#cash-what').value.trim().slice(0, 120),
    amountCents: r.amountCents,
    paidBy: cashForm.payer,
    sharedWith: r.ids,
    date: $('#cash-date').value || '',
  };
  // Erweiterungen: setzen, oder beim Bearbeiten ausdrücklich entfernen (null), sonst gar nicht mitschicken
  if (cashForm.kind === 'coffee' && !editing) data.kind = 'coffee';
  if (r.orig) data.orig = r.orig; else if (editing?.orig) data.orig = null;
  if (r.split) data.split = r.split; else if (editing?.split) data.split = null;
  if (cashForm.editingId && !editing) {
    // Inzwischen von jemand anderem gelöscht – nicht stillschweigend als neue Rechnung anlegen
    error.textContent = 'Diese Rechnung wurde inzwischen gelöscht. Bitte bei Bedarf neu erfassen.';
    cashForm.editingId = null;
    $('#cash-form-title').textContent = 'Rechnung erfassen';
    $('#cash-submit').textContent = 'Rechnung speichern';
    $('#cash-cancel').hidden = true;
    renderCashDialog();
    return;
  }
  if (editing) {
    const before = { ...editing };
    Object.assign(editing, data);
    resetCashForm();
    render();
    const ok = await persist((b) => b.updateExpense(editing.id, editing), 'Rechnung konnte nicht gespeichert werden');
    if (!ok) {
      for (const k of Object.keys(editing)) if (!(k in before)) delete editing[k];
      Object.assign(editing, before);
      render();
      return;
    }
    showCashSuccess(`✓ Änderung gespeichert: ${editing.title || 'Rechnung'} · ${enteredMoney(editing)}`);
    return;
  }
  const exp = { id: newId(), ...data, addedBy: memberName(), addedAt: Date.now() };
  state.expenses.push(exp);
  resetCashForm();
  render();
  const ok = await persist((b) => b.addExpenses([exp]), 'Rechnung konnte nicht gespeichert werden');
  if (!ok) { state.expenses = state.expenses.filter((x) => x.id !== exp.id); render(); return; }
  showCashSuccess(exp.kind === 'coffee'
    ? `✓ Kaffeerunde erfasst: ${enteredMoney(exp)} (bezahlt von ${personName(exp.paidBy)}) – nächste Runde: ${coffeeTurns(state.expenses, state.participants)[0]?.name || '–'}`
    : `✓ Rechnung erfasst: ${exp.title || 'Rechnung'} · ${enteredMoney(exp)} (bezahlt von ${personName(exp.paidBy)})`);
});

// --- Liste ---------------------------------------------------------------------------------

$('#place-list').addEventListener('click', async (e) => {
  const li = e.target.closest('.place');
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!li || !action) return;
  const id = li.dataset.id;
  const place = state.places.find((p) => p.id === id);
  if (!place) return;

  if (action === 'select') selectPlace(id);
  if (action === 'cash') openCashFor(place);
  if (action === 'gluten-free') {
    place.glutenFree = !place.glutenFree;
    render();
    const ok = await persist((b) => b.updatePlace(id, { glutenFree: place.glutenFree }), 'Glutenfrei konnte nicht gespeichert werden');
    if (!ok) {
      place.glutenFree = !place.glutenFree;
      render();
      return;
    }
    toast(place.glutenFree ? `„${place.name}“ als glutenfrei markiert` : `Glutenfrei-Markierung entfernt`);
  }
  if (action === 'starred') {
    place.starred = !place.starred;
    render();
    const ok = await persist((b) => b.updatePlace(id, { starred: place.starred }),
      'Favorit konnte nicht gespeichert werden (Spalte „starred“ in Supabase angelegt?)');
    if (!ok) {
      place.starred = !place.starred;
      render();
      return;
    }
    toast(place.starred ? `„${place.name}“ als Favorit markiert` : 'Favorit entfernt');
  }
  if (action === 'visited') {
    place.visited = !place.visited;
    render();
    const ok = await persist((b) => b.updatePlace(id, { visited: place.visited }),
      'Besucht konnte nicht gespeichert werden (Spalte „visited“ in Supabase angelegt?)');
    if (!ok) {
      place.visited = !place.visited;
      render();
      return;
    }
    toast(place.visited ? `„${place.name}“ als besucht markiert` : 'Markierung „besucht“ entfernt');
  }
  if (action === 'reserve') await saveReservation(place, { date: '', time: '' }, 'Als reserviert markiert');
  if (action === 'unreserve') await saveReservation(place, null, 'Reservierung entfernt');
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

// Auswahlfelder in der Liste (Kategorie, Reservierung) ändern den Eintrag direkt im Browser – beim nächsten
// Zeichnen daher neu aufbauen, auch wenn die Daten gleich geblieben sind (z. B. Speichern fehlgeschlagen)
for (const type of ['input', 'change']) {
  $('#place-list').addEventListener(type, (e) => {
    const entry = listItems.get(e.target.closest('.place')?.dataset.id);
    if (entry) entry.html = '';
  }, true);
}

$('#place-list').addEventListener('change', (e) => {
  const field = { 'res-date': 'date', 'res-time': 'time' }[e.target.dataset.action];
  if (field) {
    const place = state.places.find((p) => p.id === e.target.closest('.place').dataset.id);
    if (place) saveReservation(place, { ...place.reservation, [field]: e.target.value }, 'Reservierung gespeichert');
    return;
  }
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
  if (action === 'show-poi') {
    const btn = e.target.closest('[data-action]');
    if (!state.ui.visibleRoutes.includes(id)) {
      state.ui.visibleRoutes = [...state.ui.visibleRoutes, id];
      render();
    }
    if (isMobile() && sheetState() === 'full') setSheet('half');
    mapView.centerOn([Number(btn.dataset.lat), Number(btn.dataset.lng)], 16);
    return;
  }
  if (action === 'retry-pois') {
    poiLoading.delete(id);
    renderRoutes();
    return;
  }
  if (action === 'expand-route') {
    expandedRouteId = expandedRouteId === id ? null : id;
    editingRouteLink = null;
    renderRoutes();
    return;
  }
  if (action === 'show-route') {
    if (!state.ui.visibleRoutes.includes(id)) state.ui.visibleRoutes = [...state.ui.visibleRoutes, id];
    render();
    if (isMobile() && sheetState() === 'full') setSheet('half');
    mapView.fitToRoute(route);
    return;
  }
  if (action === 'edit-route-link' || action === 'edit-activity-link') {
    editingRouteLink = id;
    editingRouteField = action === 'edit-activity-link' ? 'activityUrl' : 'url';
    renderRoutes();
    $('.route-link-form input', $('#route-list'))?.focus();
  }
  if (action === 'ridden') {
    route.ridden = !route.ridden;
    render();
    const ok = await persist((b) => b.updateRoute(route.id, { ridden: route.ridden }),
      'Markierung konnte nicht gespeichert werden (Spalte „ridden“ in Supabase angelegt?)');
    if (!ok) { route.ridden = !route.ridden; render(); return; }
    toast(route.ridden ? `„${route.name}“ als gefahren markiert` : 'Markierung „gefahren“ entfernt');
  }
  if (action === 'show-stop') {
    const placeId = e.target.closest('[data-place]')?.dataset.place;
    if (!state.places.some((p) => p.id === placeId)) return;
    // Ausgefiltert? Dann Filter zurücksetzen, damit der Ort in Liste und Karte erscheint
    if (!lastVisible.some((p) => p.id === placeId)) resetFilters();
    selectPlace(placeId, { fly: true, scrollList: true });
  }
  if (action === 'cancel-route-link') {
    editingRouteLink = null;
    renderRoutes();
  }
  if (action === 'download-route') await downloadRouteGpx(route);
  if (action === 'delete-route') {
    if (!confirm(`Etappe „${route.name}“ entfernen?`)) return;
    state.routes = state.routes.filter((r) => r.id !== id);
    state.ui.visibleRoutes = state.ui.visibleRoutes.filter((rid) => rid !== id);
    render();
    persist((b) => b.deleteRoute(id), 'Etappe konnte nicht entfernt werden');
  }
});

$('#bike-speed')?.addEventListener('change', (e) => {
  writePref('bikeSpeed', Number(e.target.value));
  renderRoutes();
});
$('#ride-start')?.addEventListener('change', (e) => {
  if (!/^\d{2}:\d{2}$/.test(e.target.value)) return;
  writePref('rideStart', e.target.value);
  renderRoutes();
});

$('#route-list')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('.route-link-form');
  const route = state.routes.find((r) => r.id === form?.closest('[data-id]')?.dataset.id);
  if (!route) return;
  const field = form.dataset.field === 'activityUrl' ? 'activityUrl' : 'url';
  const url = normalizeLink($('input', form).value);
  if (url === null) return toast('Bitte einen gültigen Link eingeben (z. B. https://www.komoot.com/…)');
  const before = route[field] || '';
  route[field] = url;
  editingRouteLink = null;
  render();
  const ok = await persist((b) => b.updateRoute(route.id, { [field]: url }),
    field === 'activityUrl' ? 'Link konnte nicht gespeichert werden (Spalte „activity_url“ in Supabase angelegt?)' : 'Link konnte nicht gespeichert werden');
  if (!ok) {
    route[field] = before;
    render();
    return;
  }
  toast(url ? 'Link gespeichert' : 'Link entfernt');
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
  toast(`${added.length} Orte${restoredRoutes ? ` und ${restoredRoutes} Etappe(n)` : ''} wiederhergestellt`);
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
      ...(raw.glutenFree ? { glutenFree: true } : {}),
      ...(raw.visited ? { visited: true } : {}),
      ...(raw.starred ? { starred: true } : {}),
      ...(cleanReservation(raw.reservation) ? { reservation: cleanReservation(raw.reservation) } : {}),
      ...(sanitizeHours(raw.hours) ? { hours: sanitizeHours(raw.hours) } : {}),
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
  const ok = await persist((b) => b.addRoutes([route], { [route.id]: parsed.gpx }), 'Etappe konnte nicht gespeichert werden');
  if (!ok) {
    state.routes = state.routes.filter((r) => r.id !== route.id);
    render();
    return;
  }
  log(`${sourceLabel}: Etappe „${route.name}“ importiert (${formatKm(route.distanceKm)}${route.elevationGainM != null ? `, ${formatHm(route.elevationGainM)}` : ''}, standardmäßig ausgeblendet).`, 'ok');
  poisFor(route); // Trinkwasser und Velo-Werkstätten gleich laden und für alle speichern
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
        if (restoredRoutes) log(`${file.name}: ${restoredRoutes} Etappe(n) aus dem Backup übernommen.`, 'ok');
        if (!state.participants.length && b.participants?.length) {
          state.participants = sanitizeParticipants(b.participants);
          await persist((be) => be.saveParticipants(state.participants), 'Teilnehmende konnten nicht übernommen werden');
        }
        // Rechnungen nur übernehmen, wenn alle beteiligten Personen hier bekannt sind
        const people = new Set(state.participants.map((p) => p.id));
        const knownExp = new Set(state.expenses.map((x) => x.id));
        const newExp = (b.expenses || []).map(sanitizeExpense)
          .filter((x) => x && !knownExp.has(x.id) && people.has(x.paidBy) && x.sharedWith.every((id) => people.has(id)));
        if (newExp.length) {
          state.expenses.push(...newExp);
          await persist((be) => be.addExpenses(newExp), 'Rechnungen konnten nicht übernommen werden');
          log(`${file.name}: ${newExp.length} Rechnung(en) für die Ausgaben übernommen.`, 'ok');
        }
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

// Demo: Beispieldaten laden (nur im Speicher) und als Demo kennzeichnen
async function startDemo() {
  await refresh({ fit: true });
  if (!state.places.length) await loadSample({ quiet: true });
  renderShareState();
}

async function loadSample({ quiet = false } = {}) {
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
    if (!quiet) toast(added.length ? `${added.length} Beispielorte geladen` : 'Beispielorte sind schon da');
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
  let text = $('#links-input').value.trim();
  if (!text) return;
  // Kurzlinks aus der Google-Maps-App zuerst auflösen (Name + Koordinaten stehen erst im langen Link)
  if (hasShortMapsLinks(text)) {
    const btn = $('#btn-parse-links');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Löse Kurzlinks auf …';
    const r = await expandMapsLinks(text);
    btn.disabled = false;
    btn.textContent = label;
    text = r.text;
    if (r.failed) {
      log(`${r.failed} Kurzlink(s) konnten nicht aufgelöst werden – die Orte werden über den Namen gesucht. `
        + 'Ist die Supabase-Funktion „resolve-maps-link“ eingerichtet? (ANLEITUNG.md)', '');
    }
  }
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
// Hintergrund schliesst nur, wenn der Tipp dort auch begonnen hat – sonst schlösse eine Wischbewegung, die im
// Fenster beginnt und daneben endet, versehentlich das Fenster (samt halb ausgefülltem Formular).
$$('dialog').forEach((dlg) => {
  let downOnBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', (e) => {
    if (dlg.hasAttribute('data-locked')) return;
    if (e.target.closest('[data-close]') || (e.target === dlg && downOnBackdrop)) dlg.close();
  });
});
// Solange ein Fenster offen ist, die Seite dahinter festhalten (iOS reicht Wischbewegungen sonst weiter)
const syncDialogLock = () => document.documentElement.classList.toggle('dialog-open', !!document.querySelector('dialog[open]'));
new MutationObserver(syncDialogLock).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

// --- Teilen / gemeinsame Reise ------------------------------------------------------------

const shareDialog = $('#share-dialog');

function setSyncStatus(text) {
  const el = $('#sync-status');
  if (el) el.textContent = text;
}

function renderShareState() {
  renderOfflineBadge();
  const shared = backend.kind === 'shared';
  $('#btn-share').classList.toggle('is-shared', shared);
  $('#btn-share .btn-label').textContent = shared ? 'Gemeinsam' : 'Teilen';
  $('#demo-badge').hidden = backend.kind !== 'demo';
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
      <p class="hint" id="sync-status">${backend.offline
        ? `Ohne Verbindung – Stand von ${savedAtText(backend.savedAt)}. Sobald Netz da ist, wird abgeglichen.`
        : `Zuletzt abgeglichen um ${time} · aktualisiert sich alle 20 Sekunden`}</p>
      <div class="share-code">
        <p class="share-text">${backend.codeProtected
          ? '<strong>Mit Zugangscode geschützt:</strong> Der Link allein reicht nicht. Sag den Code deinen Mitreisenden getrennt vom Link, z. B. mündlich.'
          : '<strong>Kein Zugangscode:</strong> Wer den Link hat, sieht alles. Mit einem Code braucht man zusätzlich den Code.'}</p>
        <button id="btn-code-manage" class="btn-link" type="button">${backend.codeProtected ? 'Zugangscode ändern' : 'Zugangscode festlegen'}</button>
      </div>
      <button id="btn-leave-trip" class="btn-link muted" type="button">Reise auf diesem Gerät verlassen</button>`;
  } else {
    const remembered = rememberedTripKey();
    body.innerHTML = `
      <p class="share-text"><strong>Demo-Ansicht:</strong> Du siehst Beispieldaten. Änderungen werden nicht gespeichert und sind nach dem Neuladen wieder weg.</p>
      <p class="share-text">Für eure gemeinsame Reise brauchst du den Reise-Link und den Zugangscode von deinen Mitreisenden.</p>
      ${remembered && demoForced ? `<a class="btn btn-primary" href="${escapeHtml(shareUrl(remembered))}">Zurück zu eurer Reise</a>` : ''}`;
  }
}

function openShare() {
  $('#member-name').value = memberName();
  renderShareDialog();
  shareDialog.showModal();
}

// --- Ohne Netz ---------------------------------------------------------------------------------
// Der zuletzt geladene Stand der gemeinsamen Reise liegt im Browser (Cache Storage, nur auf diesem Gerät);
// startet die App ohne Netz, zeigt sie diesen Stand (OfflineBackend) und verbindet sich neu, sobald Netz da ist.
// Beim Verlassen der Reise oder Abmelden wird er gelöscht.
const OFFLINE_CACHE = 'llocs-offline';
const snapshotUrl = (key) => new URL(`offline-data/${key}.json`, location.href).href;

async function saveOfflineSnapshot(key, data) {
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const body = JSON.stringify({ savedAt: Date.now(), codeProtected: Boolean(backend.codeProtected), data });
    await cache.put(snapshotUrl(key), new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* kein Cache Storage (z. B. http) – dann eben ohne Offline-Stand */ }
}

async function loadOfflineSnapshot(key) {
  try {
    const res = await (await caches.open(OFFLINE_CACHE)).match(snapshotUrl(key));
    return res ? await res.json() : null;
  } catch {
    return null;
  }
}

async function clearOfflineSnapshots() {
  try { await caches.delete(OFFLINE_CACHE); } catch { /* nichts zu löschen */ }
}

// Merker für diese Sitzung (siehe offlineSession); true = gesetzt bzw. entfernt
function setOfflineSession(on) {
  try {
    if (on) sessionStorage.setItem(OFFLINE_MAP_FLAG, '1'); else sessionStorage.removeItem(OFFLINE_MAP_FLAG);
    return (sessionStorage.getItem(OFFLINE_MAP_FLAG) === '1') === on;
  } catch {
    return false;
  }
}

const savedAtText = (t) => (t
  ? new Date(t).toLocaleString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
  : 'unbekannt');

// Netz wieder da: echte Verbindung aufbauen und den aktuellen Stand holen. true = erledigt
let reconnecting = false;
async function reconnect() {
  if (reconnecting) return false;
  reconnecting = true;
  try {
    const live = await SharedBackend.connect(backend.key);
    switchTo(live);
    setOfflineSession(false); // beim nächsten Öffnen wieder die gewohnte Karte
    lastSignature = '';
    toast('Wieder online – die Reise ist auf dem neuesten Stand.');
    await refresh();
    return true;
  } catch (err) {
    if (err.code === 'CODE_REQUIRED') {
      showCodeLogin(backend.key, err.wrong);
      return true;
    }
    return false;
  } finally {
    reconnecting = false;
  }
}

function renderOfflineBadge() {
  const badge = $('#offline-badge');
  if (badge) badge.hidden = !backend.offline && navigator.onLine;
}
$('#offline-badge')?.addEventListener('click', () => {
  toast(backend.offline
    ? `Ohne Verbindung – du siehst den Stand von ${savedAtText(backend.savedAt)}. Anschauen geht, Ändern erst wieder mit Netz.`
    : 'Gerade keine Verbindung – Änderungen werden erst wieder gespeichert, wenn Netz da ist.', { sticky: true });
});

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
  if (!confirm('Reise auf diesem Gerät verlassen? Die gemeinsamen Orte bleiben erhalten – du kommst über den Link und den Zugangscode jederzeit zurück.')) return;
  forgetTripCode();
  clearOfflineSnapshots();
  switchTo(new DemoBackend(() => state));
  await startDemo();
  toast('Reise auf diesem Gerät verlassen – du siehst die Demo');
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
$('#demo-badge').addEventListener('click', openShare);
$('#share-body').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  if (id === 'btn-copy-link') copyLink();
  if (id === 'btn-leave-trip') leaveTrip();
  if (id === 'btn-code-manage') openCodeManage();
});

// --- Zugangscode ------------------------------------------------------------------------------
// Optionaler Schutz einer gemeinsamen Reise: Ist ein Code gesetzt, liefert die Datenbank nur mit dem
// richtigen Code Daten (geprüft in Supabase, siehe supabase/schema.sql). Die Abfrage lässt sich nicht
// wegklicken; nach dem richtigen Code merkt sich das Gerät ihn, bis man sich abmeldet.

const codeDialog = $('#code-dialog');
let codeTripKey = null;
let codeUnlocked = false; // erst nach dem richtigen Code darf die Abfrage zugehen
let codeAttempts = 0; // falsche Versuche seit dem Öffnen der Abfrage – macht jeden neuen Fehlversuch sichtbar
codeDialog.addEventListener('cancel', (e) => e.preventDefault()); // Esc schliesst die Abfrage nicht
// Manche Browser schliessen ein Fenster beim zweiten Esc trotzdem. Dann sofort wieder öffnen – sonst landet man
// ohne Code in der lokalen Ansicht und könnte dort versehentlich eine neue Reise starten.
const codeLocked = () => Boolean(codeTripKey) && !codeUnlocked;
const reopenCodeDialog = () => { if (codeLocked() && !codeDialog.open) codeDialog.showModal(); };
codeDialog.addEventListener('close', () => setTimeout(reopenCodeDialog, 0));
// Esc abfangen, bevor der Browser die Abfrage schliesst (die Sperre über „cancel“ greift nicht immer)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && codeLocked()) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
// Wächter: falls die Abfrage auf einem anderen Weg doch zugeht, sofort wieder öffnen
setInterval(reopenCodeDialog, 400);

function showCodeLogin(key, wrong = false) {
  codeTripKey = key;
  codeUnlocked = false;
  $('#demo-badge').hidden = true; // hinter der Code-Abfrage keine „Demo“ anzeigen
  codeAttempts = 0;
  $('#code-input').classList.remove('is-wrong');
  $$('dialog[open]').forEach((d) => { if (d !== codeDialog) d.close(); });
  $('#code-error').textContent = wrong ? 'Der Code auf diesem Gerät stimmt nicht (mehr) – bitte den aktuellen Code eingeben.' : '';
  $('#code-input').value = '';
  if (!codeDialog.open) codeDialog.showModal();
  setTimeout(() => $('#code-input').focus(), 60);
}

const toggleCodeVisible = (checkbox, inputs) => checkbox.addEventListener('change', () => {
  inputs.forEach((sel) => { $(sel).type = checkbox.checked ? 'text' : 'password'; });
});
toggleCodeVisible($('#code-show'), ['#code-input']);
$('#code-input').addEventListener('input', (e) => e.target.classList.remove('is-wrong'));

$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#code-input').value.trim();
  if (!code) return;
  if (!validTripCodeChars(code)) {
    $('#code-error').textContent = 'Der Code enthält Zeichen, die hier nicht gehen (z. B. Umlaute) – bitte genau so eingeben, wie er festgelegt wurde.';
    return;
  }
  const btn = $('#code-submit');
  const input = $('#code-input');
  // Alte Meldung sofort weg, damit sichtbar ist, dass dieser Versuch neu geprüft wird
  $('#code-error').textContent = '';
  input.classList.remove('is-wrong');
  btn.disabled = true;
  btn.textContent = 'Prüfe …';
  try {
    const shared = await SharedBackend.connect(codeTripKey, code);
    rememberTripCode(codeTripKey, code);
    switchTo(shared);
    codeUnlocked = true;
    codeDialog.close();
    if (!readPref('introHidden')) openIntro();
    lastSignature = '';
    await refresh({ fit: true });
  } catch (err) {
    if (err.code === 'CODE_REQUIRED') {
      codeAttempts++;
      $('#code-error').textContent = codeAttempts > 1 ? `Dieser Code stimmt nicht (${codeAttempts}. Versuch).` : 'Dieser Code stimmt nicht.';
      // Fenster kurz schütteln (Animation neu starten), Feld rot markieren und für den nächsten Versuch leeren
      const box = codeDialog.querySelector('.dialog-inner');
      box.classList.remove('is-shaking');
      void box.offsetWidth;
      box.classList.add('is-shaking');
      input.classList.add('is-wrong');
      input.value = '';
      navigator.vibrate?.(120);
    } else {
      $('#code-error').textContent = `Keine Verbindung: ${err.message}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Öffnen';
    input.focus();
  }
});

const codeManageDialog = $('#code-manage-dialog');
toggleCodeVisible($('#code-manage-show'), ['#code-new', '#code-repeat']);

function openCodeManage() {
  if (backend.kind !== 'shared') return;
  const on = Boolean(backend.codeProtected);
  $('#code-manage-status').textContent = on
    ? 'Diese Reise ist mit einem Zugangscode geschützt. Hier kannst du ihn ändern. Danach müssen alle anderen den neuen Code einmal eingeben.'
    : 'Noch kein Zugangscode: Wer den Reise-Link hat, sieht alles. Mit einem Code braucht man zusätzlich den Code – teile ihn getrennt vom Link.';
  $('#code-remove').hidden = true; // Code ist Pflicht – nur ändern, nicht entfernen
  $('#code-logout').hidden = !on;
  $('#code-save').textContent = on ? 'Code ändern' : 'Code speichern';
  $('#code-new').value = '';
  $('#code-repeat').value = '';
  $('#code-manage-error').textContent = '';
  codeManageDialog.showModal();
}

// Code in der Datenbank setzen (leer = entfernen), auf diesem Gerät merken und neu verbinden
async function applyTripCode(newCode) {
  await backend.setCode(newCode);
  if (newCode) rememberTripCode(backend.key, newCode); else forgetTripCode();
  switchTo(await SharedBackend.connect(backend.key, newCode));
  lastSignature = '';
  await refresh();
  renderShareDialog();
}

$('#code-manage-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#code-manage-error');
  const code = $('#code-new').value.trim();
  error.textContent = code.length < 6 ? 'Der Code braucht mindestens 6 Zeichen – z. B. ein Wort mit Zahl.'
    : code.length > 64 ? 'Der Code darf höchstens 64 Zeichen lang sein.'
    : !validTripCodeChars(code) ? 'Bitte nur Buchstaben ohne Umlaute (ae statt ä), Ziffern und einfache Satzzeichen verwenden.'
    : code !== $('#code-repeat').value.trim() ? 'Die beiden Eingaben stimmen nicht überein.'
    : '';
  if (error.textContent) return;
  const btn = $('#code-save');
  btn.disabled = true;
  try {
    await applyTripCode(code);
    codeManageDialog.close();
    toast('Zugangscode gespeichert – sag ihn deinen Mitreisenden, am besten nicht im selben Chat wie den Link.');
  } catch (err) {
    error.textContent = `Code konnte nicht gespeichert werden: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('#code-remove').addEventListener('click', async () => {
  if (!confirm('Zugangscode entfernen? Danach reicht wieder der Reise-Link allein.')) return;
  try {
    await applyTripCode('');
    codeManageDialog.close();
    toast('Zugangscode entfernt');
  } catch (err) {
    $('#code-manage-error').textContent = `Code konnte nicht entfernt werden: ${err.message}`;
  }
});

$('#code-logout').addEventListener('click', () => {
  if (!confirm('Auf diesem Gerät abmelden? Beim nächsten Öffnen wird der Zugangscode wieder abgefragt.')) return;
  forgetTripCode();
  clearOfflineSnapshots().finally(() => location.reload());
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

// Wallet-Link nur auf iPhone/iPad zeigen (iPadOS meldet sich als „Macintosh“ mit Touch)
const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
$('#menu-wallet').hidden = !isAppleMobile;

$('.menu-panel').addEventListener('click', async (e) => {
  const what = e.target.closest('[data-menu]')?.dataset.menu;
  if (!what) return;
  $('.menu').open = false;
  if (what === 'intro') openIntro();
  if (what === 'categories') {
    renderCategoryManager();
    categoryDialog.showModal();
  }
  if (what === 'backup') downloadBackup(state);
  if (what === 'fit') mapView.fitTo(lastVisible, state.airbnb);
  if (what === 'hours') loadOpeningHours();
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
// Standort klappt nicht: bei „verweigert“ Schritt-für-Schritt-Hilfe, sonst kurze Meldung
function locateProblem(kind, detail = '') {
  if (kind === 'denied') {
    const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
    // Technische Angabe für die Fehlersuche: Fehlermeldung des Geräts, Erlaubnis-Status, Art der Anzeige
    const tech = $('#locate-tech');
    const show = (state) => {
      tech.textContent = `Technische Angabe: ${detail || 'keine Meldung'} · Erlaubnis: ${state} · ${standalone ? 'Home-Bildschirm-App' : 'Browser'} · ${location.protocol}`;
    };
    show('unbekannt');
    navigator.permissions?.query({ name: 'geolocation' }).then((p) => show(p.state)).catch(() => {});
    $('#locate-lead').textContent = standalone
      ? 'Dein iPhone hat den Standort für die App auf dem Home-Bildschirm blockiert. So gibst du ihn frei:'
      : 'Dein Browser hat den Standort für diese Seite blockiert. Auf dem iPhone gibst du ihn so frei:';
    $('#locate-dialog').showModal();
    return;
  }
  if (kind === 'heading-denied') {
    toast('Standort läuft – für die Blickrichtung „Bewegung und Ausrichtung“ erlauben: Seite neu laden und beim Fadenkreuz „Erlauben“ wählen.');
    return;
  }
  toast(kind === 'unsupported'
    ? 'Dieser Browser kann den Standort nicht bestimmen.'
    : 'Standort konnte gerade nicht bestimmt werden – am besten draussen oder mit WLAN eingeschaltet noch einmal versuchen.');
}
$('#locate-retry').addEventListener('click', () => {
  $('#locate-dialog').close();
  mapView.locate?.();
});

function toast(msg, { sticky = false } = {}) {
  const el = $('#toast');
  // Ist ein Fenster offen, liegt es über allem anderen – die Meldung dann in dieses Fenster hängen, sonst
  // erschiene sie unsichtbar dahinter
  const openDialog = [...document.querySelectorAll('dialog[open]')].pop();
  const host = openDialog || document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  // Lesezeit: mindestens gut 3 s, bei langen Texten länger (max. 9 s)
  if (!sticky) toastTimer = setTimeout(() => el.classList.remove('is-visible'), Math.min(9000, Math.max(3200, msg.length * 60)));
}

// --- Start ------------------------------------------------------------------------------------

async function boot() {
  try {
    render();
  } catch (err) {
    console.error(err);
  }
  const key = demoForced ? null : tripKeyFromUrl() || rememberedTripKey();
  if (key && sharingConfigured()) {
    try {
      switchTo(await SharedBackend.connect(key));
    } catch (err) {
      if (err.code === 'CODE_REQUIRED') showCodeLogin(key, err.wrong);
      else if (err.code === 'TRIP_UNKNOWN') {
        // Alter oder ausgedachter Link: vergessen und die Demo zeigen
        forgetTripKey();
        forgetTripCode();
        history.replaceState(null, '', location.pathname);
        toast('Dieser Reise-Link ist nicht gültig – du siehst die Demo.', { sticky: true });
      } else {
        // Kein Netz (oder Server nicht erreichbar): zuletzt gespeicherten Stand zeigen, falls vorhanden
        const snapshot = await loadOfflineSnapshot(key);
        if (snapshot?.data && mapVariant === 'google' && setOfflineSession(true)) {
          location.reload(); // einmal neu laden – dann mit OpenStreetMap (siehe offlineSession)
          return;
        }
        if (snapshot?.data) {
          switchTo(new OfflineBackend(key, snapshot));
          toast(`Ohne Verbindung – du siehst den Stand von ${savedAtText(snapshot.savedAt)}. Ändern geht wieder, sobald Netz da ist.`, { sticky: true });
        } else toast(`Gemeinsame Reise nicht erreichbar: ${err.message}`);
      }
    }
  }
  if (!codeDialog.open) {
    if (!readPref('introHidden')) openIntro();
    if (backend.kind === 'shared') await refresh({ fit: true });
    else await startDemo();
  }

  // Gemeinsame Reise: regelmäßig und beim Zurückkehren in die App abgleichen.
  setInterval(() => {
    if (backend.kind === 'shared' && document.visibilityState === 'visible') refresh();
  }, SYNC_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (backend.kind === 'shared' && document.visibilityState === 'visible') refresh();
  });
  // Netz zurück: neu verbinden bzw. abgleichen; Netz weg: Kennzeichen „Offline“ zeigen
  window.addEventListener('online', () => {
    renderOfflineBadge();
    if (backend.kind === 'shared') refresh();
  });
  window.addEventListener('offline', renderOfflineBadge);
  window.addEventListener('hashchange', () => {
    const next = tripKeyFromUrl();
    if ((next && next !== backend.key) || /(?:^#|&)demo\b/i.test(location.hash) !== demoForced) location.reload();
  });
}

// --- Willkommen -----------------------------------------------------------------------------
// Kurze Übersicht beim Öffnen der Seite; „Nicht mehr anzeigen“ merkt sich jedes Gerät selbst.
const introDialog = $('#intro-dialog');
function openIntro() {
  $('#intro-hide').checked = Boolean(readPref('introHidden'));
  introDialog.showModal();
}
introDialog.addEventListener('close', () => writePref('introHidden', $('#intro-hide').checked || null));
// Geöffnet wird es erst in boot(), sobald klar ist, ob die Reise einen Zugangscode verlangt – sonst blitzt es
// vor der Code-Abfrage kurz auf. Nach dem richtigen Code erscheint es dann (siehe Zugangscode).

// Welche Version läuft gerade? (Zahl aus index.html, von deploy.sh erhöht) – hilft zu erkennen,
// ob z. B. die App auf dem Home-Bildschirm noch einen alten Stand zeigt.
$('#app-version').textContent = `Version ${document.querySelector('link[href*="styles.css"]')?.href.match(/v=([\d.-]+)/)?.[1] || '–'}`;

boot();
window.addEventListener('resize', () => mapView.invalidate());

// Ohne Netz nutzbar: sw.js hält App-Dateien und gesehene OpenStreetMap-Kacheln vor (nur über https)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker:', err.message));
}
