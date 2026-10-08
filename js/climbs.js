// Steigungen und Anstiege einer Strecke [[lat, lng, ele|null]] – für die farbige Linie im Planer, das farbige
// Höhenprofil und die Liste der Anstiege (Länge, Höhenmeter, Durchschnitt). Gerechnet auf einer gleichmäßig
// alle STEP_KM nachgerechneten, leicht geglätteten Höhenlinie, damit einzelne Messfehler keine „20 %“ erzeugen.

import { haversineKm } from './geo.js';

const STEP_KM = 0.1;
// Steigungsklassen (in Fahrtrichtung bergauf): Farbe für Karte und Profil
export const GRADE_CLASSES = [
  { min: 10, cls: 'g10', color: '#5E1A6B', label: 'ab 10 %' },
  { min: 8, cls: 'g8', color: '#D92B2B', label: '8–10 %' },
  { min: 5, cls: 'g5', color: '#F4C430', label: '5–8 %' },
];
export const gradeClass = (pct) => GRADE_CLASSES.find((g) => pct >= g.min) || null;

// Gleichmäßig nachgerechnete Punkte: [{ km, lat, lng, ele }] (ele geglättet) oder null ohne Höhen
function resample(track) {
  if (!Array.isArray(track) || track.length < 2) return null;
  const withEle = track.filter((p) => Number.isFinite(p[2]));
  if (withEle.length < 2 || withEle.length < track.length * 0.5) return null;
  const pts = [];
  let km = 0;
  let prev = null;
  for (const p of track) {
    if (prev) km += haversineKm(prev[0], prev[1], p[0], p[1]);
    prev = p;
    if (Number.isFinite(p[2])) pts.push({ km, lat: p[0], lng: p[1], ele: p[2] });
  }
  const out = [];
  let j = 0;
  for (let k = 0; k <= km + 1e-9; k += STEP_KM) {
    while (j < pts.length - 2 && pts[j + 1].km < k) j++;
    const a = pts[j];
    const b = pts[Math.min(j + 1, pts.length - 1)];
    const t = b.km > a.km ? Math.min(1, Math.max(0, (k - a.km) / (b.km - a.km))) : 0;
    out.push({ km: k, lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, ele: a.ele + (b.ele - a.ele) * t });
  }
  // Höhen über ±2 Punkte (±200 m) glätten
  const raw = out.map((p) => p.ele);
  out.forEach((p, i) => {
    const w = raw.slice(Math.max(0, i - 2), i + 3);
    p.ele = w.reduce((s, v) => s + v, 0) / w.length;
  });
  return out;
}

// Steigung in % je nachgerechnetem Punkt (über ±150 m gemittelt)
function grades(rs) {
  return rs.map((_, i) => {
    const a = rs[Math.max(0, i - 1)];
    const b = rs[Math.min(rs.length - 1, i + 2)];
    const dkm = b.km - a.km;
    return dkm > 0 ? ((b.ele - a.ele) / (dkm * 1000)) * 100 : 0;
  });
}

// Steile Stücke als Linienzüge für die Karte: [{ cls, color, points: [[lat, lng]] }]
export function steepRuns(track) {
  const rs = resample(track);
  if (!rs) return [];
  const g = grades(rs);
  const runs = [];
  let cur = null;
  rs.forEach((p, i) => {
    const c = gradeClass(g[i]);
    if (c && cur?.cls === c.cls) {
      cur.points.push([p.lat, p.lng]);
    } else {
      if (cur) cur.points.push([p.lat, p.lng]); // lückenlos an das nächste Stück anschließen
      cur = c ? { cls: c.cls, color: c.color, points: [[p.lat, p.lng]] } : null;
      if (cur) runs.push(cur);
    }
  });
  return runs.filter((r) => r.points.length > 1);
}

// Anstiege: mindestens 40 Hm, 0,8 km und 3 % im Schnitt. Kurze Flachstücke oder Abfahrten (bis 10 Hm bzw. 10 % des
// bisherigen Anstiegs) unterbrechen nicht. Rückgabe: [{ startKm, endKm, km, gainM, avgPct, maxPct, top, points }]
export function findClimbs(track) {
  const rs = resample(track);
  if (!rs || rs.length < 3) return [];
  const climbs = [];
  let i = 0;
  while (i < rs.length - 1) {
    if (rs[i + 1].ele <= rs[i].ele) { i++; continue; }
    let start = i;
    let peak = i;
    let j = i;
    while (j < rs.length - 1) {
      j++;
      if (rs[j].ele > rs[peak].ele) { peak = j; continue; }
      const drop = rs[peak].ele - rs[j].ele;
      if (drop > Math.max(10, 0.1 * (rs[peak].ele - rs[start].ele)) || (j - peak) * STEP_KM > 1) break;
    }
    // Flaches Anlaufstück am Anfang abschneiden (unter 1 % auf 300 m)
    while (start + 3 < peak && rs[start + 3].ele - rs[start].ele < 3) start++;
    const gain = rs[peak].ele - rs[start].ele;
    const km = (peak - start) * STEP_KM;
    if (gain >= 40 && km >= 0.8 && (gain / (km * 1000)) * 100 >= 3) {
      // steilster halber Kilometer
      let maxPct = 0;
      for (let k = start; k + 5 <= peak; k++) maxPct = Math.max(maxPct, ((rs[k + 5].ele - rs[k].ele) / 500) * 100);
      climbs.push({
        startKm: rs[start].km,
        endKm: rs[peak].km,
        km,
        gainM: gain,
        avgPct: (gain / (km * 1000)) * 100,
        maxPct: Math.max(maxPct, (gain / (km * 1000)) * 100),
        top: [rs[peak].lat, rs[peak].lng],
        points: rs.slice(start, peak + 1).map((p) => [p.lat, p.lng]),
      });
    }
    i = Math.max(peak, start + 1);
  }
  return climbs;
}

// Name eines Anstiegs: eigener Ort (Rennrad-Hotspot, Aussicht …) nah an der Kuppe, sonst „Anstieg bei km …“
export function climbName(climb, places = []) {
  let best = null;
  let bestD = 0.5; // km
  for (const p of places) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const d = haversineKm(climb.top[0], climb.top[1], p.lat, p.lng);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best ? best.name : `Anstieg bei km ${Math.round(climb.startKm)}`;
}
