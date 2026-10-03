// Wo die Orte liegen:
//  - LocalBackend: nur in diesem Browser (localStorage)
//  - SharedBackend: gemeinsame Reise in Supabase; Zugriff nur mit dem geheimen Reise-Schlüssel,
//    der bei jeder Anfrage als Header "x-trip-key" mitgeht und von der Datenbank geprüft wird.
//
// Die App ändert zuerst ihren Zustand im Speicher und meldet die Änderung dann hier.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { loadLocalData, saveLocalData, readPref, writePref } from './store.js';

// Supabase-Bibliothek als feste Version im Projekt (statt „neueste 2.x“ vom CDN): So kann keine fremd
// veränderte Datei den Reise-Schlüssel mitlesen. Aktualisieren = neue Datei aus dist/umd/ ablegen, Pfad anpassen.
const SUPABASE_JS = new URL('../vendor/supabase/supabase-2.117.2.js', import.meta.url).href;
const TRIP_HASH = /(?:^#|&)reise=([a-f0-9]{32,128})/i;

// Klassisches Skript (UMD) – stellt window.supabase bereit; wird erst geladen, wenn eine Reise geteilt ist
let supabaseLib = null;
function loadSupabase() {
  supabaseLib ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SUPABASE_JS;
    script.onload = () => (window.supabase?.createClient ? resolve(window.supabase) : reject(new Error('Supabase-Bibliothek unvollständig')));
    script.onerror = () => {
      supabaseLib = null; // beim nächsten Versuch erneut laden
      reject(new Error('Supabase-Bibliothek nicht ladbar'));
    };
    document.head.append(script);
  });
  return supabaseLib;
}

export const sharingConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export function tripKeyFromUrl() {
  const m = location.hash.match(TRIP_HASH);
  return m ? m[1].toLowerCase() : null;
}
export const rememberedTripKey = () => readPref('trip');
export const rememberTripKey = (key) => writePref('trip', key);
export const forgetTripKey = () => writePref('trip', null);
export const shareUrl = (key) => `${location.origin}${location.pathname}#reise=${key}`;

export class LocalBackend {
  kind = 'local';

  constructor(getState) {
    this.getState = getState;
  }

  async load() {
    return loadLocalData();
  }

