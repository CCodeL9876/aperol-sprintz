// Kurzer Text und Bild aus Wikipedia für „Kultur & Orte“ (kostenlos, ohne Schlüssel). Geladen erst, wenn ein
// solcher Ort geöffnet wird. Übermittelt werden nur die Koordinaten und der Name des Orts.
// Ablauf: Artikel mit Koordinaten in der Nähe suchen (Geosuche in de, en, es, ca – unsere Ortsnamen sind meist
// katalanisch/spanisch, die Artikeltitel je Sprache verschieden). Bevorzugt ein Artikel mit passendem Namen
// („Catedral“ = „Kathedrale“ = „Cathedral“ …); gefunden in es/ca, dann nach Möglichkeit der deutsche bzw.
// englische Artikel dazu (Sprachlinks). Ohne passenden Namen nur ein Artikel ganz nah am Ort.
// Ergebnis im Browser gemerkt (WIKI_MAX_AGE_DAYS); „nichts gefunden“ kürzer, damit ein neuer Versuch möglich ist.

import { readPref, writePref } from './store.js';
import { hasCoords, haversineKm } from './geo.js';

export const WIKI_CATEGORIES = new Set(['kultur']);
const LANGS = ['de', 'en', 'es', 'ca'];
const RADIUS_M = 1000;
const NEAREST_M = 120; // ohne passenden Namen nur so nah
const GENERIC_MAX_M = 300; // nur ein allgemeines Wort gleich („Kirche“): so nah muss es sein
const WIKI_MAX_AGE_DAYS = 30;
const NONE_MAX_AGE_DAYS = 3;
const MAX_ENTRIES = 300;
const PREF = 'wiki2'; // neue Suche – Ergebnisse der ersten Fassung (oft „nichts gefunden“) nicht übernehmen

let memo = null;
const stored = () => (memo ??= readPref(PREF) || {});
const keyOf = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

// { title, extract, img, url, lang } | null (nichts gefunden) | undefined (noch nicht gefragt / veraltet)
export function cachedWiki(p) {
  if (!hasCoords(p)) return null;
  const e = stored()[keyOf(p)];
  if (!e) return undefined;
  const age = (Date.now() - e.at) / 86400000;
  if (age > (e.v ? WIKI_MAX_AGE_DAYS : NONE_MAX_AGE_DAYS)) return undefined;
  return e.v || null;
}

function remember(p, v) {
  const all = stored();
  all[keyOf(p)] = { at: Date.now(), v };
  const keys = Object.keys(all).sort((a, b) => all[a].at - all[b].at);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k];
  writePref(PREF, all);
}

// Wörter vergleichbar machen: Akzente weg, gleiche Begriffe in allen Sprachen auf ein Wort
const SAME = {
  cathedral: ['catedral', 'cathedral', 'kathedrale', 'seu', 'dom'],
  monastery: ['monestir', 'monasterio', 'monastery', 'kloster', 'cartoixa', 'cartuja', 'charterhouse', 'kartause', 'convent', 'convento', 'konvent'],
  sanctuary: ['santuari', 'santuario', 'sanctuary', 'heiligtum', 'wallfahrtskirche', 'ermita', 'hermitage', 'einsiedelei'],
  castle: ['castell', 'castillo', 'castle', 'burg', 'schloss', 'festung', 'fortalesa', 'fortaleza'],
  church: ['esglesia', 'iglesia', 'church', 'kirche', 'parroquia', 'pfarrkirche', 'basilica', 'basilika'],
  museum: ['museu', 'museo', 'museum'],
  palace: ['palau', 'palacio', 'palace', 'palast'],
  lighthouse: ['far', 'faro', 'lighthouse', 'leuchtturm'],
  tower: ['torre', 'tower', 'turm'],
  market: ['mercat', 'mercado', 'market', 'markt', 'markthalle'],
  garden: ['jardi', 'jardin', 'jardines', 'garden', 'gardens', 'garten', 'gaerten'],
  cave: ['coves', 'cova', 'cuevas', 'cueva', 'caves', 'cave', 'hoehle', 'hoehlen', 'drachenhoehlen'],
};
const CANON = new Map(Object.entries(SAME).flatMap(([k, list]) => list.map((w) => [w, k])));
const GENERIC = new Set(Object.keys(SAME));
const STOP = new Set(['de', 'del', 'dels', 'des', 'la', 'las', 'les', 'el', 'els', 'los', 'es', 'sa', 'ses', 'son', 'can', 'the', 'of', 'von', 'der', 'die', 'das', 'und', 'and', 'i', 'y', 'mallorca', 'majorca', 'palma', 'illes', 'balears', 'santa', 'sant', 'san', 'maria']);
const norm = (s) => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !STOP.has(x)).map((x) => CANON.get(x) || x));

