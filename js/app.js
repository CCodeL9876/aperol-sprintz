import { DEFAULT_CATEGORIES, FALLBACK_CATEGORY, ROUTE_CATEGORY, routeColor } from './categories.js';
import { haversineKm, hasCoords, parseCoords, formatKm, geocode, formatReservation, routeUrl, homeRouteUrl } from './geo.js';
import { parseFile, parseGeoJSON, parseLinks, assignCategory, buildGpx, summarizeTrack, parseGpx } from './importers.js';
import { elevationProfile, profileHtml, bindProfile } from './profile.js';
import { loadUi, saveUi, readPref, writePref, downloadBackup, newId, newTripKey, loadLocalBackup, clearLocalBackup } from './store.js';
import { expandMapsLinks, hasShortMapsLinks,
  DemoBackend, SharedBackend, OfflineBackend, sharingConfigured, tripKeyFromUrl,
  rememberedTripKey, rememberTripKey, forgetTripKey, shareUrl, rememberTripCode, forgetTripCode, validTripCodeChars,
  rememberedAdminPin, rememberAdminPin,
} from './backend.js';
import { createMap, routeAttrs } from './map.js';
import { TRAVEL_MODES, computeRoute, navUrl } from './directions.js';
import { roadKm, loadRoadDistances } from './road-distance.js';
import { WIKI_CATEGORIES, cachedWiki, loadWiki } from './wiki.js';
import { GRADE_CLASSES, steepRuns, findClimbs, climbName } from './climbs.js';
import { sanitizeHours, hoursStale, openAt, hoursStatus } from './hours.js';
import { cachedPois, loadPois, sanitizePois, POI_TYPES } from './pois.js';
import { connectToHome, bikeRoute } from './home-loop.js';
import { FIXED_AIRBNB, GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_MAP_ID } from './config.js';
import { icon, categoryIcon, categoryStyle } from './icons.js';
import { formatEuro, formatChf, toRappen, toEuroCents, cachedRate, loadRate, parseAmount, parseShare, computeBalances, settle, splitCents, sharesOf, expenseTotal, isTransfer, sanitizeParticipants, sanitizeExpense } from './cash.js';

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
// Etappe planen: Wegpunkte [lat, lng] und die Abschnitte dazwischen (siehe „Etappe planen“ weiter unten)
const plan = { on: false, waypoints: [], segments: [], history: [], selected: null, source: null, noEle: false };
// Route zu einem Ort (Vorschau in der App, siehe „Route zu einem Ort“ weiter unten)
const dir = { on: false, to: null, name: '', home: false, destination: '', mode: 'drive', from: 'me', fromPos: null, seq: 0, cache: new Map() };
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
// Wer nutzt dieses Gerät? Teilnehmenden-ID je Reise, einmal pro Gerät gewählt („Wer bist du?“).
// Eine Person kann auf mehreren Geräten angemeldet sein – alle zeigen auf dieselbe ID.
const meKey = () => `me.${backend.key || backend.kind}`;
const me = () => state.participants.find((p) => p.id === readPref(meKey())) || null;
const memberName = () => me()?.name || '';

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
    if (plan.on) {
      addPlanPoint([latlng.lat, latlng.lng]);
      return true;
    }
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
  onMarkerClick: (id) => {
    const place = plan.on && state.places.find((p) => p.id === id);
    // eigener Ort als Wegpunkt; ein Café erscheint als Kaffee-Stopp (Tassen-Symbol)
    if (place && hasCoords(place)) return addPlanPoint(Object.assign([place.lat, place.lng], place.category === 'kaffee' ? { coffee: place.name } : {}));
    if (!plan.on) selectPlace(id, { fly: false, scrollList: true });
  },
  onLocateMessage: (kind, detail) => locateProblem(kind, detail),
  getInsets: mapInsets,
};

// Karte: immer Google Maps. OpenStreetMap (Leaflet) nur noch als stiller Ersatz – ohne API-Schlüssel in
// config.js, ohne Netz (Google lädt offline keine Karte, gesehene OSM-Kacheln hält sw.js vor) oder wenn Google
// scheitert (siehe createGoogleMapView). Selbst wählen lässt sich OSM nicht mehr.
// „Ohne Netz“ heisst: der Browser meldet offline, oder die App ist in dieser Sitzung schon auf den
// gespeicherten Stand ausgewichen (Handy mit Empfang, aber ohne Daten meldet sich oft trotzdem „online“).
const OFFLINE_MAP_FLAG = 'llocs.offlineMap';
const offlineSession = (() => { try { return sessionStorage.getItem(OFFLINE_MAP_FLAG) === '1'; } catch { return false; } })();
const mapVariant = GOOGLE_MAPS_API_KEY && navigator.onLine && !offlineSession ? 'google' : 'osm';

const mapView = mapVariant === 'google' ? createGoogleMapView($('#map')) : createMap($('#map'), mapOptions);
document.body.dataset.map = mapVariant; // Knöpfe auf der Karte sitzen je nach Karte anders (styles.css)

