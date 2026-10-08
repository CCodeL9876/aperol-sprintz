// Strecke mit dem Auto vom Airbnb zu den Orten (statt Luftlinie) – über die Route Matrix der Google Routes API
// (gleicher Schlüssel und gleiche Freischaltung wie die Routen-Vorschau in directions.js). Ohne Verkehrslage
// gerechnet, damit die Zahl stabil bleibt. Ergebnisse werden im Browser gemerkt (jede Abfrage zählt zum
// Kontingent) und nur neu geholt, wenn sich die Unterkunft verschiebt oder ein Ort dazukommt.

import { readPref, writePref } from './store.js';
import { hasCoords } from './geo.js';

const ENDPOINT = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const TIMEOUT_MS = 20000;
const CHUNK = 100; // Ziele pro Abfrage (Google erlaubt bis 625 Elemente)
const PREF = 'roadDistances';

const keyOf = (lat, lng) => `${lat.toFixed(5)},${lng.toFixed(5)}`;

// { origin: "lat,lng", d: { "lat,lng": Meter | null } } – null: keine Strasse dorthin (z. B. andere Insel)
let cache = readPref(PREF);
if (!cache || typeof cache !== 'object' || typeof cache.d !== 'object') cache = { origin: '', d: {} };

function cacheFor(airbnb) {
  const origin = keyOf(airbnb.lat, airbnb.lng);
  if (cache.origin !== origin) cache = { origin, d: {} };
  return cache.d;
}

// Strecke in km, null ohne Strasse, undefined wenn (noch) unbekannt
export function roadKm(airbnb, p) {
  if (!airbnb || !hasCoords(airbnb) || !hasCoords(p)) return undefined;
  const m = cacheFor(airbnb)[keyOf(p.lat, p.lng)];
  return m === undefined ? undefined : m === null ? null : m / 1000;
}

const waypoint = (lat, lng) => ({ waypoint: { location: { latLng: { latitude: lat, longitude: lng } } } });

// Fehlende Strecken holen. Rückgabe: true, wenn neue Werte da sind. Wirft bei Fehlern
// (err.setup = Routes API nicht freigeschaltet).
export async function loadRoadDistances(apiKey, airbnb, places) {
  if (!apiKey || !airbnb || !hasCoords(airbnb)) return false;
  const known = cacheFor(airbnb);
  const missing = [...new Map(places.filter(hasCoords)
    .map((p) => [keyOf(p.lat, p.lng), [p.lat, p.lng]])).entries()]
    .filter(([k]) => !(k in known));
  if (!missing.length) return false;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const part = missing.slice(i, i + CHUNK);
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,condition,status',
      },
      body: JSON.stringify({
        origins: [waypoint(airbnb.lat, airbnb.lng)],
        destinations: part.map(([, [lat, lng]]) => waypoint(lat, lng)),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        units: 'METRIC',
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (Array.isArray(data) ? data[0] : data)?.error?.message || `Fehler ${res.status}`;
      if (res.status === 403) throw Object.assign(new Error('Strecken-Distanz braucht die Routes API (Google Cloud Console)'), { setup: true, detail: msg });
      throw new Error(msg);
    }
    for (const el of Array.isArray(data) ? data : []) {
      const k = part[el.destinationIndex ?? 0]?.[0]; // Index 0 lässt Google im JSON weg
      if (!k || el.status?.code) continue; // Fehler bei einem Ziel: beim nächsten Mal erneut versuchen
      known[k] = el.condition === 'ROUTE_EXISTS' && Number.isFinite(el.distanceMeters) ? el.distanceMeters : null;
    }
  }
  writePref(PREF, cache);
  return true;
}
