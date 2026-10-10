// Glutenfrei bei Google-Orten (Schalter „GF“ unten auf der Karte, siehe map-google.js):
//  - Stichworte in Bewertungen erkennen (mehrsprachig) – mit Verneinung („no gluten free options“ zählt nicht)
//  - OpenStreetMap: Orte mit diet:gluten_free=yes/only/limited im Kartenausschnitt (Overpass, kostenlos)
// Google selbst kennt kein Merkmal „glutenfrei“; die Textsuche („gluten free“ im Ausschnitt) macht map-google.js.

import { OVERPASS_ENDPOINTS } from './pois.js';

// Stichworte: Deutsch, Englisch, Spanisch, Katalanisch, Italienisch, Französisch (+ Zöliakie/celiac)
const KEYWORD = /gluten[\s-]*fre[ie]e?|gluten[\s-]*free|glutenfrei\w*|sin\s+gluten|sense\s+gluten|senza\s+glutine|sans\s+gluten|zöliak\w*|z[oö]liakie|coeliac\w*|celiac\w*|cel[ií]ac[oa]s?|\bGF\b/giu;
// Verneinung kurz davor: „no / not / keine / leider kein / sin opciones / without / nothing …“
const NEGATION = /\b(no|not|non|nothing|without|none|keine?[nrms]?|nicht|leider|ohne|ningun[oa]?|ningún|sense opcions|sin opciones|no hay|no tienen|didn'?t|doesn'?t|don'?t|wasn'?t|isn'?t|aren'?t|lack\w*|unfortunately)\b[^.!?]{0,30}$/iu;

// Textstellen mit Stichwort: [{ snippet, negative }] – snippet ist ein kurzer Ausschnitt rund um das Stichwort
export function gfMentions(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(KEYWORD)) {
    // „GF“ nur in Grossbuchstaben (sonst Treffer wie „gf“ in Kürzeln)
    if (/^gf$/i.test(m[0]) && m[0] !== 'GF') continue;
    const before = s.slice(Math.max(0, m.index - 40), m.index);
    const negative = NEGATION.test(before);
    const start = Math.max(0, m.index - 60);
    const end = Math.min(s.length, m.index + m[0].length + 60);
    out.push({
      snippet: `${start ? '… ' : ''}${s.slice(start, end).replace(/\s+/g, ' ').trim()}${end < s.length ? ' …' : ''}`,
      keyword: m[0],
      negative,
    });
  }
  return out;
}

// Bewertungen eines Google-Orts auswerten. reviews: [{ text, originalText, author }]
// Rückgabe: { positive: [{ snippet, keyword, author }], negative: Anzahl }
export function gfFromReviews(reviews) {
  const positive = [];
  let negative = 0;
  for (const r of reviews || []) {
    // Original und Übersetzung prüfen, aber je Bewertung höchstens einmal zählen
    const hits = [...gfMentions(r.originalText), ...gfMentions(r.text)];
    if (!hits.length) continue;
    const pos = hits.find((h) => !h.negative);
    if (pos) positive.push({ ...pos, author: r.author || '' });
    else negative++;
  }
  return { positive, negative };
}

// OpenStreetMap: Lokale mit glutenfreiem Angebot im Rechteck { south, west, north, east }.
// Rückgabe: [{ name, lat, lng, kind: 'cafe'|'bar'|'food', value: 'yes'|'only'|'limited' }]
const osmCache = new Map();
export async function osmGlutenFree(box) {
  const key = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(3)).join(',');
  if (osmCache.has(key)) return osmCache.get(key);
  const bbox = `${box.south.toFixed(5)},${box.west.toFixed(5)},${box.north.toFixed(5)},${box.east.toFixed(5)}`;
  const query = `[out:json][timeout:25];nwr["diet:gluten_free"~"^(yes|only|limited)$"]["amenity"~"^(cafe|restaurant|fast_food|bar|pub|ice_cream)$"](${bbox});out center tags;`;
  let lastError = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = ((await res.json()).elements || []).map((el) => {
        const t = el.tags || {};
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const kind = t.amenity === 'cafe' || t.amenity === 'ice_cream' ? 'cafe' : t.amenity === 'bar' || t.amenity === 'pub' ? 'bar' : 'food';
        return { name: String(t.name || '').slice(0, 120), lat, lng, kind, value: t['diet:gluten_free'] };
      }).filter(Boolean);
      osmCache.set(key, items);
      return items;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass nicht erreichbar');
}