// Google lädt asynchron: bis dahin nimmt ein Platzhalter alle Aufrufe an, danach wird neu gezeichnet.
// Scheitert Google (Schlüssel, Netz, Zeitüberschreitung), übernimmt automatisch OpenStreetMap.
function createGoogleMapView(el) {
  let impl = null;
  const view = { map: { getZoom: () => impl?.map.getZoom() ?? 9 } };
  for (const k of ['setPlaces', 'setAirbnb', 'setActive', 'focusPlace', 'fitTo', 'setRoutes', 'fitToRoute', 'centerOn', 'setPois', 'setDraft', 'setCursor', 'setRouteLine', 'searchPlaces', 'openSearchResult', 'clearSearchMarker', 'locate', 'invalidate']) {
    view[k] = (...args) => impl?.[k](...args);
  }
  const ready = (m, shown) => {
    impl = m;
    view.map = m.map;
    // Knopfreihe (Satellit) einer gescheiterten Google-Karte entfernen
    if (shown === 'osm') $('#map').parentElement.querySelector('.gmap-tools')?.remove();
    document.body.dataset.map = shown;
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
      onNotice: (msg) => toast(msg),
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
  // Sichtbar macht es renderShareState – in der Demo bleibt das Feld ausgeblendet
  box.dataset.ready = '1';
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
  // Handy: zugeklappt nur die Lupe – aufgeklappt, solange das Feld aktiv ist oder Treffer offen sind
  // (die Darstellung gibt es nur unter 900 px, siehe .map-search.is-collapsed in styles.css)
  const syncCollapsed = () => box.classList.toggle('is-collapsed', document.activeElement !== input && list.hidden);
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
    syncCollapsed();
  };
  const row = (it, i, title, sub, iconHtml) => `<li role="option" id="msr-${i}" aria-selected="${i === active}">
      <button type="button" class="msr-item" data-i="${i}" tabindex="-1">${iconHtml}<span class="msr-text"><strong>${escapeHtml(title)}</strong>${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></button>
    </li>`;
  function draw(note = '') {
    const own = items.filter((it) => it.kind === 'own');
    const goo = items.filter((it) => it.kind === 'google');
    let html = '';
    if (own.length) {
      html += '<li class="msr-head" role="presentation">Unsere Orte</li>';
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
  input.addEventListener('focus', () => {
    syncCollapsed();
    if (items.length) draw();
  });
  input.addEventListener('blur', syncCollapsed);
  syncCollapsed();
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
  if (hoursLoading || backend.kind === 'demo') return;
  // Kostet Google-Kontingent für viele Orte auf einmal – nur der Admin (neue Orte aus der Google-Karte bringen
  // ihre Öffnungszeiten ohnehin mit). Nur in der App gesperrt: der Google-Schlüssel ist im Browser öffentlich.
  if (!canAdmin()) return toast('Öffnungszeiten laden kann nur der Admin.');
  if (backend.kind === 'shared' && state.hoursMissing) {
    return toast('Öffnungszeiten sind in der Datenbank noch nicht eingerichtet – bitte supabase/schema.sql im Supabase SQL Editor ausführen.', { sticky: true });
  }
  const todo = state.places.filter((p) => hasCoords(p) && !HOURS_SKIP.has(p.category) && hoursStale(p.hours));
  if (!todo.length) return toast('Die Öffnungszeiten sind bei allen Orten aktuell.');
  hoursLoading = true;
  let done = 0;
  let fromOsm = 0;
  let fromGoogle = 0;
  const save = async (p, hours) => {
    const place = state.places.find((x) => x.id === p.id);
    if (!place) return;
    const before = place.hours;
    place.hours = hours;
    const ok = await persist((b) => b.updatePlace(place.id, { hours }), 'Öffnungszeiten konnten nicht gespeichert werden');
    if (!ok) {
      place.hours = before;
      throw new Error('Speichern fehlgeschlagen');
    }
  };
  toast(`Öffnungszeiten werden geladen … 0 von ${todo.length}`, { sticky: true });
  try {
    // 1. Gratis aus OpenStreetMap (siehe osm-hours.js); fällt Overpass aus, übernimmt Google alles
    let osm = new Map();
    try {
      const { lookupOsmHours } = await import('./osm-hours.js');
      osm = await lookupOsmHours(todo);
    } catch (err) {
      console.warn('Öffnungszeiten aus OpenStreetMap:', err);
    }
    for (const [id, hours] of osm) {
      await save({ id }, hours);
      fromOsm++;
      done++;
    }
    const rest = todo.filter((p) => !osm.has(p.id));
    if (fromOsm) toast(`Öffnungszeiten werden geladen … ${done} von ${todo.length}`, { sticky: true });
    // 2. Nur die übrigen bei Google (kostet Kontingent)
    if (rest.length && GOOGLE_MAPS_API_KEY) {
      const { lookupHours } = await import('./map-google.js');
      await lookupHours(GOOGLE_MAPS_API_KEY, rest, async (p, hours) => {
        done++;
        if (hours.p) fromGoogle++;
        await save(p, hours);
        toast(`Öffnungszeiten werden geladen … ${done} von ${todo.length}`, { sticky: true });
      });
    }
    const found = fromOsm + fromGoogle;
    const src = [fromOsm && `${fromOsm} aus OpenStreetMap`, fromGoogle && `${fromGoogle} von Google`].filter(Boolean).join(', ');
    toast(`Öffnungszeiten geladen: bei ${found} von ${todo.length} Orten gefunden${src ? ` (${src})` : ''}.`
      + `${rest.length && !GOOGLE_MAPS_API_KEY ? ' Für die übrigen fehlt der Google-Schlüssel in js/config.js.' : ''}`
      + `${found ? ' Filter „Jetzt offen“ steht oben bei den Arten.' : ''}`);
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
// schwebend, nur von unten). Höhen: „hidden“ (ganz eingeklappt, nur der runde Listen-Knopf unten links),
// „half“ (Standard), „full“ (ganze Liste).
// Die Höhen selbst stehen in styles.css (--sheet-h); hier wird nur umgeschaltet.

const isMobile = () => window.matchMedia('(max-width: 899px)').matches;
const SHEET_STATES = ['hidden', 'half', 'full'];
const SHEET_HIDDEN_PX = 66; // Platz für die Knopfzeile unten (runder Listen-Knopf, Cafés | Bars | Essen | Satellit)

function sheetState() {
  return $('.layout').dataset.sheet || 'half';
}

// Absicherung für Browser ohne „overflow: clip“: der Bereich unter der Kopfzeile darf nie verrutschen
$('.layout').addEventListener('scroll', (e) => {
  if (e.target.scrollTop || e.target.scrollLeft) e.target.scrollTo(0, 0);
}, { passive: true });

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
  // Beim Planen bzw. bei der Routen-Vorschau liegt oben das Feld dafür (Boxen-Reihe ist dann ausgeblendet)
  const overlay = plan.on ? $('#plan-panel') : dir.on ? $('#dir-panel') : null;
  if (overlay && !overlay.hidden) top = Math.max(0, overlay.getBoundingClientRect().bottom - m.top);
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
  // Eingeklappt: ein Tipp auf den runden Listen-Knopf holt das Blatt auf halbe Höhe zurück
  $('#sheet-open').addEventListener('click', () => setSheet('half'));
  // Suchen braucht Platz für Tastatur und Treffer
  $('#search').addEventListener('focus', () => { if (isMobile()) setSheet('full'); });
})();

// --- Abschnitte zuklappen ---------------------------------------------------------
// „Unsere Orte“ und „Espresso-Etappen“ lassen sich über die Überschrift zuklappen; jedes Gerät merkt sich das.
// Wird etwas aus einem zugeklappten Abschnitt gebraucht (Marker angetippt, Suche …), klappt er von selbst auf.
const SECTIONS = { places: '#places-section', routes: '#routes-section' };
const collapsedSections = () => {
  const v = readPref('collapsedSections');
  return v && typeof v === 'object' ? v : {};
};
function setSectionCollapsed(key, collapsed, { remember = true } = {}) {
  const sec = $(SECTIONS[key]);
  if (!sec) return; // altes index.html im Cache
  sec.classList.toggle('is-collapsed', collapsed);
  $(`.list-toggle[data-section="${key}"]`)?.setAttribute('aria-expanded', String(!collapsed));
  if (remember) writePref('collapsedSections', { ...collapsedSections(), [key]: collapsed });
}
const expandSection = (key) => {
  if ($(SECTIONS[key])?.classList.contains('is-collapsed')) setSectionCollapsed(key, false);
};
for (const [key, collapsed] of Object.entries(collapsedSections())) {
  if (SECTIONS[key]) setSectionCollapsed(key, Boolean(collapsed), { remember: false });
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.list-toggle');
  if (btn) setSectionCollapsed(btn.dataset.section, btn.getAttribute('aria-expanded') === 'true');
});
$('#search').addEventListener('input', () => expandSection('places'));

// --- Ableitungen -------------------------------------------------------------------

// Entfernung zum Airbnb: Strecke mit dem Auto (siehe road-distance.js); solange die fehlt oder ohne
// Google-Schlüssel die Luftlinie, dann mit distanceAir markiert
function placesWithDistance() {
  const a = state.airbnb;
  return state.places.map((p) => {
    const cached = WIKI_CATEGORIES.has(p.category) ? cachedWiki(p) : undefined;
    // null = nichts gefunden; noch nicht gefragt: Zwischenstand der Suche ('loading' / 'error')
    const wiki = cached !== undefined || !WIKI_CATEGORIES.has(p.category) ? cached : wikiStatus.get(p.id);
    if (!a || !hasCoords(p)) return { ...p, wiki, distance: null };
    const road = roadKm(a, p);
    return Number.isFinite(road)
      ? { ...p, wiki, distance: road, distanceAir: false }
      : { ...p, wiki, distance: haversineKm(a.lat, a.lng, p.lat, p.lng), distanceAir: true };
  });
}

// Wikipedia-Text für den geöffneten Ort aus „Kultur & Orte“ nachladen (siehe wiki.js). wikiStatus je Ort:
// 'loading' während der Suche, 'error' wenn Wikipedia nicht erreichbar war (beim nächsten Öffnen neuer Versuch)
const wikiStatus = new Map();
// retry: Ort wurde (neu) geöffnet – dann auch nach einem Fehler wieder versuchen, sonst nicht (Endlosschleife)
async function ensureWiki({ retry = false } = {}) {
  const p = activeId && state.places.find((x) => x.id === activeId);
  if (!p || !WIKI_CATEGORIES.has(p.category) || !hasCoords(p)) return;
  const status = wikiStatus.get(p.id);
  if (cachedWiki(p) !== undefined || status === 'loading' || (status === 'error' && !retry)) return;
  if (!navigator.onLine) { wikiStatus.set(p.id, 'error'); return; }
  wikiStatus.set(p.id, 'loading');
  render();
  try {
    await loadWiki(p);
    wikiStatus.delete(p.id);
  } catch (err) {
    console.warn('Wikipedia:', err);
    wikiStatus.set(p.id, 'error');
  }
  render();
}

// Fehlende Strecken im Hintergrund holen und danach neu zeichnen. Schlägt es fehl (kein Netz, Routes API
// nicht freigeschaltet), bleibt es bis zum nächsten Laden der Seite bei der Luftlinie.
let roadLoading = false;
let roadFailed = false;
async function ensureRoadDistances() {
  if (roadLoading || roadFailed || !GOOGLE_MAPS_API_KEY || !navigator.onLine || !state.airbnb) return;
  roadLoading = true;
  try {
    if (await loadRoadDistances(GOOGLE_MAPS_API_KEY, state.airbnb, state.places)) render();
  } catch (err) {
    roadFailed = true;
    console.warn('Strecken-Distanz:', err.detail || err.message);
    if (err.setup) toast(`${err.message} – bis dahin Luftlinie.`);
  } finally {
    roadLoading = false;
  }
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
  renderMe();
  ensureMe();
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
  ensureRoadDistances();
  ensureWiki();
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
  if (a) {
    route.href = homeRouteUrl(a);
    Object.assign(route.dataset, { routeLat: a.lat, routeLng: a.lng, routeName: 'Unterkunft', routeHome: '1' });
  }
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
  expandSection('routes');
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

// Höhenprofil gespeicherter Etappen: aus der GPX-Datei in voller Auflösung (beim Import bzw. Planen gespeichert,
// siehe downloadRouteGpx) – erst beim Aufklappen geladen. Wert je Etappe: Profil, 'loading' oder 'none'.
const routeProfiles = new Map();
async function loadRouteProfile(r) {
  routeProfiles.set(r.id, 'loading');
  // Erst nach dem laufenden Zeichnen der Liste weitermachen – liegt die Datei schon im Speicher, würde das
  // Ergebnis sonst sofort gezeichnet und gleich wieder von „wird geladen …“ überschrieben
  await Promise.resolve();
  let profile = null;
  try {
    let gpx = gpxCache.get(r.id);
    if (!gpx && backend.routeGpx) gpx = await backend.routeGpx(r.id);
    if (gpx) {
      gpxCache.set(r.id, gpx);
      const track = parseGpx(gpx).track;
      profile = elevationProfile(track);
      if (profile) routeClimbs.set(r.id, findClimbs(track));
    }
  } catch (err) {
    console.warn('Höhenprofil nicht ladbar:', err.message);
  }
  routeProfiles.set(r.id, profile || 'none');
  renderRoutes();
}
function routeProfileHtml(r) {
  const p = routeProfiles.get(r.id);
  if (p === undefined) loadRouteProfile(r);
  if (p === undefined || p === 'loading') return '<span class="muted">wird geladen …</span>';
  if (p === 'none') return '<span class="muted">nicht verfügbar – die GPX-Datei dieser Etappe hat keine Höhenangaben</span>';
  return profileHtml(p, { height: 90, key: r.id }) + climbsHtml(routeClimbs.get(r.id) || [], r.id, { legend: true });
}

function renderRoutes() {
  const list = $('#route-list');
  if (!list) return; // Null-sicher: altes index.html im Cache
  const empty = $('#route-empty');
  const visible = new Set(state.ui.visibleRoutes);
  if (empty) empty.hidden = state.routes.length > 0;
  const speedBox = $('#route-speed');
  if (speedBox) {
    speedBox.hidden = !state.routes.length;
    $('#bike-speed').value = String(bikeSpeed());
    const startInput = $('#ride-start');
    if (startInput && document.activeElement !== startInput) startInput.value = rideStart();
  }
  if (expandedRouteId && !state.routes.some((r) => r.id === expandedRouteId)) expandedRouteId = null;
  // Handy: sobald eine Etappe auf der Karte eingeschaltet (oder aufgeklappt) ist, die Boxen „Unterkunft“ und
  // „Ausgaben“ über der Karte ausblenden (styles.css)
  document.body.classList.toggle('is-route-open', Boolean(expandedRouteId) || state.ui.visibleRoutes.length > 0);
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
        <div class="route-detail route-detail-elev"><span class="route-detail-label">Höhenprofil</span>${routeProfileHtml(r)}</div>
        <div class="route-detail"><span class="route-detail-label">Wasser & Velo</span>
          <span class="route-stop-list">${poiDetailHtml(r)}</span></div>
        <div class="route-detail"><span class="route-detail-label">Links</span>
          ${editing ? linkForm(r, editing) : `<span class="route-links">${tour}${ridden ? `<span class="route-meta-sep">·</span>${ridden}` : ''}</span>`}</div>
        <div class="route-detail-actions">
          <button type="button" class="btn btn-small" data-action="show-route">${icon('route', { size: 14, stroke: 2 })}Auf der Karte zeigen</button>
          <button type="button" class="route-action" data-action="edit-route" aria-label="Etappe „${escapeHtml(r.name)}“ bearbeiten" title="Bearbeiten (als Kopie)">${icon('pencil', { size: 15, stroke: 1.9 })}</button>
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
  // Höhenprofile der aufgeklappten Etappe: Fadenkreuz mit Punkt auf der Karte
  mapView.setCursor(null);
  list.querySelectorAll('.elev[data-key]').forEach((el) => {
    const p = routeProfiles.get(el.dataset.key);
    if (p && typeof p === 'object') bindProfile(el, p, profileHover);
  });
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
  updateChipFade();
}

// Handy: Chip-Reihe scrollt seitlich – ein Verlauf am rechten Rand zeigt, dass noch mehr kommt
function updateChipFade() {
  const box = $('#category-chips');
  box.classList.toggle('has-more', box.scrollLeft + box.clientWidth < box.scrollWidth - 4);
}
$('#category-chips').addEventListener('scroll', updateChipFade, { passive: true });
addEventListener('resize', updateChipFade);

// Glutenfrei-Schalter nur dort, wo es ums Essen geht (bereits markierte Orte zeigen ihn immer);
// sonst hält ein leerer Platz Stern und Entfernung bündig mit den anderen Zeilen
const GF_CATEGORIES = new Set(['kaffee', 'restaurant', 'bar']);

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
    ? `<strong>Unsere Orte</strong> ${visible.length === total ? total : `${visible.length} von ${total}`}${state.ui.reserved ? ' · nach Termin' : ''}`
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

// Wikipedia-Kasten im aufgeklappten Ort: Bild, Anfang des Artikels, Link und Quelle (Lizenz CC BY-SA)
function wikiHtml(w) {
  // Zwischenstände: suchen, nichts gefunden (null), nicht erreichbar
  if (w === 'loading') return '<p class="place-wiki-note">Wikipedia wird gesucht …</p>';
  if (w === 'error') return '<p class="place-wiki-note">Wikipedia gerade nicht erreichbar – beim nächsten Öffnen neuer Versuch.</p>';
  if (w === null) return '<p class="place-wiki-note">Kein passender Wikipedia-Artikel in der Nähe gefunden.</p>';
  if (!w) return '';
  const text = w.extract.length > 320 ? `${w.extract.slice(0, 320).replace(/\s+\S*$/, '')} …` : w.extract;
  return `<div class="place-wiki">
        ${w.img ? `<img class="place-wiki-img" src="${escapeHtml(w.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <p class="place-wiki-text">${escapeHtml(text)}</p>
        <a class="place-wiki-link" href="${escapeHtml(safeHttpUrl(w.url) || '#')}" target="_blank" rel="noopener">Mehr auf Wikipedia</a>
        <small class="place-wiki-src">Text und Bild: Wikipedia (CC BY-SA)</small>
      </div>`;
}

// Ein Eintrag der Ortsliste als HTML (Vergleich mit dem bisherigen Stand in patchList)
function placeItemHtml(p, i, cats) {
  const c = catOf(p.category);
  const dist = p.distance != null
    ? `<span class="place-dist${p.distanceAir ? ' is-air' : ''}" title="${p.distanceAir ? 'Luftlinie vom Airbnb' : 'Strecke mit dem Auto vom Airbnb'}">${p.distanceAir ? '≈ ' : ''}${distanceHtml(p.distance)}</span>`
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
    ${gf || GF_CATEGORIES.has(p.category)
      ? `<button type="button" class="gf-toggle" data-action="gluten-free" aria-pressed="${gf}" aria-label="Glutenfrei" title="${gf ? 'Glutenfrei – antippen zum Entfernen' : 'Als glutenfrei markieren'}">${icon('wheat-off', { size: 17, stroke: 1.9 })}<span class="gf-label">GF</span></button>`
      : '<span class="gf-spacer" aria-hidden="true"></span>'}
    </div>
    <div class="place-details">
      ${p.note ? `<p class="place-note">${escapeHtml(p.note)}</p>` : ''}
      ${wikiHtml(p.wiki)}
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
        <a class="chip-btn route-btn" href="${escapeHtml(routeUrl(p))}" target="_blank" rel="noopener" title="Route anzeigen"${routeAttrs(p)}>${icon('navigation', { size: 14, stroke: 2.2 })}Route</a>
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
  ensureWiki({ retry: true });
  if (isMobile() && activeId) {
    // Ort aus der Liste gewählt: Karte muss sichtbar sein. Marker angetippt: Eintrag muss sichtbar sein.
    if (fly && sheetState() === 'full') setSheet('half');
  }
  if (activeId && fly) mapView.focusPlace(activeId);
  if (activeId && scrollList) {
    expandSection('places');
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
  if (on && plan.on) endPlan(); // Airbnb setzen beendet eine laufende Planung
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
const cashForm = { editingId: null, payer: null, shared: new Set(), currency: 'EUR', splitMode: 'equal', splitValues: {} };
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
  cashForm.payer = me()?.id || null; // vorausgewählt: wer dieses Gerät nutzt („Wer bist du?“) – änderbar
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
  const paidBtn = (t) => `<button type="button" class="cash-paid-btn" data-settle-from="${escapeHtml(t.from)}" data-settle-to="${escapeHtml(t.to)}" data-settle-cents="${t.cents}"${extrasBlocked() ? ' disabled title="Datenbank noch nicht erweitert (siehe Hinweis oben)"' : ' title="Als bezahlt markieren"'}>bezahlt?</button>`;
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
          ${transfers.length ? ' Nach der Überweisung auf „bezahlt?“ tippen – der Saldo wird für alle angepasst.' : ''}</p>
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
        <span class="cash-item-title">${escapeHtml(e.title || 'Rechnung')}</span>
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

// Rechnung für einen Ort (aus der Liste oder dem Detailfenster auf der Karte): „Wofür“ ist vorausgefüllt
function openCashFor(place) {
  openCash();
  $('#cash-what').value = String(place.name || '').slice(0, 120);
}

// Person zur Reise hinzufügen (Ausgaben und „Wer bist du?“). Rückgabe: die Person oder null bei Fehler.
async function addParticipant(name) {
  const person = { id: newId(), name };
  state.participants.push(person);
  // Neue Person beim gerade offenen Formular gleich mit auswählen
  if (!cashForm.editingId) cashForm.shared.add(person.id);
  render();
  let merged = null;
  const ok = await persist(async (b) => { merged = await b.changeParticipants({ add: person }); }, 'Person konnte nicht gespeichert werden');
  if (!ok) {
    state.participants = state.participants.filter((p) => p.id !== person.id);
    render();
    return null;
  }
  // Gemeinsame Reise: Liste vom Server übernehmen (enthält auch gleichzeitig hinzugefügte Personen)
  if (merged) {
    state.participants = sanitizeParticipants(merged);
    render();
    // Hat der Server eine gleichnamige Person behalten (gleichzeitig auf einem anderen Gerät angelegt), diese nehmen
    return state.participants.find((p) => p.id === person.id) || state.participants.find((p) => norm(p.name) === norm(name)) || null;
  }
  return person;
}

$('#cash-person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#cash-person-input');
  const name = input.value.trim().slice(0, 30);
  if (!name) return;
  if (cashBlocked()) return toast('Die Ausgaben sind in der Datenbank noch nicht eingerichtet (siehe Hinweis oben).');
  if (state.participants.some((p) => norm(p.name) === norm(name))) return toast(`„${name}“ ist schon eingetragen`);
  input.value = '';
  await addParticipant(name);
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
    const self = person.id === me()?.id;
    if (!confirm(self
      ? `Du entfernst dich selbst („${person.name}“) – danach wählst du eine Person neu oder trägst dich neu ein. Fortfahren?`
      : `„${person.name}“ aus den Ausgaben entfernen?`)) return;
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
    ensureMe(); // sich selbst entfernt → gleich neu wählen
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
    : (r.orig || r.split) && extrasBlocked() ? 'Franken und ungleiche Aufteilung gehen erst, wenn die Datenbank erweitert ist (siehe Hinweis oben).'
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
  showCashSuccess(`✓ Rechnung erfasst: ${exp.title || 'Rechnung'} · ${enteredMoney(exp)} (bezahlt von ${personName(exp.paidBy)})`);
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
  if (action === 'edit-route') await editRoute(route);
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
  selectImportTab('links'); // Start immer auf „Link einfügen“ – der häufigste Weg, Orte hinzuzufügen
  $('#btn-sample').hidden = state.places.length > 0;
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
  const override = $('[data-panel="file"]').hidden ? 'auto' : $('#import-category').value || 'auto';
  const { added, dupes } = await addPlaces(raws, override);
  const missing = added.filter((p) => !hasCoords(p));
  log(
    `${sourceLabel}: ${added.length} neue Orte${dupes ? `, ${dupes} bereits vorhanden` : ''}${missing.length ? `, ${missing.length} ohne Standort` : ''}.`,
    added.length ? 'ok' : '',
  );
  return { added, missing };
}

// Start und Ziel ans Airbnb anschließen (Checkbox im Import-Fenster, Standard: an) – siehe home-loop.js
async function homeLoop(parsed, sourceLabel) {
  if (!$('#import-home').checked) return parsed;
  if (!state.airbnb) {
    log(`${sourceLabel}: Kein Airbnb gesetzt – Start und Ziel bleiben, wie sie in der Datei stehen.`);
    return parsed;
  }
  log(`${sourceLabel}: Schließe Start und Ziel ans Airbnb an …`);
  const { route, notes, error } = await connectToHome(parsed, state.airbnb, routeMode());
  if (error) log(`${sourceLabel}: ${error}.`, 'error');
  if (notes.length) log(`${sourceLabel}: ${notes.join(', ')}.`, 'ok');
  else if (!error) log(`${sourceLabel}: Start und Ziel liegen schon beim Airbnb.`);
  return route;
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
    return null;
  }
  log(`${sourceLabel}: Etappe „${route.name}“ importiert (${formatKm(route.distanceKm)}${route.elevationGainM != null ? `, ${formatHm(route.elevationGainM)}` : ''}, standardmäßig ausgeblendet).`, 'ok');
  poisFor(route); // Trinkwasser und Velo-Werkstätten gleich laden und für alle speichern
  return route;
}

async function handleFiles(files) {
  const allAdded = [];
  const allMissing = [];
  for (const file of files) {
    try {
      const text = await file.text();
      const result = parseFile(file.name, text);
      if (result.kind === 'gpx') {
        await addRoute(await homeLoop(result.route, file.name), file.name);
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
  // Optionen (Kategorie, GPX, Standortsuche) stehen im Datei-Reiter: Links werden automatisch zugeordnet,
  // die Kategorie lässt sich danach in der Liste pro Ort ändern.
  $$('.tab-panel', importDialog).forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// „Start und Ziel beim Airbnb“ pro Gerät merken
$('#import-home').checked = readPref('gpxHome') !== false;
$('#import-home').addEventListener('change', (e) => writePref('gpxHome', e.target.checked));

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
  const mapSearch = $('#map-search');
  if (mapSearch.dataset.ready) mapSearch.hidden = backend.kind === 'demo';
  // Öffnungszeiten laden kostet Google-Kontingent – in der Demo ausgegraut
  $('[data-menu="hours"]').disabled = backend.kind === 'demo';
  // Google-Orte nach Art (Schalter auf der Karte) ebenso – in der Demo ausgeblendet
  document.body.classList.toggle('is-demo', backend.kind === 'demo');
  if (shareDialog.open) renderShareDialog();
}

function renderShareDialog() {
  const body = $('#share-body');
  // In der Demo wird nichts gespeichert – das Namensfeld wäre dort sinnlos
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
        ${canAdmin() || adminState === 'none'
          ? `<button id="btn-code-manage" class="btn-link" type="button">${backend.codeProtected ? 'Zugangscode ändern' : 'Zugangscode festlegen'}</button>`
          : '<p class="hint">Den Zugangscode ändert der Admin.</p>'}
      </div>
      ${adminHtml()}
      <p class="share-text share-me">${me() ? `Du bist <strong>${escapeHtml(me().name)}</strong>` : 'Noch nicht angemeldet'} · <button id="btn-who" class="btn-link" type="button">${me() ? 'wechseln' : 'Wer bist du?'}</button></p>
      <button id="btn-leave-trip" class="btn-link muted" type="button">Reise auf diesem Gerät verlassen</button>`;
  } else {
    const remembered = rememberedTripKey();
    body.innerHTML = `
      <p class="share-text"><strong>Demo-Ansicht:</strong> Du siehst Beispieldaten. Änderungen werden nicht gespeichert und sind nach dem Neuladen wieder weg.</p>      ${remembered && demoForced ? `<a class="btn btn-primary" href="${escapeHtml(shareUrl(remembered))}">Zurück zu eurer Reise</a>` : ''}`;
  }
}

function openShare() {
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
  checkAdmin();
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
  if (id === 'btn-admin-login') openAdmin('login');
  if (id === 'btn-admin-set') openAdmin('set');
  if (id === 'btn-admin-change') openAdmin('change');
  if (id === 'btn-admin-logout') {
    if (!confirm('Admin auf diesem Gerät abmelden? Mit der Admin-PIN kannst du dich jederzeit wieder anmelden.')) return;
    rememberAdminPin(backend.key, '');
    checkAdmin();
  }
  if (id === 'btn-who') {
    shareDialog.close();
    askWho();
  }
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
    lastSignature = '';
    await refresh({ fit: true });
    welcome();
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
  await backend.setCode(newCode, rememberedAdminPin(backend.key));
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

// --- Route zu einem Ort ----------------------------------------------------------------------
// „Route“ bei einem Ort (Liste, Kartenfenster, Unterkunft) zeigt die Strecke auf der Google-Karte – mit Dauer und
// Distanz, für Auto, Velo, zu Fuß oder ÖV, ab eigenem Standort oder dem Airbnb (siehe directions.js).
// „Navigieren“ öffnet dann Google Maps. Ohne Google-Karte (OSM-Ersatz) bleibt es beim Link zu Google Maps.
const inAppRouting = () => document.body.dataset.map === 'google' && Boolean(GOOGLE_MAPS_API_KEY);
const savedTravelMode = () => (TRAVEL_MODES[readPref('travelMode')] ? readPref('travelMode') : 'drive');

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-route-lat]');
  if (!a || !inAppRouting() || plan.on) return;
  e.preventDefault();
  let destination = '';
  try { destination = new URL(a.getAttribute('href'), location.href).searchParams.get('destination') || ''; } catch { /* nur Koordinaten */ }
  openDir({ to: [Number(a.dataset.routeLat), Number(a.dataset.routeLng)], name: a.dataset.routeName || 'Ziel', home: a.dataset.routeHome === '1', destination });
});

