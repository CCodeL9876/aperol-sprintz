// Trinkbrunnen und Velo-Werkstätten entlang einer Etappe – aus OpenStreetMap über die Overpass-API
// (kostenlos, ohne Schlüssel; übermittelt wird nur das Rechteck um die Strecke). Ergebnis je Etappe im
// Browser gemerkt (POI_MAX_AGE_DAYS), damit es auch ohne Netz unterwegs verfügbar ist.

import { readPref, writePref } from './store.js';

// Öffentliche Overpass-Server, der Reihe nach: ist einer überlastet oder nicht erreichbar, kommt der nächste
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const PREF = 'routePois';
const POI_MAX_AGE_DAYS = 14;
const PAD_DEG = 0.006; // ca. 500–650 m Rand um die Strecke

export const POI_TYPES = {
  water: { label: 'Trinkwasser', icon: 'droplet' },
  bike: { label: 'Velo-Werkstatt', icon: 'wrench' },
  repair: { label: 'Velo-Reparaturstation', icon: 'wrench' },
};

function typeOf(tags) {
  if (tags.amenity === 'drinking_water') return 'water';
  if (tags.amenity === 'bicycle_repair_station') return 'repair';
  if (tags.shop === 'bicycle') return 'bike';
  return null;
}

// Im Browser gemerkte Punkte aller Etappen – einmal gelesen, danach im Speicher (wird bei jedem Zeichnen gebraucht)
let memo = null;
const stored = () => (memo ??= readPref(PREF) || {});

// Werte aus Datenbank oder Backup absichern; ungültig → null
export function sanitizePois(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter((x) => x && POI_TYPES[x.type] && Number.isFinite(x.lat) && Number.isFinite(x.lng))
    .slice(0, 400)
    .map((x) => ({ id: String(x.id || '').slice(0, 40), type: x.type, name: String(x.name || '').slice(0, 120), lat: x.lat, lng: x.lng }));
}

// Auf diesem Gerät gemerkte Punkte einer Etappe oder null. Seit die Punkte bei der Etappe in der Datenbank
// liegen, nur noch Übergang (ältere Stände) und Ersatz, solange die Spalte „pois“ fehlt. (nie geladen, veraltet oder Strecke geändert)
export function cachedPois(route) {
  const entry = stored()[route.id];
  if (!entry || entry.n !== route.points?.length) return null;
  if ((Date.now() - entry.at) / 86400000 > POI_MAX_AGE_DAYS) return null;
  return Array.isArray(entry.items) ? entry.items : null;
}

function remember(route, items) {
  const all = stored();
  all[route.id] = { n: route.points.length, at: Date.now(), items };
  // Höchstens 30 Etappen aufbewahren (älteste zuerst weg)
  const ids = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
  for (const id of ids.slice(0, Math.max(0, ids.length - 30))) delete all[id];
  writePref(PREF, all);
}

// Lädt die Punkte im Rechteck um die Strecke. Rückgabe: [{ id, type, name, lat, lng }]
export async function loadPois(route) {
  const pts = route.points;
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lng] of pts) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
  }
  const box = [s - PAD_DEG, w - PAD_DEG, n + PAD_DEG, e + PAD_DEG].map((v) => v.toFixed(5)).join(',');
  const query = `[out:json][timeout:25];(node["amenity"="drinking_water"](${box});nwr["amenity"="bicycle_repair_station"](${box});nwr["shop"="bicycle"](${box}););out center tags;`;
  let lastError = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.elements || []).map((el) => {
        const tags = el.tags || {};
        const type = typeOf(tags);
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (!type || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { id: `${el.type}${el.id}`, type, name: String(tags.name || '').slice(0, 120), lat, lng };
      }).filter(Boolean).slice(0, 400);
      remember(route, items);
      return items;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass nicht erreichbar');
}
