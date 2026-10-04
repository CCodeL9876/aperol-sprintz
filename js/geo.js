// Distanzberechnung, Koordinaten aus Google-Maps-Links lesen und Geocoding über OpenStreetMap.

// Reservierung { date: 'JJJJ-MM-TT', time: 'HH:MM' } → „Sa 3.10., 19:10 Uhr“. Beides ist optional;
// ohne Angaben bleibt nur „Reserviert“.
export function formatReservation(r) {
  if (!r) return '';
  const parts = [];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date || '');
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    parts.push(`${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`);
  }
  if (/^\d{2}:\d{2}$/.test(r.time || '')) parts.push(`${r.time} Uhr`);
  return parts.length ? `Reserviert · ${parts.join(', ')}` : 'Reserviert';
}

// Google-Maps-Route zum Ort. Ohne „origin“ startet Google beim aktuellen Standort des Geräts
// (in der Maps-App bzw. im Browser nach Freigabe). Ziel: Name + Adresse ergibt einen sauber
// benannten Ort; ohne Adresse die Koordinaten, notfalls nur der Name.
export function routeUrl(p) {
  const destination = p.address ? `${p.name}, ${p.address}` : hasCoords(p) ? `${p.lat},${p.lng}` : p.name;
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination })}`;
}

// Route zur Unterkunft: Ziel ist die eingetragene Adresse – die findet Google Maps zuverlässig samt Hausnummer.
// Ältere Einträge ohne Adressfeld: Bezeichnung „Name · Adresse“ → Teil nach dem letzten „·“; bei reinen
// Koordinaten, einem auf der Karte gewählten Punkt oder einem eingefügten Maps-Link („Pin (…)“) die Koordinaten.
export function homeRouteUrl(a) {
  let destination = String(a.address || '').trim();
  if (!destination) {
    const text = String(a.label || '').split(' · ').pop().trim();
    const useCoords = !/[a-zäöü]{3}/i.test(text) || /^(Gewählter Punkt|Pin)\b/.test(text);
    destination = useCoords && hasCoords(a) ? `${a.lat},${a.lng}` : text || `${a.lat},${a.lng}`;
  }
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination })}`;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export const hasCoords = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);

const valid = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

// Reihenfolge wichtig: "!3d…!4d…" ist der genaue Ort, "@…" nur der Kartenausschnitt.
const COORD_PATTERNS = [
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  /[?&](?:q|query|ll|destination|center)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*\+?(-?\d+(?:\.\d+)?)/i,
  /\/(?:search|place|dir)\/(-?\d+(?:\.\d+)?)(?:,|%2C)\s*\+?(-?\d+(?:\.\d+)?)/i,
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  /^\s*(-?\d{1,2}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)\s*$/,
];

export function parseCoords(text) {
  if (!text) return null;
  const s = String(text);
  for (const re of COORD_PATTERNS) {
    const m = s.match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (valid(lat, lng)) return { lat, lng };
    }
  }
  return null;
}

export function nameFromUrl(url) {
  const m = String(url || '').match(/\/place\/([^/@?]+)/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
  } catch {
    return m[1].replace(/\+/g, ' ');
  }
}

export function formatKm(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toLocaleString('de-DE', { maximumFractionDigits: km < 20 ? 1 : 0 })} km`;
}

// Beide Dienste basieren auf OpenStreetMap und brauchen keinen API-Key.
// Nominatim erlaubt max. 1 Anfrage/Sekunde – daher wird jede Anfrage zeitlich gestaffelt.
// Lehnt Nominatim ab (Sperre, Rate-Limit, Netzwerkfehler), springt Photon (komoot) ein.
let lastRequest = 0;
export async function geocode(query, near = null) {
  const wait = Math.max(0, lastRequest + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();

  try {
    return await geocodeNominatim(query, near);
  } catch (nominatimError) {
    try {
      return await geocodePhoton(query, near);
    } catch (photonError) {
      throw new Error(`Adresssuche nicht erreichbar – Nominatim: ${nominatimError.message}; Photon: ${photonError.message}`);
    }
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim().slice(0, 120);
    throw new Error(`HTTP ${res.status}${text ? ` (${text})` : ''}`);
  }
  return res.json();
}

async function geocodeNominatim(query, near) {
  const params = new URLSearchParams({ format: 'jsonv2', q: query, limit: '5', 'accept-language': 'de' });
  if (near && hasCoords(near)) {
    const d = 0.8;
    params.set('viewbox', [near.lng - d, near.lat + d, near.lng + d, near.lat - d].join(','));
  }
  const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!Array.isArray(data)) throw new Error('unerwartete Antwort');
  return data.map((r) => ({ label: r.display_name, lat: parseFloat(r.lat), lng: parseFloat(r.lon) }));
}

async function geocodePhoton(query, near) {
  const params = new URLSearchParams({ q: query, limit: '5', lang: 'de' });
  if (near && hasCoords(near)) {
    params.set('lat', String(near.lat));
    params.set('lon', String(near.lng));
  }
  const data = await fetchJson(`https://photon.komoot.io/api/?${params}`);
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const town = [p.postcode, p.city || p.town || p.village || p.county].filter(Boolean).join(' ');
    const label = [p.name, street, town, p.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    const [lng, lat] = f.geometry.coordinates;
    return { label, lat, lng };
  });
}