function openDir({ to, name, home, destination }) {
  Object.assign(dir, { on: true, to, name, home, destination, mode: savedTravelMode() });
  // Start: zur Unterkunft immer ab dem eigenen Standort, sonst wie zuletzt gewählt (ohne Airbnb: Standort)
  dir.from = home || !state.airbnb ? 'me' : readPref('routeFrom') === 'home' ? 'home' : 'me';
  $('.menu').open = false;
  $('#dir-panel').hidden = false;
  document.body.classList.add('is-routing');
  if (isMobile()) setSheet('hidden');
  requestAnimationFrame(() => mapView.invalidate());
  computeDir();
}

function closeDir() {
  dir.on = false;
  dir.seq++;
  $('#dir-panel').hidden = true;
  document.body.classList.remove('is-routing');
  mapView.setRouteLine(null);
  requestAnimationFrame(() => mapView.invalidate());
  if (isMobile() && sheetState() === 'hidden') setSheet('half');
}

// Eigener Standort (einmal pro Berechnung; bis 1 Minute alt ist in Ordnung)
function myPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('dieses Gerät kennt keinen Standort'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      (err) => reject(new Error(err.code === 1 ? 'keine Erlaubnis für den Standort' : 'Standort nicht ermittelbar')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  });
}

function formatTravelTime(seconds) {
  const min = Math.max(1, Math.round(seconds / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

async function computeDir() {
  const seq = ++dir.seq;
  renderDir('Berechne …');
  let from;
  if (dir.from === 'home' && state.airbnb) {
    from = [state.airbnb.lat, state.airbnb.lng];
  } else {
    try {
      from = await myPosition();
    } catch (err) {
      if (seq !== dir.seq) return;
      // Ohne Standort ab dem Airbnb (außer die Route führt zum Airbnb)
      if (state.airbnb && !dir.home) {
        dir.from = 'home';
        toast(`${err.message[0].toUpperCase()}${err.message.slice(1)} – Route ab dem Airbnb.`);
        return computeDir();
      }
      mapView.setRouteLine(null);
      return renderDir(`Kein Start: ${err.message}`, true);
    }
  }
  if (seq !== dir.seq) return;
  dir.fromPos = from;
  // Bereits berechnete Strecken merken (jede Google-Abfrage zählt zum Kontingent)
  const key = [from.map((v) => v.toFixed(3)), dir.to.map((v) => v.toFixed(5)), dir.mode].join('|');
  try {
    const r = dir.cache.get(key) || await computeRoute(GOOGLE_MAPS_API_KEY, from, dir.to, dir.mode);
    dir.cache.set(key, r);
    if (seq !== dir.seq || !dir.on) return;
    mapView.setRouteLine(r.points);
    let { durationS, distanceM } = r;
    let extra = '';
    if (dir.mode === 'bike') {
      // Velo: Distanz, Höhenmeter und Fahrzeit wie bei den Etappen (eigenes Tempo, Steigungen eingerechnet)
      const sum = summarizeTrack('', r.track);
      distanceM = sum.distanceKm * 1000;
      const hours = rideHours(sum);
      durationS = hours ? hours * 3600 : null;
      extra = formatHm(sum.elevationGainM);
    }
    renderDir([durationS ? formatTravelTime(durationS) : '', distanceM != null ? formatKm(distanceM / 1000) : '', extra].filter(Boolean).join(' · '));
  } catch (err) {
    if (seq !== dir.seq) return;
    mapView.setRouteLine(null);
    if (err.setup) console.warn('Routes API:', err.detail);
    renderDir(err.setup
      ? 'Routen in der App sind noch nicht eingerichtet – „Navigieren“ öffnet Google Maps.'
      : `Keine Route: ${err.name === 'TimeoutError' ? 'keine Antwort' : err.message}`, true);
  }
}

function renderDir(text, isError = false) {
  $('#dir-title').textContent = dir.home ? 'Route zur Unterkunft' : `Route zu ${dir.name}`;
  const stats = $('#dir-stats');
  stats.textContent = text;
  stats.classList.toggle('is-hint', isError || text === 'Berechne …');
  for (const b of $$('[data-dir-mode]')) b.setAttribute('aria-pressed', String(b.dataset.dirMode === dir.mode));
  for (const b of $$('[data-dir-from]')) b.setAttribute('aria-pressed', String(b.dataset.dirFrom === dir.from));
  // Start wählbar nur, wenn es ein Airbnb gibt und die Route nicht ohnehin dorthin führt
  $('#dir-from').hidden = dir.home || !state.airbnb;
  const from = dir.from === 'home' && state.airbnb ? [state.airbnb.lat, state.airbnb.lng] : null;
  $('#dir-nav').href = navUrl({ from, to: dir.to, mode: dir.mode, destination: dir.destination });
}

$('#dir-close').innerHTML = icon('close', { size: 18, stroke: 2.2 });
$('#dir-close').addEventListener('click', closeDir);
$('#dir-panel').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-dir-mode]')?.dataset.dirMode;
  const from = e.target.closest('[data-dir-from]')?.dataset.dirFrom;
  if (mode && mode !== dir.mode) {
    dir.mode = mode;
    writePref('travelMode', mode);
    computeDir();
  }
  if (from && from !== dir.from) {
    dir.from = from;
    writePref('routeFrom', from);
    computeDir();
  }
});

