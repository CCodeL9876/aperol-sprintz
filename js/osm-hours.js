// Öffnungszeiten zuerst aus OpenStreetMap (Overpass, kostenlos, ohne Schlüssel) – Google wird danach nur noch
// für die Orte gefragt, die hier fehlen (spart die teure Places-Textsuche, siehe lookupHours in map-google.js).
// Übermittelt werden nur die Koordinaten der Orte. Ein OSM-Eintrag zählt, wenn er höchstens MATCH_M neben dem
// Ort liegt und der Name passt (oder er als einziger ganz nah liegt). Das Feld opening_hours wird nur in seiner
// gängigen Form gelesen („Mo-Fr 08:00-20:00; Sa 09:00-14:00; Su off“, „24/7“); Sonderfälle (Monate,
// Sonnenuntergang, Kommentare …) überlassen wir Google.

import { OVERPASS_ENDPOINTS } from './pois.js';
import { haversineKm } from './geo.js';
import { sanitizeHours } from './hours.js';

const MATCH_M = 60;
const NEAR_M = 25; // so nah reicht auch ohne passenden Namen, wenn es der einzige Eintrag ist
const BATCH = 40; // Orte pro Overpass-Abfrage

const DAY_IDX = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const DAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const UNSUPPORTED = /\|\||"|sunrise|sunset|dawn|dusk|week|easter|\[|\+|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\b\d{4}\b/i;

const today = () => new Date().toLocaleDateString('sv-SE');
const pad = (m) => m === 1440 ? '24:00' : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// „Mo-Fr,Su“ → [1, 2, 3, 4, 5, 0] oder null, wenn es keine Tagesangabe ist
function parseDays(sel) {
  const days = [];
  for (const part of sel.split(',')) {
    const m = part.match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
    if (!m) return null;
    const a = DAY_IDX[m[1]];
    const b = m[2] ? DAY_IDX[m[2]] : a;
    // Mo=1 … Sa=6, So=0 – „Sa-Mo“ läuft über das Wochenende
    const order = [1, 2, 3, 4, 5, 6, 0];
    let i = order.indexOf(a);
    for (;;) {
      days.push(order[i]);
      if (order[i] === b) break;
      i = (i + 1) % 7;
    }
  }
  return days;
}

// „08:00-13:00,16:00-20:00“ → [[480, 780], [960, 1200]] oder null
function parseTimes(str) {
  const out = [];
  for (const part of str.split(',')) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const s = +m[1] * 60 + +m[2];
    const e = +m[3] * 60 + +m[4];
    if (s >= 1440 || e > 1440 || m[2] > 59 || m[4] > 59) return null;
    out.push([s, e]);
  }
  return out;
}

// opening_hours aus OSM → gespeichertes Format (siehe hours.js) oder null, wenn nicht lesbar
export function hoursFromOsm(value) {
  const text = String(value || '').trim();
  if (!text || UNSUPPORTED.test(text)) return null;
  if (text === '24/7') return sanitizeHours({ p: [[0, 0, null, null]], w: DAY_NAMES.slice(1).concat(DAY_NAMES[0]).map((d) => `${d}: 24 Stunden geöffnet`), at: today(), s: 'osm' });
  const perDay = Array.from({ length: 7 }, () => []);
  let any = false;
  for (const raw of text.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;
    if (/^(PH|SH)\b/.test(rule)) continue; // Feiertage/Schulferien: kennt die App nicht
    const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)?\s*(.*)$/);
    const days = m[1] ? parseDays(m[1].replace(/,$/, '')) : [0, 1, 2, 3, 4, 5, 6];
    const rest = m[2].replace(/^,?\s*PH\s*/, '').trim();
    if (!days) return null;
    if (/^(off|closed)$/i.test(rest)) {
      for (const d of days) perDay[d] = [];
    } else {
      const times = parseTimes(rest);
      if (!times) return null;
      for (const d of days) perDay[d] = times; // spätere Regel ersetzt frühere (wie in OSM)
    }
    any = true;
  }
  if (!any) return null;
  const p = [];
  perDay.forEach((times, d) => {
    for (const [s, e] of times) {
      // bis Mitternacht oder darüber hinaus: Schliessen am Folgetag
      if (e > s && e < 1440) p.push([d, s, d, e]);
      else p.push([d, s, (d + 1) % 7, e % 1440]);
    }
  });
  const w = [1, 2, 3, 4, 5, 6, 0].map((d) => `${DAY_NAMES[d]}: ${perDay[d].length
    ? perDay[d].map(([s, e]) => `${pad(s)}–${pad(e)}`).join(', ')
    : 'Geschlossen'}`);
  return sanitizeHours({ p: p.length ? p : null, w, at: today(), s: 'osm' });
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set(['cafe', 'caffe', 'bar', 'restaurant', 'restaurante', 'can', 'cas', 'sa', 'ses', 'es', 'els', 'la', 'las', 'les', 'el', 'los', 'de', 'del', 'des', 'dels', 'the', 'und', 'and', 'i', 'y']);
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((x) => x.length >= 3 && !STOP.has(x));
function sameName(a, b) {
  const wb = new Set(words(b));
  return words(a).some((x) => wb.has(x));
}

async function overpass(query) {
  let lastError = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).elements || [];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass nicht erreichbar');
}

// Öffnungszeiten aus OSM für die Orte. Rückgabe: Map Orts-ID → hours (nur gefundene und lesbare)
export async function lookupOsmHours(places) {
  const found = new Map();
  for (let i = 0; i < places.length; i += BATCH) {
    const part = places.slice(i, i + BATCH);
    const around = part.map((p) => `nwr(around:${MATCH_M},${p.lat.toFixed(6)},${p.lng.toFixed(6)})["opening_hours"];`).join('');
    const elements = await overpass(`[out:json][timeout:25];(${around});out center tags;`);
    const items = elements.map((el) => ({
      name: el.tags?.name || '',
      hours: el.tags?.opening_hours || '',
      lat: el.lat ?? el.center?.lat,
      lng: el.lon ?? el.center?.lon,
    })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng));
    for (const p of part) {
      const near = items
        .map((x) => ({ ...x, m: haversineKm(p.lat, p.lng, x.lat, x.lng) * 1000 }))
        .filter((x) => x.m <= MATCH_M)
        .sort((a, b) => a.m - b.m);
      const hit = near.find((x) => sameName(p.name, x.name)) || (near.length === 1 && near[0].m <= NEAR_M ? near[0] : null);
      const hours = hit && hoursFromOsm(hit.hours);
      if (hours?.p) found.set(p.id, hours);
    }
  }
  return found;
}
