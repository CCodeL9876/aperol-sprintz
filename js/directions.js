// Routen-Vorschau in der App: Strecke, Dauer und Distanz zu einem Ort – Auto, zu Fuß und ÖV über die Google
// Routes API (gleicher Schlüssel wie die Karte; „Routes API“ muss in der Google Cloud Console freigeschaltet sein),
// Velo über BRouter wie der Etappen-Planer (kostenlos, Rennrad-Profil). Die Navigation selbst übernimmt Google Maps
// (navUrl) – eigene Abbiegehinweise erlauben Googles Nutzungsbedingungen in einer Web-App nicht.

import { bikeRoute } from './home-loop.js';

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const TIMEOUT_MS = 20000;

// google: travelMode der Routes API; maps: travelmode im Google-Maps-Link
export const TRAVEL_MODES = {
  drive: { label: 'Auto', google: 'DRIVE', maps: 'driving' },
  bike: { label: 'Velo', maps: 'bicycling' },
  walk: { label: 'Zu Fuß', google: 'WALK', maps: 'walking' },
  transit: { label: 'ÖV', google: 'TRANSIT', maps: 'transit' },
};

// Google-Polyline („encoded polyline“) → [[lat, lng]]
function decodePolyline(str) {
  const pts = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

const point = ([lat, lng]) => ({ location: { latLng: { latitude: lat, longitude: lng } } });

// Rückgabe: { points: [[lat, lng]], durationS, distanceM } – Velo zusätzlich mit track (inkl. Höhen) und ohne
// Dauer (die rechnet app.js mit dem eigenen Tempo, wie bei den Etappen)
export async function computeRoute(apiKey, from, to, mode) {
  if (mode === 'bike') {
    const track = await bikeRoute(from, to, 'fast');
    return { points: track.map(([lat, lng]) => [lat, lng]), track, durationS: null, distanceM: null };
  }
  const travelMode = TRAVEL_MODES[mode]?.google || 'DRIVE';
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: point(from),
      destination: point(to),
      travelMode,
      ...(travelMode === 'DRIVE' ? { routingPreference: 'TRAFFIC_AWARE' } : {}),
      languageCode: 'de',
      units: 'METRIC',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Fehler ${res.status}`;
    // Schnittstelle nicht freigeschaltet bzw. Schlüssel nicht dafür zugelassen
    if (res.status === 403) throw Object.assign(new Error('Routen in der App sind noch nicht eingerichtet (Routes API in der Google Cloud Console freischalten)'), { setup: true, detail: msg });
    throw new Error(msg);
  }
  const r = data.routes?.[0];
  if (!r?.polyline?.encodedPolyline) throw new Error(travelMode === 'TRANSIT' ? 'keine ÖV-Verbindung gefunden' : 'keine Route gefunden');
  return {
    points: decodePolyline(r.polyline.encodedPolyline),
    durationS: parseInt(String(r.duration || '0'), 10) || null, // „1234s“
    distanceM: r.distanceMeters ?? null,
  };
}

// Link für „Navigation starten“: Google Maps mit Ziel, Verkehrsmittel und – wenn nicht der eigene Standort – Start
export function navUrl({ from, to, mode, destination }) {
  const params = { api: '1', destination: destination || `${to[0]},${to[1]}`, travelmode: TRAVEL_MODES[mode]?.maps || 'driving' };
  if (from) params.origin = `${from[0]},${from[1]}`;
  else params.dir_action = 'navigate'; // ab eigenem Standort gleich losnavigieren
  return `https://www.google.com/maps/dir/?${new URLSearchParams(params)}`;
}