// --- Etappe planen ----------------------------------------------------------------------------
// Wegpunkte auf der Karte antippen (auch eigene Orte oder eine eingeblendete Etappe); der Rennrad-Routenplaner
// (BRouter, siehe home-loop.js) verbindet je zwei Punkte. Start ist das Airbnb, falls gesetzt.
// Gespeichert wird wie eine importierte GPX-Etappe – Kaffee-Stopps, Trinkwasser und GPX-Download inklusive.
// plan.segments[i] ist der Weg von waypoints[i] zu waypoints[i + 1]:
// { points: [[lat, lng]], track: [[lat, lng, ele]] | null, pending, error, orig }
// orig: Abschnitt unverändert aus einer gespeicherten Etappe (wird beim Wechsel Schnell/Ruhig nicht neu berechnet).
// Wegpunkte lassen sich ziehen (nur die beiden Abschnitte daneben werden neu berechnet), antippen (dann
// „Entfernen“) und auf der Linie einfügen. plan.history: frühere Stände für „Rückgängig“.
// Bearbeiten einer Etappe (editRoute): Wegpunkte alle EDIT_STEP_KM, gespeichert wird eine Kopie (plan.source).

const EDIT_STEP_KM = 5;

function startPlan() {
  if (pickMode) setPickMode(false);
  if (dir.on) closeDir();
  plan.on = true;
  plan.waypoints = state.airbnb ? [[state.airbnb.lat, state.airbnb.lng]] : [];
  plan.segments = [];
  plan.history = [];
  plan.selected = null;
  plan.source = null;
  plan.noEle = false;
  $('#plan-name').value = '';
  $('#plan-panel').hidden = false;
  $('#map').classList.add('is-picking');
  // Mehr Platz für die Karte: Seitenleiste bzw. Kopfzeile und Knöpfe ausblenden (siehe .is-planning in styles.css)
  document.body.classList.add('is-planning');
  requestAnimationFrame(() => mapView.invalidate());
  if (isMobile()) {
    // Karte freimachen wie beim Setzen des Airbnb
    setSheet('hidden');
    $$('.panel-row details[open]').forEach((d) => { d.open = false; });
  }
  if (state.airbnb) mapView.centerOn([state.airbnb.lat, state.airbnb.lng], Math.max(mapView.map.getZoom(), 11));
  renderPlan();
}

function endPlan() {
  plan.on = false;
  plan.waypoints = [];
  plan.segments = [];
  plan.history = [];
  plan.selected = null;
  plan.source = null;
  $('#plan-panel').hidden = true;
  setPlanModeInfo(false);
  closePlanPop();
  plan.alt = null;
  renderPlanProfile(null);
  $('#map').classList.remove('is-picking');
  document.body.classList.remove('is-planning');
  requestAnimationFrame(() => mapView.invalidate());
  mapView.setDraft(null);
  if (isMobile() && sheetState() === 'hidden') setSheet('half');
}

function cancelPlan() {
  const changed = plan.source ? plan.history.length > 0 : plan.segments.length > 0;
  if (changed && !confirm(plan.source ? 'Bearbeitung verwerfen? Die Änderungen gehen verloren.' : 'Planung verwerfen? Die gesetzten Wegpunkte gehen verloren.')) return;
  endPlan();
}

// Streckenwahl „Schnell | Ruhig“ (jedes Gerät merkt sich seine)
const routeMode = () => (readPref('routeMode') === 'quiet' ? 'quiet' : 'fast');

// Abschnitt von „from“ nach „to“ berechnen lassen; bis dahin gestrichelte Luftlinie
function planSegment(from, to) {
  const seg = { points: [from, to], track: null, pending: true, error: false, orig: false };
  bikeRoute(from, to, routeMode())
    .then((track) => {
      seg.track = track;
      seg.points = track.map(([lat, lng]) => [lat, lng]);
    })
    .catch((err) => {
      seg.error = true;
      // Nur melden, wenn der Abschnitt noch zur Planung gehört (nicht schon rückgängig gemacht)
      if (plan.segments.includes(seg)) {
        toast(`Keine Rennrad-Strecke zu diesem Punkt gefunden (${err.name === 'TimeoutError' ? 'Routenplaner antwortet nicht' : err.message}) – „Rückgängig“ und einen anderen Punkt wählen.`);
      }
    })
    .finally(() => {
      seg.pending = false;
      if (plan.on) renderPlan();
    });
  return seg;
}

// Stand vor einer Änderung merken (für „Rückgängig“)
function planSnapshot() {
  if (planPop.kind === 'compare') closePlanPop();
  plan.history.push({ waypoints: plan.waypoints.slice(), segments: plan.segments.slice(), selected: plan.selected });
  if (plan.history.length > 100) plan.history.shift();
}

function addPlanPoint(to) {
  planSnapshot();
  const from = plan.waypoints.at(-1);
  plan.waypoints.push(to);
  if (from) plan.segments.push(planSegment(from, to));
  plan.selected = null;
  renderPlan();
}

// Wegpunkt i verschoben: nur die Abschnitte davor und danach neu berechnen
function movePlanPoint(i, to) {
  if (samePoint(plan.waypoints[i], to)) return renderPlan();
  planSnapshot();
  plan.waypoints[i] = to;
  if (i > 0) plan.segments[i - 1] = planSegment(plan.waypoints[i - 1], to);
  if (i < plan.waypoints.length - 1) plan.segments[i] = planSegment(to, plan.waypoints[i + 1]);
  plan.selected = i;
  renderPlan();
}

// Wegpunkt antippen: auswählen (dann „Entfernen“ möglich), nochmals antippen hebt die Auswahl auf
function pickPlanPoint(i) {
  plan.selected = plan.selected === i ? null : i;
  renderPlan();
}

// Tipp auf die Linie: Zwischenpunkt an der nächsten Stelle des Abschnitts. Der Abschnitt wird dort nur geteilt,
// nicht neu berechnet – die Strecke bleibt gleich, bis der neue Punkt verschoben wird.
function insertPlanPoint(si, at) {
  const seg = plan.segments[si];
  if (!seg?.track || seg.track.length < 3) return;
  let best = 1;
  let bestD = Infinity;
  for (let k = 1; k < seg.track.length - 1; k++) {
    const d = haversineKm(at[0], at[1], seg.track[k][0], seg.track[k][1]);
    if (d < bestD) { bestD = d; best = k; }
  }
  planSnapshot();
  const part = (track) => ({ points: track.map(([lat, lng]) => [lat, lng]), track, pending: false, error: false, orig: seg.orig });
  const p = seg.track[best];
  plan.segments.splice(si, 1, part(seg.track.slice(0, best + 1)), part(seg.track.slice(best)));
  plan.waypoints.splice(si + 1, 0, [p[0], p[1]]);
  plan.selected = si + 1;
  renderPlan();
}

// Gewählten Wegpunkt entfernen: die Nachbarn werden direkt verbunden (Start/Ziel: Abschnitt fällt weg)
function removePlanPoint() {
  const i = plan.selected;
  const n = plan.waypoints.length;
  if (i == null || n <= 2) return;
  planSnapshot();
  if (i === 0) {
    plan.waypoints.shift();
    plan.segments.shift();
  } else if (i === n - 1) {
    plan.waypoints.pop();
    plan.segments.pop();
  } else {
    plan.segments.splice(i - 1, 2, planSegment(plan.waypoints[i - 1], plan.waypoints[i + 1]));
    plan.waypoints.splice(i, 1);
  }
  plan.selected = null;
  renderPlan();
}

// Richtung umdrehen (z. B. wegen des Windes) – Abschnitte bleiben, nur rückwärts
function reversePlan() {
  if (plan.segments.length === 0 || plan.segments.some((s) => s.pending)) return;
  planSnapshot();
  plan.waypoints = plan.waypoints.slice().reverse();
  plan.segments = plan.segments.slice().reverse().map((s) => ({
    ...s,
    points: s.points.slice().reverse(),
    track: s.track ? s.track.slice().reverse() : null,
  }));
  plan.selected = null;
  renderPlan();
}

// Streckenwahl gewechselt: selbst berechnete Abschnitte mit dem neuen Profil neu berechnen
// (unveränderte Abschnitte einer bearbeiteten Etappe bleiben wie sie sind)
function setRouteMode(mode) {
  if (mode === routeMode()) return;
  writePref('routeMode', mode);
  if (plan.segments.some((s) => !s.orig)) planSnapshot();
  plan.segments = plan.segments.map((s, i) => (s.orig ? s : planSegment(plan.waypoints[i], plan.waypoints[i + 1])));
  renderPlan();
}

function undoPlanPoint() {
  const prev = plan.history.pop();
  if (!prev) return;
  plan.waypoints = prev.waypoints;
  plan.segments = prev.segments;
  plan.selected = prev.selected;
  renderPlan();
}

// Gespeicherte Etappe bearbeiten: volle Strecke (aus der GPX-Datei, sonst die gespeicherte Linie ohne Höhen)
// in Abschnitte von EDIT_STEP_KM teilen. Gespeichert wird eine Kopie, das Original bleibt.
async function editRoute(route) {
  let track = null;
  try {
    let gpx = gpxCache.get(route.id);
    if (!gpx && backend.routeGpx) gpx = await backend.routeGpx(route.id);
    if (gpx) {
      gpxCache.set(route.id, gpx);
      track = parseGpx(gpx).track;
    }
  } catch (err) {
    console.warn('GPX zum Bearbeiten nicht ladbar:', err.message);
  }
  const noEle = !track?.some((p) => Number.isFinite(p[2]));
  if (!track?.length) track = (route.points || []).map(([lat, lng]) => [lat, lng, null]);
  if (track.length < 2) return toast('Diese Etappe hat zu wenige Punkte zum Bearbeiten.');
  startPlan();
  plan.source = route;
  plan.noEle = noEle;
  // Wegpunkte alle EDIT_STEP_KM; ein Rest unter 1 km hängt am letzten Abschnitt
  const cut = [0];
  let km = 0;
  let next = EDIT_STEP_KM;
  for (let k = 1; k < track.length; k++) {
    km += haversineKm(track[k - 1][0], track[k - 1][1], track[k][0], track[k][1]);
    if (km >= next) {
      cut.push(k);
      next = km + EDIT_STEP_KM;
    }
  }
  if (km - (next - EDIT_STEP_KM) < 1 && cut.length > 1) cut.pop();
  if (cut.at(-1) !== track.length - 1) cut.push(track.length - 1);
  plan.waypoints = cut.map((k) => [track[k][0], track[k][1]]);
  plan.segments = cut.slice(1).map((k, j) => {
    const part = track.slice(cut[j], k + 1);
    return { points: part.map(([lat, lng]) => [lat, lng]), track: part, pending: false, error: false, orig: true };
  });
  $('#plan-name').value = `${route.name} (geändert)`.slice(0, 120);
  renderPlan();
  requestAnimationFrame(() => mapView.fitToRoute(route)); // erst wenn das Planer-Feld seine Höhe hat
  toast('Punkte ziehen · Linie antippen = neuer Punkt · Punkt + Papierkorb = weg. Gespeichert wird eine Kopie.');
}

