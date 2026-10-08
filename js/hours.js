// Öffnungszeiten (aus OpenStreetMap, sonst von Google Places), kompakt am Ort gespeichert:
//   { p: [[Tag, Minute, Tag, Minute], …] | null, w: ['Montag: 08:00–20:00', …], at: 'JJJJ-MM-TT', s?: 'osm' }
// p: Öffnungszeiträume – Tag 0 = Sonntag (wie Date.getDay), Minute = Minuten seit Mitternacht. Schliesstag
//    und -minute null = rund um die Uhr geöffnet. p = null: Google kennt keine Öffnungszeiten (Strand, Aussicht …)
// w: Googles Texte je Wochentag, Montag zuerst (für die Anzeige „Heute: …“)
// at: Abrufdatum – nach HOURS_MAX_AGE_DAYS wird neu abgefragt
// s: Quelle 'osm' (siehe osm-hours.js); fehlt = Google
// Alle Zeiten gelten in der Ortszeit des Geräts – auf Mallorca wie in der Schweiz dieselbe Zeitzone.

export const HOURS_MAX_AGE_DAYS = 30;
const WEEK = 7 * 1440;
const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const today = () => new Date().toLocaleDateString('sv-SE');

// regularOpeningHours aus der Maps JavaScript API (Place) → gespeichertes Format
export function hoursFromGoogle(oh) {
  const periods = Array.isArray(oh?.periods) ? oh.periods : [];
  const p = periods
    .filter((x) => x?.open)
    .map(({ open, close }) => [open.day, open.hour * 60 + (open.minute || 0), close ? close.day : null, close ? close.hour * 60 + (close.minute || 0) : null]);
  return sanitizeHours({ p: p.length ? p : null, w: oh?.weekdayDescriptions || [], at: today() });
}

// Werte aus Datenbank oder Backup absichern; ungültig → null
export function sanitizeHours(h) {
  if (!h || typeof h !== 'object') return null;
  const okDay = (d) => Number.isInteger(d) && d >= 0 && d <= 6;
  const okMin = (m) => Number.isInteger(m) && m >= 0 && m < 1440;
  const p = Array.isArray(h.p)
    ? h.p.filter((x) => Array.isArray(x) && okDay(x[0]) && okMin(x[1]) && ((x[2] === null && x[3] === null) || (okDay(x[2]) && okMin(x[3]))))
      .slice(0, 50).map((x) => x.slice(0, 4))
    : null;
  return {
    p: p?.length ? p : null,
    w: (Array.isArray(h.w) ? h.w : []).slice(0, 7).map((s) => String(s).slice(0, 120)),
    at: /^\d{4}-\d{2}-\d{2}$/.test(h.at || '') ? h.at : '',
    ...(h.s === 'osm' ? { s: 'osm' } : {}),
  };
}

// Muss neu abgefragt werden? (nie abgefragt oder älter als HOURS_MAX_AGE_DAYS)
export function hoursStale(h) {
  if (!h?.at) return true;
  return (Date.now() - Date.parse(`${h.at}T00:00:00`)) / 86400000 > HOURS_MAX_AGE_DAYS;
}

const weekMinute = (d) => d.getDay() * 1440 + d.getHours() * 60 + d.getMinutes();

// Geöffnet zum Zeitpunkt d? true / false; null = unbekannt
export function openAt(h, d = new Date()) {
  if (!h?.p?.length) return null;
  const t = weekMinute(d);
  for (const [od, om, cd, cm] of h.p) {
    if (cd === null) return true;
    const o = od * 1440 + om;
    let c = cd * 1440 + cm;
    if (c <= o) c += WEEK; // über das Wochenende (Sa → So)
    if ((t >= o && t < c) || (t + WEEK >= o && t + WEEK < c)) return true;
  }
  return false;
}

// Minuten bis zum nächsten Schliessen (open) bzw. Öffnen (!open); null = rund um die Uhr / unbekannt
function minutesToChange(h, d, open) {
  const t = weekMinute(d);
  let best = Infinity;
  for (const [od, om, cd, cm] of h.p) {
    if (cd === null) continue;
    let delta = (open ? cd * 1440 + cm : od * 1440 + om) - t;
    while (delta <= 0) delta += WEEK;
    if (delta < best) best = delta;
  }
  return Number.isFinite(best) ? best : null;
}

const hhmm = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

// Kurzer Status für Liste und Detailfenster: { open, text } oder null (unbekannt)
//   „Offen bis 22:00“ · „Rund um die Uhr offen“ · „Geschlossen · öffnet 17:00“ / „… morgen 09:00“ / „… Mo 09:00“
export function hoursStatus(h, d = new Date()) {
  const open = openAt(h, d);
  if (open === null) return null;
  const mins = minutesToChange(h, d, open);
  if (mins === null) return { open: true, text: 'Rund um die Uhr offen' };
  const at = new Date(d.getTime() + mins * 60000);
  if (open) return { open: true, text: `Offen bis ${hhmm(at)}` };
  const dayDiff = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  const when = dayDiff === 0 ? '' : dayDiff === 1 ? 'morgen ' : `${DAYS[at.getDay()]} `;
  return { open: false, text: `Geschlossen · öffnet ${when}${hhmm(at)}` };
}

// Googles Text für den Wochentag von d ohne Tagesnamen: „08:00–20:00“ (leer, wenn unbekannt)
export function hoursToday(h, d = new Date()) {
  const line = h?.w?.[(d.getDay() + 6) % 7]; // w beginnt montags
  return line ? line.replace(/^[^:]+:\s*/, '') : '';
}
