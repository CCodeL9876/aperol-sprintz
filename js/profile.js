// Höhenprofil einer Etappe: Fläche über der Strecke (Höhe über Kilometer), dünne Hilfslinien, Fadenkreuz mit
// Wert beim Darüberfahren bzw. Wischen. Beim Planen und in den aufgeklappten Etappen-Details (app.js).
// Gezeichnet als SVG, das sich der Breite anpasst; Beschriftungen als HTML darüber, damit sie nicht mitgestreckt werden.

import { haversineKm, formatKm } from './geo.js';
import { gradeClass } from './climbs.js';

const MAX_POINTS = 300; // genug für eine glatte Linie, wenig Arbeit beim Zeichnen
const VIEW_W = 1000; // Breite der SVG-Zeichenfläche (wird auf die echte Breite gestreckt)

// Streckenpunkte [lat, lon, ele|null] → { pts: [{ km, ele, lat, lng }], km, min, max } oder null ohne Höhen
export function elevationProfile(track) {
  if (!Array.isArray(track) || track.length < 2) return null;
  const all = [];
  let km = 0;
  for (let i = 0; i < track.length; i++) {
    if (i) km += haversineKm(track[i - 1][0], track[i - 1][1], track[i][0], track[i][1]);
    if (Number.isFinite(track[i][2])) all.push({ km, ele: track[i][2], lat: track[i][0], lng: track[i][1] });
  }
  // Zu wenige Höhenwerte (Datei ohne <ele>): kein Profil
  if (all.length < 2 || all.length < track.length * 0.5) return null;
  // Gleichmäßig über die Strecke ausdünnen
  const pts = [];
  const step = km / MAX_POINTS;
  let next = 0;
  for (const p of all) {
    if (p.km >= next) { pts.push(p); next = p.km + step; }
  }
  if (pts.at(-1) !== all.at(-1)) pts.push(all.at(-1));
  const eles = pts.map((p) => p.ele);
  return { pts, km, min: Math.min(...eles), max: Math.max(...eles) };
}

// „Schöne“ Schrittweite für Achsen: höchstens `count` Schritte
function niceStep(range, count, steps) {
  return steps.find((s) => range / s <= count) || steps.at(-1);
}

function scale(profile) {
  const yStep = niceStep(Math.max(1, profile.max - profile.min), 3, [25, 50, 100, 200, 250, 500, 1000]);
  const lo = Math.floor(profile.min / yStep) * yStep;
  // Oben nicht auf die nächste runde Zahl aufrunden (das ließe viel Leerraum) – knapp über dem höchsten Punkt enden
  const hi = Math.max(lo + yStep * 0.5, profile.max + (profile.max - lo) * 0.06);
  return { lo, hi, yStep };
}

const fmtM = (m) => `${Math.round(m).toLocaleString('de-DE')} m`;