const samePoint = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

// Ganze Strecke in voller Auflösung, oder null, solange ein Abschnitt fehlt oder noch berechnet wird
function planTrack() {
  if (!plan.segments.length || plan.segments.some((s) => !s.track)) return null;
  const track = plan.segments.flatMap((s, i) => (i ? s.track.slice(1) : s.track));
  // Original ohne Höhen: auch neue Abschnitte ohne Höhen, sonst wären die Höhenmeter nur halb gezählt
  return plan.noEle ? track.map(([lat, lng]) => [lat, lng, null]) : track;
}

const planEdit = { onMove: movePlanPoint, onPick: pickPlanPoint, onInsert: insertPlanPoint };

function renderPlan() {
  const track = planTrack();
  // steile Stücke farbig über der Planungslinie (siehe climbs.js)
  mapView.setDraft({ waypoints: plan.waypoints, segments: plan.segments, selected: plan.selected, edit: planEdit, steep: track ? steepRuns(track) : [], alt: plan.alt });
  const pending = plan.segments.some((s) => s.pending);
  const failed = plan.segments.some((s) => s.error);
  // Anstiege: während ein Abschnitt berechnet wird, bleiben die bisherigen stehen
  if (track) planClimbs = findClimbs(track);
  else if (!plan.segments.length) planClimbs = [];
  renderPlanExtras(track, pending);
  const stats = $('#plan-stats');
  let text = '';
  if (track) {
    const sum = summarizeTrack('', track);
    const hours = rideHours(sum);
    // Teile nicht mitten drin umbrechen („ca. 1 / h 35“), nur zwischen den Teilen
    text = [formatKm(sum.distanceKm), formatHm(sum.elevationGainM), hours ? formatDuration(hours) : ''].filter(Boolean)
      .map((t) => `<span class="nowrap">${escapeHtml(t)}</span>`).join(' · ');
    renderPlanProfile(elevationProfile(track));
  } else if (plan.segments.length) {
    text = failed ? 'Abschnitt fehlt – Rückgängig' : 'Berechne …';
  }
  // Ohne Strecke steht hier der Hinweis (gedämpft) – spart eine eigene Zeile
  stats.classList.toggle('is-hint', !text);
  stats.innerHTML = text || (plan.waypoints.length ? 'Punkte auf die Karte tippen' : 'Start auf die Karte tippen');
  $('#plan-undo').disabled = !plan.history.length;
  $('#plan-remove').hidden = plan.selected == null || plan.waypoints.length <= 2;
  $('#plan-reverse').disabled = !plan.segments.length || pending;
  const loop = $('#plan-loop');
  const loopLabel = state.airbnb ? 'Zurück zum Airbnb' : 'Zurück zum Start';
  loop.title = loopLabel;
  loop.setAttribute('aria-label', loopLabel);
  loop.disabled = plan.waypoints.length < 2 || samePoint(plan.waypoints.at(-1), plan.waypoints[0]);
  $('#plan-name').hidden = $('#plan-save').hidden = $('#plan-save-row').hidden = !plan.segments.length;
  $('#plan-save').disabled = !track || pending || failed;
  for (const b of $$('#plan-route-mode [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === routeMode()));
  // Während ein Abschnitt berechnet wird, bleibt das bisherige Profil stehen; ohne Strecke weg
  if (!plan.segments.length) renderPlanProfile(null);
}

// Höhenprofil im Planer (Knopf mit Kurve schaltet es ab – jedes Gerät merkt sich das)
const showPlanProfile = () => readPref('planProfile') !== false;
let planProfile = null;
let planClimbs = []; // Anstiege der Planung – als Knöpfe in der Zeile unter dem Profil (renderPlanExtras)
function renderPlanProfile(profile) {
  planProfile = profile;
  const box = $('#plan-profile');
  $('#plan-elev').setAttribute('aria-pressed', String(showPlanProfile()));
  box.hidden = !profile || !showPlanProfile();
  mapView.setCursor(null);
  if (box.hidden) { box.innerHTML = ''; return; }
  box.innerHTML = profileHtml(profile, { height: isMobile() ? 44 : 56 }); // Handy: flacher, mehr Karte
  bindProfile(box.firstElementChild, profile, profileHover);
}

// Anstiege als antippbare Zeile (Planer und Etappen-Details): Name, Länge, Durchschnitt, Höhenmeter.
// Antippen zeigt das Stück auf der Karte. src: 'plan' oder die ID der Etappe.
function climbsHtml(climbs, src, { legend = false } = {}) {
  const pct = (v) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
  const items = climbs.map((c, i) => `<button type="button" class="climb" data-climb="${i}" data-climb-src="${escapeHtml(src)}" title="Steilster halber Kilometer: ${pct(c.maxPct)}">
      ${icon('mountain', { size: 13, stroke: 2.2 })}<strong>${escapeHtml(climbName(c, state.places))}</strong>
      <span>${formatKm(c.km)} · ${pct(c.avgPct)} · ${Math.round(c.gainM)} Hm</span></button>`).join('');
  const key = legend ? `<span class="climb-legend">${GRADE_CLASSES.slice().reverse().map((g) => `<i style="--g:${g.color}"></i>${g.label}`).join(' ')}</span>` : '';
  if (!items && !key) return '';
  return `<div class="climbs">${items || (legend ? '<span class="muted">Keine nennenswerten Anstiege.</span>' : '')}${key}</div>`;
}
const routeClimbs = new Map(); // Etappen-ID → Anstiege (aus der GPX-Datei, siehe loadRouteProfile)
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-climb]');
  if (!b) return;
  const list = b.dataset.climbSrc === 'plan' ? planClimbs : routeClimbs.get(b.dataset.climbSrc) || [];
  const c = list[Number(b.dataset.climb)];
  if (!c) return;
  if (isMobile() && !plan.on && sheetState() === 'full') setSheet('half');
  mapView.fitToRoute({ points: c.points });
});
const profileHover = (p) => mapView.setCursor(p ? [p.lat, p.lng] : null);

async function savePlan() {
  const track = planTrack();
  if (!track) return;
  const name = $('#plan-name').value.trim().slice(0, 300)
    || (plan.source ? `${plan.source.name} (geändert)` : `Etappe vom ${new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' })}`);
  const btn = $('#plan-save');
  btn.disabled = true;
  const route = await addRoute(summarizeTrack(name, track), plan.source ? 'Bearbeitet' : 'Geplant');
  if (!route) {
    renderPlan(); // Speichern fehlgeschlagen (Meldung kam schon) – Planung bleibt offen
    return;
  }
  endPlan();
  if (!state.ui.visibleRoutes.includes(route.id)) state.ui.visibleRoutes = [...state.ui.visibleRoutes, route.id];
  render();
  mapView.fitToRoute(route);
  toast(`Etappe „${route.name}“ gespeichert (${formatKm(route.distanceKm)}) – sie steht unter „Espresso-Etappen“.`);
}

$('#plan-elev').innerHTML = icon('trending-up', { size: 18, stroke: 2 });
$('#plan-elev').addEventListener('click', () => {
  writePref('planProfile', !showPlanProfile());
  renderPlanProfile(planProfile);
});
$('#plan-undo').innerHTML = icon('undo', { size: 18, stroke: 2 });
$('#plan-loop').innerHTML = icon('home', { size: 18, stroke: 2 });
$('#plan-cancel').innerHTML = icon('close', { size: 18, stroke: 2.2 });
$('#btn-plan').addEventListener('click', () => (plan.on ? cancelPlan() : startPlan()));
// Handy: derselbe Start als Knopf auf der Karte (in der Liste liegt „Etappe planen“ weit unten)
$('#map-plan').innerHTML = icon('route', { size: 20, stroke: 2.2 });
$('#map-plan').addEventListener('click', () => { if (!plan.on) startPlan(); });
$('#plan-undo').addEventListener('click', undoPlanPoint);
$('#plan-remove').innerHTML = icon('trash', { size: 18, stroke: 2 });
$('#plan-remove').addEventListener('click', removePlanPoint);
$('#plan-reverse').innerHTML = icon('swap', { size: 18, stroke: 2 });
$('#plan-reverse').addEventListener('click', reversePlan);
$('#plan-loop').addEventListener('click', () => {
  if (plan.waypoints.length) addPlanPoint(plan.waypoints[0]);
});
$('#plan-cancel').addEventListener('click', cancelPlan);
// ⓘ neben „Schnell | Ruhig“: Erklärung als Sprechblase unter dem Planer, Spitze auf das ⓘ.
// Schliesst bei nochmaligem Tipp, bei einem Tipp daneben und mit dem Ende der Planung.
// Sprechblase unter dem Planer so schieben, dass ihre Spitze auf den Knopf zeigt
function placePop(pop, btn) {
  const panel = $('#plan-panel').getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const center = b.left + b.width / 2 - panel.left;
  const left = Math.max(0, Math.min(center - pop.offsetWidth / 2, panel.width - pop.offsetWidth));
  pop.style.setProperty('--pop-x', `${left}px`);
  pop.style.setProperty('--tip-x', `${center - left}px`);
}
function setPlanModeInfo(open) {
  const btn = $('#plan-mode-info-btn');
  const pop = $('#plan-mode-info');
  btn.setAttribute('aria-expanded', String(open));
  pop.hidden = !open;
  if (open) { closePlanPop(); placePop(pop, btn); }
}
$('#plan-mode-info-btn').addEventListener('click', () => setPlanModeInfo($('#plan-mode-info').hidden));
document.addEventListener('pointerdown', (e) => {
  if (!$('#plan-mode-info').hidden && !e.target.closest('#plan-mode-info, #plan-mode-info-btn')) setPlanModeInfo(false);
  // Die Zusatz-Sprechblase bleibt beim Ziehen/Tippen auf der Karte offen (Kaffee-Stopp, Rundtour zeigen dort etwas);
  // zu geht sie über ihren Knopf, das ✕ oder das Ende der Planung
});

// --- Zusatz-Knöpfe im Planer: Kaffee-Stopp, Schnell/Ruhig vergleichen, Rundtour vorschlagen ------------------------
// Eine gemeinsame Sprechblase (#plan-pop); planPop.kind sagt, welche gerade offen ist.
const planPop = { kind: null };
function openPlanPop(kind, html, btn) {
  const pop = $('#plan-pop');
  setPlanModeInfo(false);
  planPop.kind = kind;
  pop.innerHTML = `<button type="button" class="plan-pop-close" data-pop="close" aria-label="Schliessen">${icon('close', { size: 16, stroke: 2.2 })}</button>${html}`;
  pop.hidden = false;
  for (const b of $$('#plan-extras [data-extra]')) b.setAttribute('aria-expanded', String(b.dataset.extra === kind));
  placePop(pop, btn);
}
function closePlanPop() {
  if (!planPop.kind) return;
  const wasCompare = planPop.kind === 'compare';
  planPop.kind = null;
  const pop = $('#plan-pop');
  pop.hidden = true;
  pop.innerHTML = '';
  for (const b of $$('#plan-extras [data-extra]')) b.setAttribute('aria-expanded', 'false');
  mapView.setCursor(null);
  if (wasCompare) plan.alt = null;
  if (plan.on) renderPlan(); // Knöpfe (z. B. „Rundtour“ nur am Anfang) und Vergleichslinie auffrischen
}

// Knöpfe je nach Stand: Rundtour nur am Anfang (nur Start gesetzt), sonst Kaffee-Stopp und Vergleich
function renderPlanExtras(track, pending) {
  const box = $('#plan-extras');
  const items = [];
  // Rundtour am Anfang – und solange ihre Sprechblase offen ist (Varianten nacheinander ansehen)
  if ((!plan.segments.length && plan.waypoints.length === 1) || planPop.kind === 'loop') {
    items.push(['loop', 'route', 'Rundtour vorschlagen']);
  }
  if (track && !pending) {
    items.push(['coffee', 'coffee', 'Kaffee-Stopp']);
    items.push(['compare', 'swap', 'Vergleichen']);
  }
  // Anstiege kurz: „⛰ 7,4 km · 5,8 %“ – voller Name im Tooltip, antippen zeigt sie auf der Karte
  const climbs = track ? planClimbs.map((c, i) => `<button type="button" class="climb" data-climb="${i}" data-climb-src="plan" title="${escapeHtml(climbName(c, state.places))}: ${Math.round(c.gainM)} Hm">${icon('mountain', { size: 13, stroke: 2.2 })}<span>${formatKm(c.km)} · ${c.avgPct.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %</span></button>`).join('') : '';
  box.hidden = !items.length && !climbs;
  const html = items.map(([k, ic, label]) => `<button type="button" class="plan-extra" data-extra="${k}" aria-expanded="${planPop.kind === k}">${icon(ic, { size: 14, stroke: 2.2 })}${label}</button>`).join('') + climbs;
  if (box.innerHTML !== html) box.innerHTML = html;
  // Knopf der offenen Sprechblase verschwunden (z. B. Strecke gelöscht): Sprechblase zu
  if (planPop.kind && !items.some(([k]) => k === planPop.kind)) closePlanPop();
}

