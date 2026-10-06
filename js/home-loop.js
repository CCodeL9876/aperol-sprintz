// Etappen ans Airbnb anschließen: Beim GPX-Import sollen Start und Ziel bei der Unterkunft liegen.
//  - Rundtour, die ohnehin am Airbnb vorbeiführt: Startpunkt dorthin verschieben (nichts doppelt fahren)
//  - sonst: Anfahrt vom Airbnb zum Start bzw. Rückfahrt vom Ziel ergänzen – als Rennrad-Route von BRouter
//    (brouter.de, OpenStreetMap, kostenlos, ohne Schlüssel; übermittelt werden nur die jeweiligen Endpunkte)
// Länge, Höhenmeter und GPX-Datei werden danach für die ganze Runde neu berechnet (summarizeTrack).

import { haversineKm, formatKm } from './geo.js';
import { summarizeTrack, round6 } from './importers.js';

const BROUTER = 'https://brouter.de/brouter';
const PROFILE = 'fastbike'; // Rennrad: Asphalt, ruhige Straßen bevorzugt
const NEAR_KM = 0.3; // so nah am Airbnb gilt Start bzw. Ziel schon als „beim Airbnb“
const LOOP_KM = 0.2; // Start und Ziel so nah beieinander → Rundtour
const PASS_KM = 1; // Rundtour führt so nah am Airbnb vorbei → Start dorthin verschieben
const MAX_KM = 80; // weiter weg (andere Insel, anderes Land): nicht anschließen
const TIMEOUT_MS = 20000;

const dist = (a, b) => haversineKm(a[0], a[1], b[0], b[1]);

// Rennrad-Route zwischen zwei Punkten [lat, lon] → Punkte [lat, lon, ele|null] (auch für „Etappe planen“ in app.js)
export async function bikeRoute(from, to) {
  const url = `${BROUTER}?lonlats=${from[1]},${from[0]}|${to[1]},${to[0]}&profile=${PROFILE}&alternativeidx=0&format=geojson`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  // 400: kein Weg (z. B. Punkt weitab jeder Straße); sonst Server-Problem
  if (!res.ok) throw new Error(res.status === 400 ? 'kein befahrbarer Weg dorthin' : `Routenplaner antwortet nicht (${res.status})`);
  const coords = (await res.json())?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('keine Route gefunden');
  return coords.map(([lon, lat, ele]) => [round6(lat), round6(lon), Number.isFinite(ele) ? Math.round(ele * 10) / 10 : null]);
}

const lengthKm = (pts) => pts.reduce((sum, p, i) => (i ? sum + dist(pts[i - 1], p) : 0), 0);

// parsed: Ergebnis von parseGpx (mit .track), home: { lat, lng }.
// Rückgabe: { route, notes } – route ist die angepasste (oder unveränderte) Etappe, notes beschreibt die Änderungen.
// Ist der Routenplaner nicht erreichbar, bleibt die Etappe ohne Anfahrt/Rückfahrt (error gesetzt).
export async function connectToHome(parsed, home) {
  let track = parsed.track;
  if (!track?.length) return { route: parsed, notes: [] };
  const h = [home.lat, home.lng];
  if (dist(h, track[0]) > MAX_KM && dist(h, track.at(-1)) > MAX_KM) {
    return { route: parsed, notes: [], error: `Etappe liegt über ${MAX_KM} km vom Airbnb entfernt – unverändert übernommen` };
  }
  const notes = [];
  let changed = false;

  // Rundtour: am Punkt nächst dem Airbnb beginnen (Start-/Zielpunkt doppelt vermeiden)
  if (dist(track[0], track.at(-1)) <= LOOP_KM && dist(h, track[0]) > NEAR_KM) {
    let best = 0;
    for (let i = 1; i < track.length; i++) if (dist(h, track[i]) < dist(h, track[best])) best = i;
    if (best > 0 && best < track.length - 1 && dist(h, track[best]) <= PASS_KM) {
      track = [...track.slice(best, -1), ...track.slice(0, best + 1)];
      notes.push('Start der Rundtour ans Airbnb verschoben');
      changed = true;
    }
  }

  const needStart = dist(h, track[0]) > NEAR_KM;
  const needEnd = dist(h, track.at(-1)) > NEAR_KM;
  let error = '';
  if (needStart || needEnd) {
    try {
      const [toStart, toHome] = await Promise.all([
        needStart ? bikeRoute(h, track[0]) : null,
        needEnd ? bikeRoute(track.at(-1), h) : null,
      ]);
      // Hat die Originaldatei keine Höhen, auch die ergänzten Stücke ohne Höhen lassen –
      // sonst zählten nur deren Höhenmeter
      const withEle = track.some((p) => Number.isFinite(p[2]));
      const strip = (pts) => (withEle ? pts : pts.map(([lat, lon]) => [lat, lon, null]));
      if (toStart) {
        track = [...strip(toStart), ...track];
        notes.push(`Anfahrt vom Airbnb ${formatKm(lengthKm(toStart))}`);
      }
      if (toHome) {
        track = [...track, ...strip(toHome)];
        notes.push(`Rückfahrt zum Airbnb ${formatKm(lengthKm(toHome))}`);
      }
      changed = true;
    } catch (err) {
      error = `Anfahrt/Rückfahrt zum Airbnb nicht ergänzt (${err.name === 'TimeoutError' ? 'Routenplaner antwortet nicht' : err.message})`;
    }
  }

  return { route: changed ? summarizeTrack(parsed.name, track) : parsed, notes, error };
}
