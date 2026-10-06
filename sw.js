// Service Worker: macht die App ohne Netz nutzbar (z. B. unterwegs in der Serra de Tramuntana).
//  - Seite (index.html): zuerst aus dem Netz – so kommt jede neue Version sofort an –, ohne Netz aus dem Speicher
//  - App-Dateien (JS, CSS, Schriften, Bilder): aus dem Speicher, sonst aus dem Netz. Ihre Adressen tragen die
//    Versionsnummer (?v=…), eine neue Version hat also neue Adressen; ältere Stände werden dabei aufgeräumt.
//  - OpenStreetMap-Kacheln: einmal gesehene Ausschnitte bleiben gespeichert (höchstens MAX_TILES). Vorab
//    ganze Gebiete herunterladen erlauben die Nutzungsregeln von OpenStreetMap nicht.
// Google Maps, Supabase und alle anderen Dienste laufen unverändert direkt übers Netz.
// Die Daten der Reise legt app.js selbst ab (Cache „llocs-offline“, siehe saveOfflineSnapshot).

const APP_CACHE = 'llocs-app-v1';
const TILE_CACHE = 'llocs-tiles-v1';
const MAX_TILES = 3000;
const PAGE_TIMEOUT_MS = 6000; // schwaches Netz in den Bergen: nicht ewig warten, sondern den gespeicherten Stand zeigen
const SCOPE = new URL(self.registration.scope);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([APP_CACHE, TILE_CACHE, 'llocs-offline']);
    for (const name of await caches.keys()) if (name.startsWith('llocs-') && !keep.has(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname)) {
    event.respondWith(page(req));
  } else if (url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname)) {
    event.respondWith(appFile(req, url));
  } else if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(tile(req));
  }
});

// Seite: Netz mit Zeitlimit, sonst gespeicherte Fassung (immer unter der Startadresse abgelegt)
async function page(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
    if (res.ok) await cache.put(SCOPE.href, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(SCOPE.href);
    if (cached) return cached;
    throw err;
  }
}

async function appFile(req, url) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    // Gleiche Datei mit anderer Versionsnummer = älterer Stand → entfernen
    if (url.searchParams.has('v')) {
      for (const key of await cache.keys()) {
        const k = new URL(key.url);
        if (k.pathname === url.pathname && k.search !== url.search) await cache.delete(key);
      }
    }
  }
  return res;
}

let tilePuts = 0;
async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) { // nur CORS-Antworten (Leaflet lädt mit crossOrigin) – undurchsichtige würden den Speicher aufblähen
    await cache.put(req, res.clone());
    // Ab und zu aufräumen: älteste Kacheln zuerst weg
    if (++tilePuts % 100 === 0) {
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await cache.delete(key);
    }
  }
  return res;
}