$('#plan-extras').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-extra]');
  if (!btn) return;
  const kind = btn.dataset.extra;
  if (planPop.kind === kind) return closePlanPop();
  if (kind === 'coffee') openCoffeePop(btn);
  if (kind === 'compare') openComparePop(btn);
  if (kind === 'loop') openLoopPop(btn);
});
$('#plan-pop').addEventListener('click', (e) => {
  const t = e.target.closest('[data-pop]');
  if (!t) return;
  const a = t.dataset.pop;
  if (a === 'close') closePlanPop();
  if (a === 'coffee-add') addCoffeeStop(t.dataset.place);
  if (a === 'compare-take') takeCompare();
  if (a === 'loop-len') { loopOpts.km = Number(t.dataset.km); renderLoopPop(); }
  if (a === 'loop-dir') { loopOpts.dir = t.dataset.dir; renderLoopPop(); }
  if (a === 'loop-go') suggestLoops();
  if (a === 'loop-take') takeLoop(Number(t.dataset.i));
});

// Punkt bei km auf der Strecke: { point: [lat, lng], seg: Abschnitt-Index }
function planPointAt(km) {
  let sum = 0;
  for (let si = 0; si < plan.segments.length; si++) {
    const t = plan.segments[si].track || [];
    for (let k = 1; k < t.length; k++) {
      const d = haversineKm(t[k - 1][0], t[k - 1][1], t[k][0], t[k][1]);
      if (sum + d >= km) return { point: [t[k][0], t[k][1]], seg: si };
      sum += d;
    }
  }
  const last = plan.segments.at(-1)?.track?.at(-1);
  return last ? { point: [last[0], last[1]], seg: plan.segments.length - 1 } : null;
}

// --- Kaffee-Stopp: eigene Cafés nah an einer Stelle der Strecke als Wegpunkt einbauen
const COFFEE_MAX_KM = 5;
const coffee = { km: 0, total: 0 };
function openCoffeePop(btn) {
  const track = planTrack();
  if (!track) return;
  coffee.total = summarizeTrack('', track).distanceKm;
  coffee.km = Math.round(coffee.total / 2); // Vorschlag: Halbzeit
  openPlanPop('coffee', `<strong class="plan-mode-pop-title">Kaffee-Stopp</strong>
    <label class="coffee-km">bei km <output id="coffee-km-out">${coffee.km}</output>
      <input id="coffee-km" type="range" min="0" max="${Math.max(1, Math.round(coffee.total))}" step="1" value="${coffee.km}" aria-label="Stelle der Strecke in km">
    </label>
    <div id="coffee-list"></div>`, btn);
  $('#coffee-km').addEventListener('input', (e) => {
    coffee.km = Number(e.target.value);
    $('#coffee-km-out').textContent = coffee.km;
    renderCoffeeList();
  });
  renderCoffeeList();
}
function renderCoffeeList() {
  const at = planPointAt(coffee.km);
  const list = $('#coffee-list');
  if (!at || !list) return;
  mapView.setCursor(at.point); // die Stelle als Punkt auf der Karte
  const used = new Set(plan.waypoints.map((w) => `${w[0].toFixed(5)},${w[1].toFixed(5)}`));
  const cafes = state.places
    .filter((p) => p.category === 'kaffee' && hasCoords(p) && !used.has(`${p.lat.toFixed(5)},${p.lng.toFixed(5)}`))
    .map((p) => ({ p, d: haversineKm(at.point[0], at.point[1], p.lat, p.lng) }))
    .filter((x) => x.d <= COFFEE_MAX_KM)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
  list.innerHTML = cafes.length
    ? `<ul class="coffee-list">${cafes.map(({ p, d }) => `<li>
        <span><strong>${escapeHtml(p.name)}</strong><small>${formatKm(d)} von km ${coffee.km}${hoursStatus(p.hours) ? ` · ${escapeHtml(hoursStatus(p.hours).text)}` : ''}</small></span>
        <button type="button" class="btn btn-small" data-pop="coffee-add" data-place="${escapeHtml(p.id)}">Einbauen</button></li>`).join('')}</ul>`
    : `<p class="muted">Kein eigenes Café im Umkreis von ${COFFEE_MAX_KM} km. Mit „Cafés“ unten auf der Karte Google-Cafés zeigen und eines zu „Unsere Orte“ hinzufügen.</p>`;
}
function addCoffeeStop(placeId) {
  const p = state.places.find((x) => x.id === placeId);
  const at = planPointAt(coffee.km);
  if (!p || !at) return;
  planSnapshot();
  const si = at.seg;
  const stop = Object.assign([p.lat, p.lng], { coffee: p.name }); // als Kaffee-Stopp markiert (Tassen-Symbol)
  plan.segments.splice(si, 1, planSegment(plan.waypoints[si], stop), planSegment(stop, plan.waypoints[si + 1]));
  plan.waypoints.splice(si + 1, 0, stop);
  plan.selected = null;
  closePlanPop();
  renderPlan();
  toast(`☕ „${p.name}“ als Stopp eingebaut`);
}

// --- Vergleich: dieselben Wegpunkte mit dem anderen Profil (Schnell ↔ Ruhig), gestrichelt auf der Karte
const compare = { seq: 0, mode: null, segments: null };
function openComparePop(btn) {
  const other = routeMode() === 'quiet' ? 'fast' : 'quiet';
  compare.mode = other;
  compare.segments = null;
  const seq = ++compare.seq;
  openPlanPop('compare', `<strong class="plan-mode-pop-title">Schnell oder Ruhig?</strong><div id="compare-body"><p class="muted">Berechne „${other === 'quiet' ? 'Ruhig' : 'Schnell'}“ …</p></div>`, btn);
  const wps = plan.waypoints.slice();
  const segs = plan.segments.slice();
  Promise.all(segs.map((s, i) => (s.orig ? Promise.resolve(s.track) : bikeRoute(wps[i], wps[i + 1], other))))
    .then((tracks) => {
      if (seq !== compare.seq || planPop.kind !== 'compare') return;
      compare.segments = tracks.map((t, i) => (segs[i].orig ? segs[i] : { points: t.map(([lat, lng]) => [lat, lng]), track: t, pending: false, error: false, orig: false }));
      const alt = compare.segments.flatMap((s, i) => (i ? s.track.slice(1) : s.track));
      plan.alt = alt.map(([lat, lng]) => [lat, lng]);
      renderPlan();
      const row = (label, track, current) => {
        const sum = summarizeTrack('', plan.noEle ? track.map(([a, b]) => [a, b, null]) : track);
        const h = rideHours(sum);
        return `<li class="${current ? 'is-current' : ''}"><span><strong>${label}</strong>${current ? ' <small>(jetzt)</small>' : ' <small>(gestrichelt)</small>'}</span>
          <span>${[formatKm(sum.distanceKm), formatHm(sum.elevationGainM), h ? formatDuration(h) : ''].filter(Boolean).join(' · ')}</span></li>`;
      };
      const name = (m) => (m === 'quiet' ? 'Ruhig' : 'Schnell');
      $('#compare-body').innerHTML = `<ul class="compare-list">${row(name(routeMode()), planTrack(), true)}${row(name(other), alt, false)}</ul>
        <button type="button" class="btn btn-small" data-pop="compare-take">„${name(other)}“ nehmen</button>`;
    })
    .catch((err) => {
      if (seq !== compare.seq || planPop.kind !== 'compare') return;
      $('#compare-body').innerHTML = `<p class="muted">Vergleich nicht möglich (${escapeHtml(err.message)}).</p>`;
    });
}
function takeCompare() {
  if (!compare.segments) return;
  planSnapshot();
  writePref('routeMode', compare.mode);
  plan.segments = compare.segments;
  closePlanPop();
  renderPlan();
}

// --- Rundtour auf Wunsch-Länge ab dem Start: Dreieck Start → A → B → Start, BRouter verbindet; bis zu 3 Varianten
const loopOpts = { km: 80, dir: '' };
const LOOP_DIRS = [['', 'Egal'], ['0', 'N'], ['45', 'NO'], ['90', 'O'], ['135', 'SO'], ['180', 'S'], ['225', 'SW'], ['270', 'W'], ['315', 'NW']];
const loopRun = { seq: 0, variants: [], busy: false };
function openLoopPop(btn) {
  loopRun.variants = [];
  openPlanPop('loop', '<div id="loop-body"></div>', btn);
  renderLoopPop();
  placePop($('#plan-pop'), btn);
}
function renderLoopPop() {
  const body = $('#loop-body');
  if (!body) return;
  body.innerHTML = `<strong class="plan-mode-pop-title">Rundtour vorschlagen</strong>
    <div class="loop-row"><span>Länge</span>${[40, 60, 80, 100, 120].map((k) => `<button type="button" class="loop-chip" data-pop="loop-len" data-km="${k}" aria-pressed="${loopOpts.km === k}">${k} km</button>`).join('')}</div>
    <div class="loop-row"><span>Richtung</span>${LOOP_DIRS.map(([d, l]) => `<button type="button" class="loop-chip" data-pop="loop-dir" data-dir="${d}" aria-pressed="${loopOpts.dir === d}">${l}</button>`).join('')}</div>
    <button type="button" class="btn btn-small" data-pop="loop-go"${loopRun.busy ? ' disabled' : ''}>${loopRun.busy ? 'Berechne …' : 'Vorschlagen'}</button>
    ${loopRun.variants.length ? `<ul class="compare-list loop-list">${loopRun.variants.map((v, i) => `<li><span><strong>Variante ${i + 1}</strong></span>
      <span>${formatKm(v.km)} · ${formatHm(v.hm)}</span><button type="button" class="btn btn-small" data-pop="loop-take" data-i="${i}">Zeigen</button></li>`).join('')}</ul>
      <p class="muted">„Zeigen“ übernimmt die Variante in den Planer – danach wie gewohnt anpassen und speichern.</p>` : ''}
    ${loopRun.note ? `<p class="muted">${escapeHtml(loopRun.note)}</p>` : ''}`;
}
// Punkt in d km Entfernung in Richtung bearing (Grad) von [lat, lng]
function offsetPoint([lat, lng], d, bearing) {
  const b = (bearing * Math.PI) / 180;
  return [lat + (d / 111.2) * Math.cos(b), lng + (d / (111.2 * Math.cos((lat * Math.PI) / 180))) * Math.sin(b)];
}
const trackKm = (t) => t.reduce((sum, p, i) => (i ? sum + haversineKm(t[i - 1][0], t[i - 1][1], p[0], p[1]) : 0), 0);
async function loopVariant(home, km, bearing, mode) {
  let d = km / (3 * 1.3); // gleichseitiges Dreieck, Strassen ca. 30 % länger als die Luftlinie
  let best = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let shrink = 1;
    let legs = null;
    // Liegt eine Ecke im Meer oder weitab jeder Strasse, findet BRouter nichts: Ecken näher an den Start rücken
    for (let tries = 0; tries < 3 && !legs; tries++, shrink *= 0.75) {
      const a = offsetPoint(home, d * shrink, bearing - 30);
      const b = offsetPoint(home, d * shrink, bearing + 30);
      try {
        const t1 = await bikeRoute(home, a, mode);
        const t2 = await bikeRoute(a, b, mode);
        const t3 = await bikeRoute(b, home, mode);
        legs = { wps: [home, a, b, home], tracks: [t1, t2, t3] };
      } catch { /* nächster Versuch näher am Start */ }
    }
    if (!legs) break;
    const total = legs.tracks.reduce((sum, t) => sum + trackKm(t), 0);
    best = { ...legs, km: total };
    if (Math.abs(total - km) / km <= 0.15) break;
    d *= km / total; // einmal nachjustieren
  }
  if (!best) return null;
  const full = best.tracks.flatMap((t, i) => (i ? t.slice(1) : t));
  return { ...best, hm: summarizeTrack('', full).elevationGainM };
}
async function suggestLoops() {
  if (loopRun.busy || !plan.waypoints.length) return;
  const home = plan.waypoints[0];
  const seq = ++loopRun.seq;
  loopRun.busy = true;
  loopRun.variants = [];
  loopRun.note = '';
  renderLoopPop();
  const base = loopOpts.dir === '' ? Math.random() * 120 : Number(loopOpts.dir);
  const bearings = loopOpts.dir === '' ? [base, base + 120, base + 240] : [base - 35, base, base + 35];
  for (const bearing of bearings) {
    const v = await loopVariant(home, loopOpts.km, bearing, routeMode());
    if (seq !== loopRun.seq || planPop.kind !== 'loop') return;
    if (v) { loopRun.variants.push(v); renderLoopPop(); }
  }
  loopRun.busy = false;
  if (!loopRun.variants.length) loopRun.note = 'Keine Rundtour gefunden – andere Richtung oder Länge versuchen (Richtung Meer geht es nicht weit).';
  renderLoopPop();
}
function takeLoop(i) {
  const v = loopRun.variants[i];
  if (!v) return;
  planSnapshot();
  plan.waypoints = v.wps.map((p) => [p[0], p[1]]);
  plan.segments = v.tracks.map((t) => ({ points: t.map(([lat, lng]) => [lat, lng]), track: t, pending: false, error: false, orig: false }));
  plan.selected = null;
  renderPlan();
  mapView.fitToRoute({ points: plan.segments.flatMap((s) => s.points) });
  // Sprechblase bleibt offen, damit sich die Varianten nacheinander ansehen lassen; Knopf dafür bleibt erhalten
  renderLoopPop();
}
// Eigene ID: „.plan-mode“ trägt auch die Verkehrsmittel-Wahl der Routen-Vorschau (steht im HTML davor)
$('#plan-route-mode').addEventListener('click', (e) => {
  const mode = e.target.closest('[data-mode]')?.dataset.mode;
  if (mode) setRouteMode(mode);
});
$('#plan-panel').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('#plan-save').disabled) savePlan();
});

