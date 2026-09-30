// Speicher im Browser (localStorage):
//  - lokale Orte, Airbnb und eigene Kategorien (wenn keine gemeinsame Reise aktiv ist)
//  - Anzeige-Einstellungen (Filter, Sortierung) – immer pro Gerät
//  - kleine Vorlieben wie der eigene Name oder der zuletzt geöffnete Reise-Schlüssel

const DATA_KEY = 'llocs.v1';
const UI_KEY = 'llocs.ui';
const BACKUP_KEY = 'llocs.v1.backup';

const DEFAULT_UI = { categories: [], search: '', sort: 'distance', visibleRoutes: [] };

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadLocalData() {
  const saved = read(DATA_KEY) || {};
  return {
    places: Array.isArray(saved.places) ? saved.places : [],
    routes: Array.isArray(saved.routes) ? saved.routes : [],
    airbnb: saved.airbnb || null,
    customCategories: Array.isArray(saved.customCategories) ? saved.customCategories : [],
    flights: saved.flights && typeof saved.flights === 'object' ? saved.flights : {},
  };
}

// Schrumpft die Liste, wird der bisherige Stand vorher als Sicherung abgelegt (siehe loadLocalBackup).
export function saveLocalData({ places, routes, airbnb, customCategories, flights }) {
  const previous = read(DATA_KEY);
  const prevCount = Array.isArray(previous?.places) ? previous.places.length : 0;
  if (prevCount > places.length) write(BACKUP_KEY, { ...previous, savedAt: new Date().toISOString() });
  return write(DATA_KEY, { places, routes, airbnb, customCategories, flights });
}

export function loadLocalBackup() {
  const backup = read(BACKUP_KEY);
  return backup && Array.isArray(backup.places) && backup.places.length ? backup : null;
}

export const clearLocalBackup = () => write(BACKUP_KEY, null);

export function loadUi() {
  // Ältere Versionen haben die Filter mit in DATA_KEY gespeichert.
  const legacy = read(DATA_KEY)?.ui;
  return { ...DEFAULT_UI, ...legacy, ...read(UI_KEY) };
}

export const saveUi = (ui) => write(UI_KEY, ui);

export const readPref = (name) => read(`llocs.${name}`);
export const writePref = (name, value) => write(`llocs.${name}`, value);

export function downloadBackup(state) {
  const data = {
    app: 'llocs',
    version: 1,
    exportedAt: new Date().toISOString(),
    airbnb: state.airbnb,
    customCategories: state.customCategories,
    flights: state.flights,
    places: state.places,
    routes: state.routes,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aperol-sprintz-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// UUID v4. crypto.randomUUID gibt es nur über HTTPS/localhost – im WLAN-Test (http://192.168…)
// fehlt es, getRandomValues ist dagegen überall verfügbar.
export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Zufälliger, nicht erratbarer Schlüssel für eine gemeinsame Reise (40 Hex-Zeichen = 160 Bit).
export function newTripKey() {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
