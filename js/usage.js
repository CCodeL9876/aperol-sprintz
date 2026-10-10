// Google-Verbrauch mitzählen (Admin → „Google-Verbrauch“): Jede Google-Abfrage der App zählt hier je Preisstufe
// (SKU) und Monat. In einer gemeinsamen Reise landen die Zähler gesammelt in Supabase (alle Geräte zusammen,
// siehe google_usage in supabase/schema.sql), sonst nur im Browser dieses Geräts.
// Es ist eine Schätzung: Was nicht über diese App läuft (Tests, andere Projekte mit demselben Schlüssel), fehlt.
// Genaue Zahlen und Kosten nur in der Google Cloud Console.

import { readPref, writePref } from './store.js';

// Preisstufen mit Gratis-Kontingent pro Monat und Preis pro 1'000 darüber (USD) – laut Google-Preisliste
// (Stand 2025, ohne Gewähr; https://developers.google.com/maps/billing-and-pricing/pricing)
export const SKUS = {
  maps: { label: 'Karte laden', note: 'Dynamic Maps', free: 10000, usd: 7 },
  autocomplete: { label: 'Suchvorschläge (Lupe)', note: 'Autocomplete Requests', free: 10000, usd: 2.83 },
  nearby: { label: 'Cafés · Bars · Essen', note: 'Nearby Search Enterprise (mit Bewertung)', free: 1000, usd: 35 },
  textPro: { label: 'GF-Suche', note: 'Text Search Pro', free: 5000, usd: 32 },
  textHours: { label: 'Öffnungszeiten laden', note: 'Text Search Enterprise', free: 1000, usd: 35 },
  details: { label: 'Ort-Details', note: 'Place Details Enterprise', free: 1000, usd: 20 },
  detailsReviews: { label: 'Ort-Details mit Bewertungen (GF)', note: 'Place Details Enterprise + Atmosphere', free: 1000, usd: 25 },
  routes: { label: 'Route (Auto, mit Verkehr)', note: 'Compute Routes Pro', free: 5000, usd: 10 },
  routesBasic: { label: 'Route (zu Fuss, ÖV)', note: 'Compute Routes Essentials', free: 10000, usd: 5 },
  matrix: { label: 'Strecken-km zum Airbnb', note: 'Route Matrix Essentials (je Ziel)', free: 10000, usd: 5 },
};

const PREF = 'googleUsage';
const FLUSH_MS = 8000;

// Google rechnet nach Kalendermonat in Pazifik-Zeit
export function usageMonth(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

let sink = null; // async (counts) => void – Supabase; null = nur lokal
let pending = {};
let timer = null;

// Gemeinsame Reise: Zähler an die Datenbank schicken. null = nur lokal im Browser zählen.
export function setUsageSink(fn) {
  sink = fn;
}

function addLocal(counts) {
  const all = readPref(PREF) || {};
  const m = usageMonth();
  const month = all[m] || {};
  for (const [k, n] of Object.entries(counts)) month[k] = (month[k] || 0) + n;
  // nur die letzten 3 Monate behalten
  const keep = Object.keys({ ...all, [m]: month }).sort().slice(-3);
  writePref(PREF, Object.fromEntries(keep.map((k) => [k, k === m ? month : all[k]])));
}

async function flush() {
  timer = null;
  const counts = pending;
  pending = {};
  if (!Object.keys(counts).length) return;
  if (!sink) return addLocal(counts);
  try {
    await sink(counts);
  } catch (err) {
    // Datenbank-Funktion fehlt (SQL noch nicht ausgeführt): ab jetzt lokal zählen; sonst später erneut senden
    if (err?.missing) {
      sink = null;
      addLocal(counts);
      return;
    }
    for (const [k, n] of Object.entries(counts)) pending[k] = (pending[k] || 0) + n;
    timer ??= setTimeout(flush, FLUSH_MS * 4);
  }
}

// Eine (oder n) Google-Abfragen zählen
export function countGoogle(sku, n = 1) {
  if (!SKUS[sku] || !(n > 0)) return;
  pending[sku] = (pending[sku] || 0) + n;
  timer ??= setTimeout(flush, FLUSH_MS);
}

// Beim Verlassen der Seite noch senden (so gut es geht)
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && timer) {
    clearTimeout(timer);
    flush();
  }
});

// Lokale Zähler: { "2026-10": { sku: n } } – plus noch nicht gesendete
export function localUsage() {
  const all = { ...(readPref(PREF) || {}) };
  const m = usageMonth();
  if (Object.keys(pending).length) {
    all[m] = { ...(all[m] || {}) };
    for (const [k, n] of Object.entries(pending)) all[m][k] = (all[m][k] || 0) + n;
  }
  return all;
}

// Noch nicht gesendete Zähler (für die Anzeige zum Serverstand dazuzählen)
export const pendingUsage = () => ({ ...pending });

// Geschätzte Kosten eines Monats in USD (nur was über dem Gratis-Kontingent liegt)
export function usageCost(month) {
  let usd = 0;
  for (const [k, n] of Object.entries(month || {})) {
    const s = SKUS[k];
    if (s) usd += (Math.max(0, n - s.free) / 1000) * s.usd;
  }
  return usd;
}