// --- Menü -------------------------------------------------------------------------------------

// Wallet- und Fotos-Link nur auf iPhone/iPad zeigen (iPadOS meldet sich als „Macintosh“ mit Touch)
const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
$('#menu-wallet').hidden = !isAppleMobile;
$('#menu-photos').hidden = !isAppleMobile;

$('.menu-panel').addEventListener('click', async (e) => {
  const what = e.target.closest('[data-menu]')?.dataset.menu;
  if (!what) return;
  $('.menu').open = false;
  if (what === 'intro') openIntro();
  if (['categories', 'backup', 'hours', 'reset'].includes(what) && !canAdmin()) return toast('Das kann nur der Admin.');
  if (what === 'categories') {
    renderCategoryManager();
    categoryDialog.showModal();
  }
  if (what === 'backup') downloadBackup(state);
  if (what === 'fit') mapView.fitTo(lastVisible, state.airbnb);
  if (what === 'hours') loadOpeningHours();
  if (what === 'reset') {
    if (!canAdmin()) return toast('Alle Orte löschen kann nur der Admin.');
    const where = backend.kind === 'shared' ? ' – für alle in dieser gemeinsamen Reise' : '';
    if (!confirm(`Wirklich alle Orte, das Airbnb und eigene Kategorien löschen${where}?`)) return;
    state.places = [];
    state.airbnb = fixedAirbnb;
    state.customCategories = [];
    state.ui.categories = [];
    $('#search').value = '';
    state.ui.search = '';
    render({ fit: true });
    // Klappt das Löschen nicht (z. B. Admin-PIN falsch), auch Airbnb und Kategorien stehen lassen –
    // persist lädt dann den Serverstand neu
    if (!await persist((b) => b.deleteAllPlaces(rememberedAdminPin(backend.key)), 'Orte konnten nicht gelöscht werden')) return;
    await persistSettings();
  }
});
document.addEventListener('click', (e) => {
  const menu = $('.menu');
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pickMode) setPickMode(false);
  if (e.key === 'Escape' && plan.on && !document.querySelector('dialog[open]')) cancelPlan();
  if (e.key === 'Escape' && dir.on && !document.querySelector('dialog[open]')) closeDir();
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
    if (backend.kind === 'shared') await refresh({ fit: true });
    else await startDemo();
    welcome();
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

// --- Admin -------------------------------------------------------------------------------------
// Wer die Admin-PIN kennt, ist Admin: nur er kann den Zugangscode ändern und alle Orte löschen (geprüft von der
// Datenbank, siehe supabase/schema.sql) sowie – nur in der App gesperrt – Öffnungszeiten laden, Kategorien
// verwalten und das Backup herunterladen. Die PIN merkt sich jedes Gerät selbst. 'unsupported' = SQL noch nicht
// ausgeführt bzw. Demo – dann gilt das bisherige Verhalten ohne Admin.
let adminState = 'unsupported';
const canAdmin = () => adminState === 'ok' || adminState === 'unsupported';

async function checkAdmin() {
  const b = backend;
  let next = 'unsupported';
  try {
    next = await b.adminStatus(rememberedAdminPin(b.key));
  } catch (err) {
    console.warn('Admin-Status nicht ladbar:', err.message);
  }
  if (b !== backend) return; // inzwischen gewechselt
  adminState = next;
  renderAdmin();
}

function renderAdmin() {
  // Kategorien verwalten, Backup, Öffnungszeiten laden, Alle Orte löschen – als Gruppe im Menü
  $('#menu-admin').hidden = !canAdmin();
  $('#menu-admin .menu-group').hidden = adminState !== 'ok'; // Überschrift nur, wenn es wirklich einen Admin gibt
  renderMe();
  if (shareDialog.open) renderShareDialog();
}

function adminHtml() {
  if (backend.offline) return '';
  if (adminState === 'unsupported') return '<p class="hint share-admin">Admin-Zugriff: in Supabase einmal <code>supabase/schema.sql</code> ausführen.</p>';
  if (adminState === 'none') return `<div class="share-admin"><p class="share-text"><strong>Noch kein Admin:</strong> Wer die Admin-PIN festlegt, kann als Einziger den Zugangscode ändern, alle Orte löschen, Öffnungszeiten laden, Kategorien verwalten und das Backup herunterladen.</p>
      <button id="btn-admin-set" class="btn-link" type="button">Admin-PIN festlegen</button></div>`;
  if (adminState === 'ok') return `<div class="share-admin"><p class="share-text"><strong>Du bist Admin</strong> auf diesem Gerät.</p>
      <span class="share-admin-actions"><button id="btn-admin-change" class="btn-link" type="button">Admin-PIN ändern</button>
      <button id="btn-admin-logout" class="btn-link muted" type="button">Als Admin abmelden</button></span></div>`;
  return `<div class="share-admin"><p class="share-text">Zugangscode, Alle Orte löschen, Öffnungszeiten laden, Kategorien und Backup: nur für den Admin.</p>
      <button id="btn-admin-login" class="btn-link" type="button">Als Admin anmelden</button></div>`;
}

// PIN-Fenster: 'login' (PIN eingeben), 'set' (erste PIN festlegen), 'change' (neue PIN; die alte kennt das Gerät)
const adminDialog = $('#admin-dialog');
let adminMode = 'login';
function openAdmin(mode) {
  adminMode = mode;
  $('#admin-title').textContent = mode === 'login' ? 'Als Admin anmelden' : mode === 'set' ? 'Admin-PIN festlegen' : 'Admin-PIN ändern';
  $('#admin-lead').textContent = mode === 'login'
    ? 'Gib die Admin-PIN ein – dieses Gerät merkt sie sich.'
    : 'Mindestens 4 Zeichen. Behalte die PIN für dich – wer sie kennt, ist Admin.';
  $('#admin-repeat-field').hidden = mode === 'login';
  $('#admin-pin').value = '';
  $('#admin-repeat').value = '';
  $('#admin-error').textContent = '';
  $('#admin-save').textContent = mode === 'login' ? 'Anmelden' : 'Speichern';
  if (shareDialog.open) shareDialog.close();
  adminDialog.showModal();
}

$('#admin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#admin-pin').value.trim();
  const error = $('#admin-error');
  error.textContent = pin.length < 4 ? 'Die PIN hat mindestens 4 Zeichen.'
    : adminMode !== 'login' && pin !== $('#admin-repeat').value.trim() ? 'Die beiden Eingaben stimmen nicht überein.'
    : '';
  if (error.textContent) return;
  const btn = $('#admin-save');
  btn.disabled = true;
  try {
    if (adminMode === 'login') {
      if (await backend.adminStatus(pin) !== 'ok') throw new Error('Diese PIN stimmt nicht.');
    } else {
      await backend.setAdminPin(pin, rememberedAdminPin(backend.key));
    }
    rememberAdminPin(backend.key, pin);
    adminDialog.close();
    await checkAdmin();
    toast(adminMode === 'login' ? 'Du bist jetzt Admin auf diesem Gerät.' : 'Admin-PIN gespeichert – du bist Admin auf diesem Gerät.');
  } catch (err) {
    error.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
toggleCodeVisible($('#admin-show'), ['#admin-pin', '#admin-repeat']);

// --- Wer bist du? ------------------------------------------------------------------------------
// Einmal pro Gerät in der gemeinsamen Reise: Person wählen oder neu eintragen. Danach ist „Bezahlt von“
// vorausgewählt und neue Orte/Etappen tragen den Namen. Wechseln über den Initialen-Knopf oben rechts.
const whoDialog = $('#who-dialog');
let whoDone = null;
const needsWho = () => backend.kind === 'shared' && !backend.offline && !state.cashMissing && !me();
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts.at(-1)[0] : (parts[0] || '?')[0]).toUpperCase();
}

// Nach dem Laden: erst „Wer bist du?“ (falls nötig), danach die Willkommensseite
async function welcome() {
  if (needsWho()) await askWho({ required: true }); // nach dem Login Pflicht: ohne Person geht es nicht weiter
  if (!readPref('introHidden')) openIntro();
}

// required: kein Schließen ohne Auswahl (nach dem Login); sonst (Wechseln) jederzeit schließbar
let whoPromise = null;
function askWho({ required = false } = {}) {
  if (whoDialog.open) return whoPromise || Promise.resolve(); // schon offen: auf dasselbe Fenster warten
  whoDialog.toggleAttribute('data-locked', required); // Tipp daneben schließt nicht (siehe Dialoge)
  $('#who-close').hidden = required;
  const current = me()?.id;
  $('#who-list').innerHTML = state.participants.map((p) => `<button type="button" class="who-btn" data-who="${escapeHtml(p.id)}" aria-pressed="${p.id === current}">
      <span class="who-initials" aria-hidden="true">${escapeHtml(initials(p.name))}</span><span class="who-name">${escapeHtml(p.name)}</span></button>`).join('');
  $('#who-list').hidden = !state.participants.length;
  $('#who-new-label').textContent = state.participants.length ? 'Neu dabei? Dein Name' : 'Dein Name';
  $('#who-input').value = '';
  $('#who-error').textContent = '';
  whoDialog.showModal();
  whoPromise = new Promise((resolve) => { whoDone = resolve; });
  return whoPromise;
}

// Immer als jemand angemeldet: fehlt die Person (z. B. in den Ausgaben gelöscht – auch auf einem anderen Gerät),
// gleich „Wer bist du?“ als Pflicht. Läuft bei jedem Zeichnen; nicht während gespeichert wird oder der Code fehlt.
function ensureMe() {
  if (!dataLoaded || pendingWrites > 0 || codeDialog.open || whoDialog.open || !needsWho()) return;
  askWho({ required: true });
}
whoDialog.addEventListener('cancel', (e) => { if (whoDialog.hasAttribute('data-locked')) e.preventDefault(); }); // Esc
whoDialog.addEventListener('close', () => {
  // Pflicht nach dem Login: Browser lassen Esc nicht immer abfangen – dann gleich wieder öffnen (wie beim
  // Zugangscode). Nicht über der Code-Abfrage, die hat Vorrang.
  if (whoDialog.hasAttribute('data-locked') && !me() && !codeDialog.open) {
    setTimeout(() => { if (!whoDialog.open && !codeDialog.open) whoDialog.showModal(); }, 0);
    return;
  }
  whoDone?.();
  whoDone = null;
  whoPromise = null;
});

function setMe(person) {
  writePref(meKey(), person.id);
  renderMe();
  if (shareDialog.open) renderShareDialog();
  whoDialog.close();
  toast(`Hallo ${person.name}! Dieses Gerät ist jetzt dir zugeordnet.`);
}

$('#who-list').addEventListener('click', (e) => {
  const id = e.target.closest('[data-who]')?.dataset.who;
  const person = state.participants.find((p) => p.id === id);
  if (person) setMe(person);
});

$('#who-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#who-input').value.trim().slice(0, 30);
  if (!name) {
    $('#who-error').textContent = 'Bitte deinen Namen eintragen – oder oben antippen, falls er schon da ist.';
    return;
  }
  // Gibt es den Namen schon (z. B. auf einem anderen Gerät angelegt), diese Person nehmen – kein Duplikat
  const existing = state.participants.find((p) => norm(p.name) === norm(name));
  if (existing) return setMe(existing);
  const btn = $('#who-save');
  btn.disabled = true;
  const person = await addParticipant(name);
  btn.disabled = false;
  if (person) setMe(person);
});

