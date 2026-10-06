// Reisekasse: wer hat was bezahlt, wer profitiert, wer schuldet wem.
// Alle Beträge in Cent (Ganzzahlen) – so entstehen beim Aufteilen keine Rundungsfehler.
//
// Teilnehmende: [{ id, name }]
// Rechnung:     { id, title, amountCents, paidBy: id, sharedWith: [id, …], date: 'JJJJ-MM-TT' | '' }
//   amountCents ist immer der Euro-Betrag – darauf beruhen alle Rechnungen. Optional:
//   kind:  'transfer'                          Rückzahlung aus dem Ausgleich: paidBy hat sharedWith[0] überwiesen
//   orig:  { currency: 'CHF', cents, rate }    in Franken erfasst; rate = CHF pro € am Erfassungstag (bleibt fest)
//   split: { mode: 'shares'|'amounts', values: { id: Zahl } }   ungleich aufgeteilt: Anteile (z. B. 2 und 1)
//          oder Beträge in Cent/Rappen der Eingabewährung; ohne split gleichmässig

const EURO = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export const formatEuro = (cents) => EURO.format((cents || 0) / 100);
const FRANKEN = new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF' });
export const formatChf = (rappen) => FRANKEN.format((rappen || 0) / 100);

// Tageskurs EUR → CHF: EZB-Referenzkurs über api.frankfurter.dev (frei, ohne Schlüssel). Wird höchstens
// einmal pro Tag abgefragt und im Browser gemerkt; ohne Netz gilt der zuletzt bekannte Kurs.
// Ergebnis: { rate, date: 'JJJJ-MM-TT' (Stand EZB), fetched: 'JJJJ-MM-TT' (Abrufdatum) } oder null.
const FX_KEY = 'llocs.fx';
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CHF';

