// Garmin-Strecke als TCX („Course“) – für „Für Garmin“. Anders als Wegpunkte in einer GPX übernimmt Garmin
// Connect hier die Streckenpunkte (Kaffee, Wasser …) zuverlässig: Sie stecken als „CoursePoint“ mit Typ und
// Kilometer ab Start in der Strecke selbst, und das Gerät kündigt sie unterwegs an. Distanzen werden auf der
// vollen Strecke gerechnet (auch wenn für die Datei Punkte ausgedünnt werden), Zeiten aus dem gewählten Tempo –
// TCX verlangt sie, Garmin nutzt sie für den virtuellen Partner. Namen kürzt das Format (Strecke 15, Punkt 10 Zeichen).

import { haversineKm } from './geo.js';

const MAX_TRACKPOINTS = 6000; // Garmin dünnt ohnehin aus; hält die Datei klein
const SNAP_M = 300; // Streckenpunkte weiter weg von der Strecke weglassen

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
// Auf n Zeichen kürzen – möglichst an einer Wortgrenze („Testrunde mit sehr …“ → „Testrunde mit“)
function short(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return (space >= n / 2 ? cut.slice(0, space) : cut).trim();
}
// Name auf dem Gerät (höchstens 10 Zeichen): Wasser/Velo als Wort, sonst ohne „Café“, „Bar“ … vorne
function deviceName(p) {
  if (p.type === 'Water') return 'Wasser';
  if (p.kind === 'bike') return 'Velo';
  const t = String(p.name || '').replace(/^(café|cafe|cafè|caffè|bar|restaurant|forn|pastisseria)\s+/i, '').trim();
  return short(t || p.name, 10);
}
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const pos = (lat, lng) => `<Position><LatitudeDegrees>${lat}</LatitudeDegrees><LongitudeDegrees>${lng}</LongitudeDegrees></Position>`;

// track: [[lat, lng, ele|null]] in voller Auflösung; points: [{ name, lat, lng, type: 'Food'|'Water'|'Generic', kind? }]
// (kind 'bike' = Velo-Werkstatt)
export function buildTcx(name, track, points = [], speedKmh = 25) {
  const n = track.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversineKm(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]) * 1000;
  const total = n ? cum[n - 1] : 0;
  const mps = Math.max(5, speedKmh) / 3.6;
  const start = Date.now();
  const timeAt = (i) => start + (cum[i] / mps) * 1000;

  // Höhen: Lücken vom Nachbarpunkt füllen (wie in der GPX)
  const eles = track.map((p) => (Number.isFinite(p[2]) ? p[2] : null));
  if (eles.some((e) => e !== null)) {
    for (let i = 1; i < n; i++) if (eles[i] === null) eles[i] = eles[i - 1];
    for (let i = n - 2; i >= 0; i--) if (eles[i] === null) eles[i] = eles[i + 1];
  }

  // Streckenpunkte auf den nächsten Punkt der Strecke legen (flach genähert – auf Inselgröße genau genug)
  const kx = n ? 111320 * Math.cos((track[0][0] * Math.PI) / 180) : 111320;
  const ky = 110540;
  const course = [];
  for (const p of points) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = (track[i][1] - p.lng) * kx;
      const dy = (track[i][0] - p.lat) * ky;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && Math.sqrt(bestD) <= SNAP_M) course.push({ ...p, i: best });
  }
  course.sort((a, b) => a.i - b.i);

  // Ausdünnen für die Datei: gleichmäßig, Start und Ziel und die Stellen der Streckenpunkte immer behalten
  const keep = new Set([0, n - 1, ...course.map((c) => c.i)]);
  const step = n > MAX_TRACKPOINTS ? n / MAX_TRACKPOINTS : 1;
  for (let k = 0; k < n; k += step) keep.add(Math.floor(k));
  const idx = [...keep].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);

  const trackpoints = idx.map((i) => `        <Trackpoint>
          <Time>${iso(timeAt(i))}</Time>
          ${pos(track[i][0], track[i][1])}${eles[i] !== null ? `\n          <AltitudeMeters>${eles[i]}</AltitudeMeters>` : ''}
          <DistanceMeters>${cum[i].toFixed(1)}</DistanceMeters>
        </Trackpoint>`).join('\n');

  const coursePoints = course.map((c) => `      <CoursePoint>
        <Name>${esc(deviceName(c))}</Name>
        <Time>${iso(timeAt(c.i))}</Time>
        ${pos(track[c.i][0], track[c.i][1])}${eles[c.i] !== null ? `\n        <AltitudeMeters>${eles[c.i]}</AltitudeMeters>` : ''}
        <PointType>${c.type}</PointType>
        <Notes>${esc(c.name)} · km ${(cum[c.i] / 1000).toFixed(1)}</Notes>
      </CoursePoint>`).join('\n');

  const first = track[0] || [0, 0];
  const last = track[n - 1] || first;
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Courses>
    <Course>
      <Name>${esc(short(name, 15) || 'Etappe')}</Name>
      <Lap>
        <TotalTimeSeconds>${(total / mps).toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${total.toFixed(1)}</DistanceMeters>
        <BeginPosition><LatitudeDegrees>${first[0]}</LatitudeDegrees><LongitudeDegrees>${first[1]}</LongitudeDegrees></BeginPosition>
        <EndPosition><LatitudeDegrees>${last[0]}</LatitudeDegrees><LongitudeDegrees>${last[1]}</LongitudeDegrees></EndPosition>
        <Intensity>Active</Intensity>
      </Lap>
      <Track>
${trackpoints}
      </Track>
${coursePoints}
    </Course>
  </Courses>
</TrainingCenterDatabase>
`;
}
