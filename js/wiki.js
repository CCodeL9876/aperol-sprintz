// Kurzer Text und Bild aus Wikipedia für „Kultur & Orte“ (kostenlos, ohne Schlüssel). Geladen erst, wenn ein
// solcher Ort geöffnet wird: Artikel mit Koordinaten in der Nähe (Geosuche), passender Name bevorzugt, sonst der
// nächste ganz nah. Zuerst deutsch, dann englisch, dann spanisch. Übermittelt werden nur die Koordinaten des Orts.
// Ergebnis im Browser gemerkt (WIKI_MAX_AGE_DAYS), auch „nichts gefunden“ – damit nicht jedes Öffnen neu fragt.

import { readPref, writePref } from './store.js';
import { hasCoords, haversineKm } from './geo.js';

export const WIKI_CATEGORIES = new Set(['kultur']);
const LANGS = ['de', 'en', 'es'];
const RADIUS_M = 400;
const NEAREST_M = 120; // ohne passenden Namen nur so nah
const WIKI_MAX_AGE_DAYS = 30;
const MAX_ENTRIES = 300;
const PREF = 'wiki';

let memo = null;
const stored = () => (memo ??= readPref(PREF) || {});
const keyOf = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

// { title, extract, img, url, lang } | null (nichts gefunden) | undefined (noch nicht gefragt / veraltet)
export function cachedWiki(p) {
  if (!hasCoords(p)) return null;
  const e = stored()[keyOf(p)];
  if (!e || (Date.now() - e.at) / 86400000 > WIKI_MAX_AGE_DAYS) return undefined;
  return e.v || null;
}

function remember(p, v) {
  const all = stored();
  all[keyOf(p)] = { at: Date.now(), v };
  const keys = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k];
  writePref(PREF, all);
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((x) => x.length >= 4);
const sameName = (a, b) => {
  const wb = new Set(words(b));
  return words(a).some((x) => wb.has(x));
};

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function findIn(lang, p) {
  const geo = await getJson(`https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
    action: 'query', list: 'geosearch', gscoord: `${p.lat}|${p.lng}`, gsradius: RADIUS_M, gslimit: 10, format: 'json', origin: '*',
  })}`);
  const hits = (geo.query?.geosearch || [])
    .map((h) => ({ ...h, m: haversineKm(p.lat, p.lng, h.lat, h.lon) * 1000 }))
    .sort((a, b) => a.m - b.m);
  const hit = hits.find((h) => sameName(p.name, h.title)) || (hits[0]?.m <= NEAREST_M ? hits[0] : null);
  if (!hit) return null;
  const s = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`);
  if (!s.extract || s.type === 'disambiguation') return null;
  return {
    title: String(s.title || hit.title).slice(0, 200),
    extract: String(s.extract).slice(0, 600),
    img: /^https:\/\/upload\.wikimedia\.org\//.test(s.thumbnail?.source || '') ? s.thumbnail.source : '',
    url: s.content_urls?.mobile?.page || s.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
    lang,
  };
}

// Laden und merken. Rückgabe wie cachedWiki. Netzfehler werfen (dann beim nächsten Öffnen erneut versuchen).
export async function loadWiki(p) {
  if (!hasCoords(p)) return null;
  for (const lang of LANGS) {
    const v = await findIn(lang, p);
    if (v) {
      remember(p, v);
      return v;
    }
  }
  remember(p, null);
  return null;
}