  #save() {
    if (!saveLocalData(this.getState())) throw new Error('Speichern im Browser nicht möglich');
  }

  async addPlaces() { this.#save(); }
  async updatePlace() { this.#save(); }
  async deletePlace() { this.#save(); }
  async deleteAllPlaces() { this.#save(); }
  async addRoutes() { this.#save(); }
  async updateRoute() { this.#save(); }
  async deleteRoute() { this.#save(); }
  async deleteAllRoutes() { this.#save(); }
  async saveSettings() { this.#save(); }
  async saveParticipants() { this.#save(); }
  async changeParticipants() { this.#save(); return null; }
  async addExpenses() { this.#save(); }
  async updateExpense() { this.#save(); }
  async deleteExpense() { this.#save(); }
}

// --- Supabase ------------------------------------------------------------------------

const PATCH_COLUMNS = { name: 'name', address: 'address', lat: 'lat', lng: 'lng', url: 'url', note: 'note', category: 'category', listName: 'list_name', glutenFree: 'gluten_free', reservation: 'reservation', visited: 'visited', starred: 'starred' };

const toRow = (p, key) => ({
  id: p.id,
  trip_key: key,
  name: p.name,
  address: p.address || '',
  lat: Number.isFinite(p.lat) ? p.lat : null,
  lng: Number.isFinite(p.lng) ? p.lng : null,
  url: p.url || '',
  note: p.note || '',
  list_name: p.listName || '',
  category: p.category,
  added_by: p.addedBy || '',
  created_at: new Date(p.addedAt || Date.now()).toISOString(),
  // Immer mitschicken: Bei einem Sammel-Insert füllt Supabase fehlende Felder einzelner Zeilen mit null
  // statt mit dem Standardwert – das verletzt „not null“, sobald nur manche Orte glutenfrei sind.
  gluten_free: !!p.glutenFree,
  // nur mitschicken, wenn gesetzt: die Spalte ist optional (null = nicht reserviert)
  ...(p.reservation ? { reservation: p.reservation } : {}),
  // nur wenn besucht – die Spalte ist bewusst ohne „not null“, fehlende Werte gelten als nicht besucht
  ...(p.visited ? { visited: true } : {}),
  ...(p.starred ? { starred: true } : {}),
});

const fromRow = (r) => ({
  id: r.id,
  name: r.name,
  address: r.address || '',
  lat: r.lat,
  lng: r.lng,
  url: r.url || '',
  note: r.note || '',
  listName: r.list_name || '',
  category: r.category,
  glutenFree: r.gluten_free === true,
  visited: r.visited === true,
  starred: r.starred === true,
  reservation: r.reservation && typeof r.reservation === 'object' ? r.reservation : null,
  addedBy: r.added_by || '',
  addedAt: Date.parse(r.created_at) || 0,
});

// Reisekasse: Beträge in Cent, Personen über ihre ID (Namen stehen in trip_settings.participants)
const toExpenseRow = (e, key) => ({
  id: e.id,
  trip_key: key,
  title: e.title || '',
  amount_cents: e.amountCents,
  paid_by: e.paidBy,
  shared_with: e.sharedWith,
  spent_on: e.date || null,
  added_by: e.addedBy || '',
  created_at: new Date(e.addedAt || Date.now()).toISOString(),
});

const fromExpenseRow = (r) => ({
  id: r.id,
  title: r.title || '',
  amountCents: r.amount_cents,
  paidBy: r.paid_by,
  sharedWith: Array.isArray(r.shared_with) ? r.shared_with : [],
  date: r.spent_on || '',
  addedBy: r.added_by || '',
  addedAt: Date.parse(r.created_at) || 0,
});

// Routen (GPX-Strecken): eigene Tabelle, weil sie viele Punkte tragen statt eines einzelnen lat/lng.
const toRouteRow = (route, key) => ({
  id: route.id,
  trip_key: key,
  name: route.name,
  category: route.category || 'rennrad-route',
  points: route.points,
  distance_km: Number.isFinite(route.distanceKm) ? route.distanceKm : null,
  elevation_gain_m: Number.isFinite(route.elevationGainM) ? route.elevationGainM : null,
  elevation_loss_m: Number.isFinite(route.elevationLossM) ? route.elevationLossM : null,
  url: route.url || null,
  added_by: route.addedBy || '',
  created_at: new Date(route.addedAt || Date.now()).toISOString(),
});

const fromRouteRow = (r) => ({
  id: r.id,
  name: r.name,
  category: r.category || 'rennrad-route',
  points: Array.isArray(r.points) ? r.points : [],
  distanceKm: r.distance_km,
  elevationGainM: r.elevation_gain_m ?? null,
  elevationLossM: r.elevation_loss_m ?? null,
  url: r.url || '',
  addedBy: r.added_by || '',
  addedAt: Date.parse(r.created_at) || 0,
});

function check({ error }) {
  if (error) throw new Error(error.message || 'Unbekannter Datenbankfehler');
}

export class SharedBackend {
  kind = 'shared';

  static async connect(key) {
    if (!sharingConfigured()) throw new Error('Gemeinsame Reisen sind noch nicht eingerichtet (js/config.js).');
    const { createClient } = await loadSupabase();
    const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-trip-key': key } },
    });
    const backend = new SharedBackend(db, key);
    await backend.load(); // prüft Verbindung und Schlüssel
    return backend;
  }

  constructor(db, key) {
    this.db = db;
    this.key = key;
  }

  async load() {
    const [places, routes, settings, expenses] = await Promise.all([
      this.db.from('places').select('*').eq('trip_key', this.key).order('created_at'),
      this.db.from('routes').select('*').eq('trip_key', this.key).order('created_at'),
      this.db.from('trip_settings').select('*').eq('trip_key', this.key).maybeSingle(),
      this.db.from('expenses').select('*').eq('trip_key', this.key).order('created_at'),
    ]);
    check(places);
    check(routes);
    check(settings);
    // Fehlt die Tabelle „expenses“ noch (SQL nicht ausgeführt), läuft der Rest der App trotzdem weiter.
    if (expenses.error) console.warn('Ausgaben nicht verfügbar (supabase/schema.sql ausgeführt?):', expenses.error.message);
    return {
      places: places.data.map(fromRow),
      routes: routes.data.map(fromRouteRow),
      airbnb: settings.data?.airbnb ?? null,
      customCategories: settings.data?.custom_categories ?? [],
      participants: settings.data?.participants ?? [],
      expenses: expenses.error ? [] : expenses.data.map(fromExpenseRow),
      cashMissing: Boolean(expenses.error) || !(settings.data == null || 'participants' in settings.data),
    };
  }

  async addPlaces(places) {
    for (let i = 0; i < places.length; i += 500) {
      check(await this.db.from('places').insert(places.slice(i, i + 500).map((p) => toRow(p, this.key))));
    }
  }

  async updatePlace(id, patch) {
    const row = { updated_at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch)) if (PATCH_COLUMNS[k]) row[PATCH_COLUMNS[k]] = v;
    check(await this.db.from('places').update(row).eq('id', id).eq('trip_key', this.key));
  }

  async deletePlace(id) {
    check(await this.db.from('places').delete().eq('id', id).eq('trip_key', this.key));
  }

  async deleteAllPlaces() {
    check(await this.db.from('places').delete().eq('trip_key', this.key));
  }

  // Kleinere Stapel als bei Orten: eine Route trägt viele Punkte und ist dadurch je Zeile größer.
  // gpxById: optionale Original-GPX-Dateien je Route-ID – liegen in einer eigenen Tabelle, damit der
  // Abgleich alle 20 s (load) sie nicht jedes Mal mitlädt. Scheitert nur das Speichern der Datei
  // (z. B. Tabelle noch nicht angelegt), bleibt die Route trotzdem gespeichert.
  async addRoutes(routes, gpxById = {}) {
    for (let i = 0; i < routes.length; i += 50) {
      check(await this.db.from('routes').insert(routes.slice(i, i + 50).map((r) => toRouteRow(r, this.key))));
    }
    const files = routes.filter((r) => gpxById[r.id]).map((r) => ({ route_id: r.id, trip_key: this.key, gpx: gpxById[r.id] }));
    for (const file of files) {
      const { error } = await this.db.from('route_files').insert(file);
      if (error) console.warn('GPX-Datei nicht gespeichert (supabase/schema.sql ausgeführt?):', error.message);
    }
  }

  // Original-GPX einer Route oder null (ältere Importe, Tabelle fehlt)
  async routeGpx(id) {
    const { data, error } = await this.db.from('route_files').select('gpx').eq('route_id', id).eq('trip_key', this.key).maybeSingle();
    if (error) return null;
    return data?.gpx || null;
  }

  // Bisher nur der Link zur Tour (Strava, Komoot …) – weitere Felder bei Bedarf hier ergänzen
  async updateRoute(id, { url }) {
    check(await this.db.from('routes').update({ url: url || null, updated_at: new Date().toISOString() }).eq('id', id).eq('trip_key', this.key));
  }

  async deleteRoute(id) {
    check(await this.db.from('routes').delete().eq('id', id).eq('trip_key', this.key));
  }

  async deleteAllRoutes() {
    check(await this.db.from('routes').delete().eq('trip_key', this.key));
  }

  // Eine Person hinzufügen oder entfernen, ohne gleichzeitige Änderungen anderer zu überschreiben:
  // aktuelle Liste aus der Datenbank lesen, nur die eigene Änderung anwenden, zurückschreiben.
  // Beim Entfernen wird geprüft, ob die Person (auch in Rechnungen anderer) noch vorkommt.
  // Rückgabe: die neue Liste vom Server.
  async changeParticipants({ add = null, removeId = null }) {
    if (removeId) {
      const [paid, shared] = await Promise.all([
        this.db.from('expenses').select('id', { count: 'exact', head: true }).eq('trip_key', this.key).eq('paid_by', removeId),
        this.db.from('expenses').select('id', { count: 'exact', head: true }).eq('trip_key', this.key).contains('shared_with', JSON.stringify([removeId])), // jsonb: als JSON-Liste übergeben
      ]);
      check(paid);
      check(shared);
      if (paid.count || shared.count) throw new Error('die Person kommt in Rechnungen vor');
    }
    const current = await this.db.from('trip_settings').select('participants').eq('trip_key', this.key).maybeSingle();
    check(current);
    let list = Array.isArray(current.data?.participants) ? current.data.participants : [];
    if (add && !list.some((p) => p.id === add.id)) list = [...list, add];
    if (removeId) list = list.filter((p) => p.id !== removeId);
    await this.saveParticipants(list);
    return list;
  }

  // Ganze Liste setzen (Reise starten, Backup übernehmen) – Unterkunft und Kategorien bleiben unberührt
  async saveParticipants(participants) {
    check(await this.db.from('trip_settings').upsert(
      { trip_key: this.key, participants, updated_at: new Date().toISOString() },
      { onConflict: 'trip_key' },
    ));
  }

  async addExpenses(expenses) {
    for (let i = 0; i < expenses.length; i += 500) {
      check(await this.db.from('expenses').insert(expenses.slice(i, i + 500).map((e) => toExpenseRow(e, this.key))));
    }
  }

  async updateExpense(id, e) {
    const { title, amount_cents, paid_by, shared_with, spent_on } = toExpenseRow(e, this.key);
    const res = await this.db.from('expenses')
      .update({ title, amount_cents, paid_by, shared_with, spent_on, updated_at: new Date().toISOString() })
      .eq('id', id).eq('trip_key', this.key)
      .select('id');
    check(res);
    if (!res.data?.length) throw new Error('die Rechnung wurde inzwischen gelöscht');
  }

  async deleteExpense(id) {
    check(await this.db.from('expenses').delete().eq('id', id).eq('trip_key', this.key));
  }

  async saveSettings({ airbnb, customCategories }) {
    check(await this.db.from('trip_settings').upsert(
      { trip_key: this.key, airbnb, custom_categories: customCategories, updated_at: new Date().toISOString() },
      { onConflict: 'trip_key' },
    ));
  }
}