// Wie gut passt der Artikeltitel zum Ortsnamen? Eigennamen zählen doppelt, allgemeine Begriffe einfach
function nameScore(place, title) {
  const a = words(place);
  let score = 0;
  for (const w of words(title)) if (a.has(w)) score += GENERIC.has(w) ? 1 : 2;
  return score;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const api = (lang, params) => getJson(`https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ ...params, format: 'json', origin: '*' })}`);

async function nearby(lang, p) {
  const geo = await api(lang, { action: 'query', list: 'geosearch', gscoord: `${p.lat}|${p.lng}`, gsradius: RADIUS_M, gslimit: 30 });
  return (geo.query?.geosearch || []).map((h) => ({ lang, title: h.title, m: haversineKm(p.lat, p.lng, h.lat, h.lon) * 1000 }));
}

// Deutscher oder englischer Artikel zum selben Thema (Sprachlinks), sonst null
async function translated(hit) {
  for (const target of ['de', 'en']) {
    if (target === hit.lang) return null;
    try {
      const r = await api(hit.lang, { action: 'query', prop: 'langlinks', titles: hit.title, lllang: target });
      const page = Object.values(r.query?.pages || {})[0];
      const title = page?.langlinks?.[0]?.['*'];
      if (title) return { lang: target, title };
    } catch { /* dann eben der gefundene Artikel */ }
  }
  return null;
}

async function summary(lang, title) {
  const s = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
  if (!s.extract || s.type === 'disambiguation') return null;
  return {
    title: String(s.title || title).slice(0, 200),
    extract: String(s.extract).slice(0, 600),
    img: /^https:\/\/upload\.wikimedia\.org\//.test(s.thumbnail?.source || '') ? s.thumbnail.source : '',
    url: s.content_urls?.mobile?.page || s.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    lang,
  };
}

// Laden und merken. Rückgabe wie cachedWiki. Ist Wikipedia nicht erreichbar, wird geworfen (nichts gemerkt).
export async function loadWiki(p) {
  if (!hasCoords(p)) return null;
  const results = await Promise.allSettled(LANGS.map((lang) => nearby(lang, p)));
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
  const hits = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  // 1. Passender Name (beste Übereinstimmung, dann Sprache de > en > es > ca, dann am nächsten)
  const named = hits
    .map((h) => ({ ...h, score: nameScore(p.name, h.title) }))
    .filter((h) => h.score >= 2 || (h.score === 1 && h.m <= GENERIC_MAX_M))
    .sort((a, b) => b.score - a.score || LANGS.indexOf(a.lang) - LANGS.indexOf(b.lang) || a.m - b.m);
  // 2. Sonst der nächste Artikel ganz nah am Ort (deutsch bevorzugt)
  const near = hits.filter((h) => h.m <= NEAREST_M && ['de', 'en'].includes(h.lang))
    .sort((a, b) => LANGS.indexOf(a.lang) - LANGS.indexOf(b.lang) || a.m - b.m);
  const hit = named[0] || near[0];
  let v = null;
  if (hit) {
    const better = ['es', 'ca'].includes(hit.lang) ? await translated(hit) : null;
    v = (better && await summary(better.lang, better.title).catch(() => null)) || await summary(hit.lang, hit.title);
  }
  remember(p, v);
  return v;
}