// HTML des Diagramms. height in Pixeln; key landet in data-key (zum Wiederfinden beim Binden).
export function profileHtml(profile, { height = 90, key = '' } = {}) {
  const { lo, hi, yStep } = scale(profile);
  const x = (km) => (km / profile.km) * VIEW_W;
  const y = (ele) => height - ((ele - lo) / (hi - lo)) * height;
  const line = profile.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.km).toFixed(1)},${y(p.ele).toFixed(1)}`).join('');
  const area = `${line}L${VIEW_W},${height}L0,${height}Z`;
  // Steile Stücke bergauf farbig (gelb ab 5 %, rot ab 8 %, violett ab 10 %; Farben aus climbs.js)
  const pts = profile.pts;
  const steep = [];
  let run = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 2)];
    const pct = b.km > a.km ? ((b.ele - a.ele) / ((b.km - a.km) * 1000)) * 100 : 0;
    const c = gradeClass(pct);
    if (c && run?.c === c) run.to = i + 1;
    else if (c) steep.push(run = { c, from: i, to: i + 1 });
    else run = null;
  }
  const steepSvg = steep.map(({ c, from, to }) => {
    const seg = pts.slice(from, to + 1).map((p, k) => `${k ? 'L' : 'M'}${x(p.km).toFixed(1)},${y(p.ele).toFixed(1)}`).join('');
    return `<path d="${seg}L${x(pts[to].km).toFixed(1)},${height}L${x(pts[from].km).toFixed(1)},${height}Z" fill="${c.color}" class="elev-steep"/>`
      + `<path d="${seg}" stroke="${c.color}" class="elev-steep-line"/>`;
  }).join('');
  const grid = [];
  const yLabels = [];
  // Niedrige Profile (Planer): nur unterste und oberste Linie beschriften, sonst stehen die Zahlen übereinander
  const labelAll = height >= 70;
  for (let v = lo; v <= hi + 0.1; v += yStep) {
    const top = y(v);
    if (v > lo) grid.push(`<path d="M0,${top.toFixed(1)}H${VIEW_W}" class="elev-grid"/>`);
    if (labelAll || v === lo || v + yStep > hi + 0.1) yLabels.push(`<span class="elev-y" style="top:${((top / height) * 100).toFixed(1)}%">${v.toLocaleString('de-DE')}</span>`);
  }
  const kmStep = niceStep(profile.km, 4, [1, 2, 5, 10, 20, 25, 50, 100]);
  const xLabels = [];
  for (let k = kmStep; k < profile.km - kmStep * 0.4; k += kmStep) {
    xLabels.push(`<span class="elev-x" style="left:${((k / profile.km) * 100).toFixed(1)}%">${k}</span>`);
  }
  xLabels.push(`<span class="elev-x is-end" style="left:100%">${formatKm(profile.km)}</span>`);
  const label = `Höhenprofil: ${formatKm(profile.km)}, tiefster Punkt ${fmtM(profile.min)}, höchster Punkt ${fmtM(profile.max)}`;
  return `<div class="elev" data-key="${key}" style="--elev-h:${height}px" role="img" aria-label="${label}">
    <div class="elev-plot">
      <svg viewBox="0 0 ${VIEW_W} ${height}" preserveAspectRatio="none" aria-hidden="true">
        ${grid.join('')}
        <path d="${area}" class="elev-area"/>
        <path d="${line}" class="elev-line"/>
        ${steepSvg}
        <path d="M0,${height}H${VIEW_W}" class="elev-base"/>
      </svg>
      ${yLabels.join('')}
      <span class="elev-cross" hidden></span>
      <span class="elev-dot" hidden></span>
      <span class="elev-tip" hidden></span>
    </div>
    <div class="elev-xaxis" aria-hidden="true">${xLabels.join('')}</div>
  </div>`;
}

// Fadenkreuz: nächster Punkt zur Zeigerposition, Wert im Hinweis; onHover(punkt | null) z. B. für den Kartenpunkt
export function bindProfile(el, profile, onHover) {
  const plot = el.querySelector('.elev-plot');
  const cross = el.querySelector('.elev-cross');
  const dot = el.querySelector('.elev-dot');
  const tip = el.querySelector('.elev-tip');
  const { lo, hi } = scale(profile);
  const hide = () => {
    cross.hidden = dot.hidden = tip.hidden = true;
    onHover?.(null);
  };
  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    const km = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * profile.km;
    // Binäre Suche nach dem nächsten Punkt
    const pts = profile.pts;
    let a = 0;
    let b = pts.length - 1;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (pts[m].km < km) a = m; else b = m;
    }
    const p = km - pts[a].km < pts[b].km - km ? pts[a] : pts[b];
    const left = (p.km / profile.km) * 100;
    const top = (1 - (p.ele - lo) / (hi - lo)) * 100;
    cross.style.left = dot.style.left = `${left}%`;
    dot.style.top = `${top}%`;
    tip.textContent = `${formatKm(p.km)} · ${fmtM(p.ele)}`;
    // Hinweis neben dem Fadenkreuz, am Rand nach innen
    tip.style.left = `${left}%`;
    tip.style.transform = left > 70 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)';
    cross.hidden = dot.hidden = tip.hidden = false;
    onHover?.(p);
  });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('pointercancel', hide);
}