export function cachedRate() {
  try {
    const v = JSON.parse(localStorage.getItem(FX_KEY));
    return v && v.rate > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function loadRate() {
  const today = new Date().toLocaleDateString('sv-SE');
  const cached = cachedRate();
  if (cached?.fetched === today) return cached;
  try {
    const res = await fetch(FX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = Number(data?.rates?.CHF);
    if (!(rate > 0)) throw new Error('kein Kurs in der Antwort');
    const value = { rate, date: String(data.date || today), fetched: today };
    try { localStorage.setItem(FX_KEY, JSON.stringify(value)); } catch { /* privates Fenster */ }
    return value;
  } catch (err) {
    console.warn('Wechselkurs nicht abrufbar:', err.message);
    return cached;
  }
}

// Euro-Cent → Rappen zum gegebenen Kurs und zurück
export const toRappen = (cents, rate) => Math.round(cents * rate);
export const toEuroCents = (rappen, rate) => Math.round(rappen / rate);

export const isTransfer = (e) => e?.kind === 'transfer';
// Summe der Ausgaben ohne Rückzahlungen (die verschieben nur Geld zwischen Mitreisenden)
export const expenseTotal = (expenses) => expenses.reduce((sum, e) => sum + (isTransfer(e) ? 0 : e.amountCents), 0);

// Anteil für die ungleiche Aufteilung: „2“, „1,5“ → Zahl; ungültig oder ≤ 0 → null
export function parseShare(input) {
  const s = String(input || '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = parseFloat(s);
  return v > 0 && v <= 1000 ? v : null;
}

// „12,50“, „12.50“, „1.234,50“, „1'234.50“, „12“ → Cent; ungültig oder ≤ 0 → null
export function parseAmount(input) {
  let s = String(input || '').trim().replace(/[\s'’€]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Beide Zeichen: das hintere ist das Dezimaltrennzeichen, das andere Tausendertrennung
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else {
    s = s.replace(',', '.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents > 0 && cents <= 100000000 ? cents : null;
}

// Aufteilen, sodass die Summe der Anteile immer genau dem Betrag entspricht – gleichmässig oder nach
// Gewichten (weights, gleiche Reihenfolge wie ids). Übrige Cent (z. B. 10,01 € für 3) gehen reihum an
// einzelne Personen; wo die Reihe beginnt, hängt von der Rechnung ab (seed = Rechnungs-ID) – sonst trüge
// immer dieselbe Person den Extra-Cent. Gleichmässig ergibt das exakt dieselben Beträge wie früher.
const seedOffset = (seed, n) => [...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % n;
export function splitCents(amountCents, ids, seed = '', weights = null) {
  const shares = new Map();
  const n = ids.length;
  if (!n) return shares;
  const w = weights?.length === n && weights.some((x) => x > 0) ? weights : ids.map(() => 1);
  const total = w.reduce((a, b) => a + b, 0);
  const parts = w.map((x) => Math.floor((amountCents * x) / total));
  let rest = amountCents - parts.reduce((a, b) => a + b, 0);
  const start = rest ? seedOffset(seed, n) : 0;
  for (let k = 0; rest > 0 && k < 2 * n; k++) {
    const i = (start + k) % n;
    if (w[i] > 0) { parts[i]++; rest--; }
  }
  ids.forEach((id, i) => shares.set(id, parts[i]));
  return shares;
}

// Gewichte einer Rechnung für splitCents (ohne gültige ungleiche Aufteilung: alle gleich)
export function splitWeights(e) {
  const v = e.split?.values;
  if ((e.split?.mode === 'shares' || e.split?.mode === 'amounts') && v) {
    const w = e.sharedWith.map((id) => Math.max(0, Number(v[id]) || 0));
    if (w.some((x) => x > 0)) return w;
  }
  return e.sharedWith.map(() => 1);
}

// Euro-Anteil jeder Person an einer Rechnung: Map id → Cent
export const sharesOf = (e) => splitCents(e.amountCents, e.sharedWith, e.id, splitWeights(e));

// Pro Person: bezahlt, Anteil (was sie verbraucht hat), bereits überwiesene/erhaltene Ausgleichszahlungen
// und Saldo (+ bekommt Geld, − schuldet Geld). Personen, die in Rechnungen vorkommen, aber nicht mehr in
// der Liste stehen, erscheinen als „Unbekannt“.
export function computeBalances(expenses, participants) {
  const blank = (id, name) => ({ id, name, paid: 0, share: 0, sent: 0, received: 0 });
  const rows = new Map(participants.map((p) => [p.id, blank(p.id, p.name)]));
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, blank(id, 'Unbekannt'));
    return rows.get(id);
  };
  for (const e of expenses) {
    if (isTransfer(e)) {
      row(e.paidBy).sent += e.amountCents;
      row(e.sharedWith[0]).received += e.amountCents;
      continue;
    }
    row(e.paidBy).paid += e.amountCents;
    for (const [id, cents] of sharesOf(e)) row(id).share += cents;
  }
  return [...rows.values()].map((r) => ({ ...r, balance: r.paid - r.share + r.sent - r.received }));
}

// Ausgleich mit möglichst wenigen Überweisungen: jeweils wer am meisten schuldet zahlt an den,
// der am meisten zugute hat. Ergebnis: [{ from, to, cents }] mit Personen-IDs.
export function settle(balances) {
  const debtors = balances.filter((b) => b.balance < 0).map((b) => ({ id: b.id, cents: -b.balance }));
  const creditors = balances.filter((b) => b.balance > 0).map((b) => ({ id: b.id, cents: b.balance }));
  debtors.sort((a, b) => b.cents - a.cents);
  creditors.sort((a, b) => b.cents - a.cents);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const cents = Math.min(debtors[i].cents, creditors[j].cents);
    if (cents > 0) transfers.push({ from: debtors[i].id, to: creditors[j].id, cents });
    debtors[i].cents -= cents;
    creditors[j].cents -= cents;
    if (!debtors[i].cents) i++;
    if (!creditors[j].cents) j++;
  }
  return transfers;
}

// Werte aus Datenbank oder Backup absichern, bevor sie ins HTML gelangen
export function sanitizeParticipants(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && p.id && String(p.name || '').trim())
    .map((p) => ({ id: String(p.id).slice(0, 64), name: String(p.name).trim().slice(0, 30) }));
}

export function sanitizeExpense(e) {
  if (!e || !e.id) return null;
  const amountCents = Math.round(Number(e.amountCents));
  const sharedWith = (Array.isArray(e.sharedWith) ? e.sharedWith : []).map(String).filter(Boolean);
  if (!(amountCents > 0) || !e.paidBy || !sharedWith.length) return null;
  const out = {
    id: String(e.id),
    title: String(e.title || '').slice(0, 120),
    amountCents,
    paidBy: String(e.paidBy),
    sharedWith: [...new Set(sharedWith)],
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : '',
    addedBy: String(e.addedBy || '').slice(0, 80),
    addedAt: Number(e.addedAt) || 0,
  };
  if (e.kind === 'transfer' && out.sharedWith.length === 1) out.kind = 'transfer';
  const o = e.orig;
  if (o?.currency === 'CHF' && Number(o.cents) > 0 && Number(o.rate) > 0) {
    out.orig = { currency: 'CHF', cents: Math.round(Number(o.cents)), rate: Number(o.rate) };
  }
  const sp = e.split;
  if ((sp?.mode === 'shares' || sp?.mode === 'amounts') && sp.values && typeof sp.values === 'object') {
    const values = {};
    for (const id of out.sharedWith) {
      const v = Number(sp.values[id]);
      if (v > 0 && v < 1e9) values[id] = sp.mode === 'amounts' ? Math.round(v) : Math.round(v * 100) / 100;
    }
    if (Object.keys(values).length) out.split = { mode: sp.mode, values };
  }
  return out;
}