// Initialen-Knopf in der Kopfzeile (nur gemeinsame Reise)
function renderMe() {
  const btn = $('#btn-me');
  btn.hidden = backend.kind !== 'shared' || Boolean(state.cashMissing);
  if (btn.hidden) return;
  const p = me();
  btn.textContent = p ? initials(p.name) : '?';
  btn.classList.toggle('is-unknown', !p);
  btn.classList.toggle('is-admin', adminState === 'ok');
  btn.title = p ? `Angemeldet als ${p.name}${adminState === 'ok' ? ' (Admin)' : ''} – antippen zum Wechseln` : 'Wer bist du?';
  btn.setAttribute('aria-label', btn.title);
}
$('#btn-me').addEventListener('click', () => askWho());

// Inhalt: oben das Wichtigste (Orte speichern, Routen planen), darunter alles Weitere als Einzeiler.
// Details stehen in einer Info-Box hinter dem ⓘ – kurze Stichpunkte statt langer Texte.
// demo: false = Punkt in der Demo weglassen (dort gibt es z. B. keine Kartensuche).
const INTRO = [
  { title: 'Das Wichtigste', focus: true, items: [
    { icon: 'pin', color: 'var(--pink)', name: 'Orte speichern',
      text: 'Auf der Karte ein Café, Restaurant … antippen → <strong>„Zu unseren Orten hinzufügen“</strong>.',
      info: [
        { demo: false, html: 'Suchen: <strong>Lupe</strong> oben auf der Karte.' },
        '<strong>Cafés · Bars · Essen</strong> unten auf der Karte zeigen passende Google-Orte im Ausschnitt (weiße Kreise).',
        'Aus Google Maps: Ort → <strong>Teilen → Kopieren</strong>, hier <strong>„+ Importieren“</strong> und einfügen.',
        'Ganze Listen (Takeout, CSV, KML) ebenfalls über <strong>„+ Importieren“</strong>.',
        'Die Art (Kaffee, Restaurant …) wird erkannt und lässt sich in der Liste ändern.',
      ] },
    { icon: 'route', color: 'var(--mint)', name: 'Routen planen',
      text: '<strong>„Etappe planen“</strong> (Handy: grüner Knopf auf der Karte): Punkte tippen – die Strecke folgt Straßen fürs Rennrad.',
      info: [
        `Start ist euer Airbnb. ${icon('home', { size: 14, stroke: 2.2, cls: 'intro-inline' })} führt zurück, ${icon('undo', { size: 14, stroke: 2.2, cls: 'intro-inline' })} macht den letzten Schritt rückgängig.`,
        `Punkte <strong>ziehen</strong>, auf die Linie tippen = Zwischenpunkt, Punkt antippen und ${icon('trash', { size: 14, stroke: 2.2, cls: 'intro-inline' })} = entfernen, ${icon('swap', { size: 14, stroke: 2.2, cls: 'intro-inline' })} dreht die Richtung um.`,
        '<strong>Schnell</strong>: direkte Wege. <strong>Ruhig</strong>: meidet Verkehr, dafür mit Umwegen – das <strong>ⓘ</strong> daneben erklärt den Unterschied.',
        'Kilometer, Höhenmeter, Fahrzeit und Höhenprofil laufend. Steile Stücke farbig: gelb ab 5 %, rot ab 8 %, violett ab 10 % – darunter die Anstiege, antippen zeigt sie auf der Karte.',
        'Knöpfe unter dem Profil: <strong>„Rundtour vorschlagen“</strong> (Länge und Richtung wählen), <strong>„Kaffee-Stopp“</strong> (eigenes Café an einer Stelle einbauen) und <strong>Schnell/Ruhig vergleichen</strong>.',
        'Gespeichert zeigt jede Etappe Wetter, Kaffee-Stopps, Wasser & Velo – und lässt sich als GPX laden.',
        'Oder eine GPX aus Strava/Komoot über <strong>„+ Importieren“</strong> – Start und Ziel werden ans Airbnb angeschlossen.',
      ] },
    { icon: 'wallet', color: 'var(--orange)', name: 'Ausgaben', text: 'Rechnungen erfassen und teilen – <strong>„Ausgaben“</strong> oben auf der Karte.',
      info: [
        '<strong>„Bezahlt von“</strong> ist mit dir vorausgewählt – änderbar, wenn jemand anderes bezahlt hat.',
        'In € oder CHF, gleich oder nach Anteilen aufgeteilt.',
        'Bei einem Ort direkt über <strong>„Rechnung“</strong>.',
        'Der Ausgleich zeigt, wer wem wie viel schuldet – nach der Überweisung <strong>„bezahlt?“</strong> antippen.',
      ] },
  ] },
  { title: 'Rennrad', items: [
    { icon: 'trending-up', color: 'var(--mint)', name: 'Etappen-Details', text: 'Wetter, Kaffee-Stopps, Wasser & Velo, Höhenprofil.',
      info: [
        'Etappe in der Liste antippen – die Details klappen auf.',
        'Der Schalter rechts blendet die Etappe auf der Karte ein (Handy: die Boxen oben machen dann Platz).',
        'Kaffee-Stopps mit Ankunftszeit – und ob dann offen ist.',
        'Finger übers Höhenprofil: die Stelle erscheint als Punkt auf der Karte.',
        `${icon('pencil', { size: 14, stroke: 2.2, cls: 'intro-inline' })} bearbeitet die Etappe (auch GPX aus Strava/Komoot): Punkte alle 5 km ziehen, gespeichert wird eine Kopie.`,
      ] },
    { icon: 'clock', color: 'var(--sky)', name: 'Tempo & Start', text: 'Bestimmen Fahrzeit und Ankunft bei den Stopps.',
      info: [
        'Bei den Espresso-Etappen <strong>„Fahrzeit bei … km/h“</strong> und <strong>„Start“</strong> einstellen.',
        'Steigungen werden in der Fahrzeit mitgerechnet.',
        'Das Wetter gilt für heute bzw. morgen, 9–16 Uhr am Start.',
        'Jedes Gerät merkt sich seine Werte.',
      ] },
    { icon: 'check', color: 'var(--yellow)', name: 'Nach der Fahrt', text: 'Haken = gefahren, Strava-Aktivität verlinken.',
      info: [
        'Der Kreis links neben der Etappe markiert sie als gefahren.',
        'In den Details: Tour-Link (Strava, Komoot) – nach dem Haken auch die gefahrene Aktivität.',
        `${icon('download', { size: 14, stroke: 2.2, cls: 'intro-inline' })} lädt die Etappe als GPX – z. B. für Garmin oder Wahoo.`,
      ] },
  ] },
  { title: 'Außerdem', items: [
    { icon: 'plus', color: 'var(--yellow)', name: 'Als App aufs iPhone', text: 'Safari: Teilen-Symbol → <strong>„Zum Home-Bildschirm“</strong> – startet wie eine App.',
      info: [
        'Den Reise-Link in <strong>Safari</strong> öffnen, dann Teilen-Symbol (Quadrat mit Pfeil) → <strong>„Zum Home-Bildschirm“</strong>.',
        'Die App startet im Vollbild direkt in eurer Reise.',
        'Beim ersten Öffnen einmal Zugangscode und Namen eingeben – die App auf dem Home-Bildschirm merkt sich beides getrennt von Safari.',
        'Android (Chrome): Menü ⋮ → „Zum Startbildschirm hinzufügen“.',
      ] },
    { icon: 'search', color: 'var(--sky)', name: 'Karte & Liste', text: 'Nach Art filtern, suchen, <strong>„Jetzt offen“</strong>.',
      info: [
        'Handy: Liste nach unten wischen – dann ist die ganze Karte frei. Der runde Knopf unten links holt sie zurück.',
        'Ein Tipp auf <strong>„Unsere Orte“</strong> bzw. <strong>„Espresso-Etappen“</strong> klappt den Abschnitt zu oder auf.',
        'Die km bei den Orten sind die Strecke mit dem Auto ab dem Airbnb (mit ≈: Luftlinie). Sortiert wird danach, nach Name, Art oder Datum.',
        '„Jetzt offen“ braucht Öffnungszeiten: Orte aus der Google-Karte bringen sie mit, für ältere lädt sie der Admin (Menü <strong>•••</strong>).',
        'Bei <strong>„Kultur & Orte“</strong> erscheint beim Öffnen ein kurzer Wikipedia-Text mit Bild.',
        '<strong>„Satellit“</strong> unten rechts zeigt Luftbilder.',
      ] },
    { icon: 'star', color: 'var(--yellow)', name: 'Merken', text: 'Stern = Favorit, Häkchen = schon besucht, Reservierungen.',
      info: [
        'Besuchte Orte werden blass.',
        'Beim Restaurant <strong>„Als reserviert markieren“</strong> mit Datum und Uhrzeit.',
        'Der Filter <strong>„Reserviert“</strong> zeigt alle Termine.',
      ] },
    { icon: 'navigation', color: 'var(--sky)', name: 'Unterwegs', text: 'Standort-Knopf und <strong>„Route“</strong> zu jedem Ort.',
      info: [
        'Der Standort zeigt auch, wohin du schaust.',
        '„Route“ zeigt die Strecke in der App – Auto, Velo, zu Fuß oder ÖV, ab deinem Standort oder dem Airbnb.',
        '<strong>„Navigieren“</strong> übergibt an Google Maps (mit Sprachführung).',
        'Unter <strong>„Unser Airbnb“</strong> geht’s mit „Route zur Unterkunft“ zurück.',
      ] },
    { icon: 'camera', color: 'var(--lilac)', name: 'Fotos & Reise', text: 'Menü <strong>•••</strong>: Fotos, Bordkarten, Flüge, Check-in.',
      info: [
        '<strong>„Fotos“</strong> öffnet die Fotos-App mit euren geteilten Alben (iPhone/iPad).',
        '<strong>„Bordkarten“</strong> öffnet Wallet, <strong>„Meine Flüge“</strong> die easyJet-App.',
        '<strong>„Check-in“</strong> zeigt eure Airbnb-Buchung mit der Anleitung.',
      ] },
    { icon: 'users', color: 'var(--pink)', name: 'Zusammen planen', text: 'Alle mit dem Reise-Link sehen dasselbe.',
      info: [
        'Den Link gibt es unter <strong>„Teilen“</strong> – nur an Mitreisende weitergeben.',
        'Einmal pro Gerät <strong>„Wer bist du?“</strong> – der Kreis mit deinen Initialen oben rechts zeigt es, antippen zum Wechseln.',
        'Änderungen sind nach spätestens 20 Sekunden bei allen.',
        'Mit einem <strong>Zugangscode</strong> (unter „Teilen“) braucht es zusätzlich den Code.',
        'Zugangscode, Alle Orte löschen, Öffnungszeiten, Kategorien und Backup: nur der <strong>Admin</strong> (Admin-PIN unter „Teilen“).',
        'Ohne Netz zeigt die App den zuletzt geladenen Stand.',
      ] },
  ] },
];

function renderIntro() {
  const demo = backend.kind === 'demo';
  let n = 0;
  $('#intro-groups').innerHTML = INTRO.map((group) => `<section class="intro-group${group.focus ? ' is-focus' : ''}">
      <h3 class="intro-group-title">${group.title}</h3>
      <ul class="intro-list">${group.items.map((it) => {
        const id = `intro-info-${n++}`;
        const info = it.info.filter((x) => !(demo && x.demo === false)).map((x) => `<li>${x.html || x}</li>`).join('');
        return `<li class="intro-item">
          <span class="intro-badge" style="--b:${it.color}" aria-hidden="true">${icon(it.icon, { size: 20, stroke: 2.2 })}</span>
          <div class="intro-text">
            <span class="intro-head"><strong class="intro-name">${it.name}</strong>
              <button type="button" class="intro-info" aria-expanded="false" aria-controls="${id}" aria-label="Mehr zu „${it.name}“">i</button></span>
            <span>${it.text}</span>
            <div class="intro-pop" id="${id}" hidden><ul>${info}</ul></div>
          </div>
        </li>`;
      }).join('')}</ul>
    </section>`).join('');
}

// ⓘ öffnet die Info-Box der Funktion; es ist immer nur eine offen
$('#intro-groups').addEventListener('click', (e) => {
  const btn = e.target.closest('.intro-info');
  if (!btn) return;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  for (const b of $$('.intro-info', introDialog)) {
    const on = open && b === btn;
    b.setAttribute('aria-expanded', String(on));
    $(`#${b.getAttribute('aria-controls')}`).hidden = !on;
  }
});

function openIntro() {
  renderIntro();
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
