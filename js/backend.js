// Wo die Orte liegen:
//  - LocalBackend: nur in diesem Browser (localStorage)
//  - SharedBackend: gemeinsame Reise in Supabase; Zugriff nur mit dem geheimen Reise-Schlüssel,
//    der bei jeder Anfrage als Header "x-trip-key" mitgeht und von der Datenbank geprüft wird.
//
// Die App ändert zuerst ihren Zustand im Speicher und meldet die Änderung dann hier.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { loadLocalData, saveLocalData, readPref, writePref } from './store.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const TRIP_HASH = /(?:^#|&)reise=([a-f0-9]{32,128})/i;

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
}

// --- Supabase ------------------------------------------------------------------------

const PATCH_COLUMNS = { name: 'name', address: 'address', lat: 'lat', lng: 'lng', url: 'url', note: 'note', category: 'category', listName: 'list_name' };

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
    const { createClient } = await import(SUPABASE_ESM);
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
    const [places, routes, settings] = await Promise.all([
      this.db.from('places').select('*').eq('trip_key', this.key).order('created_at'),
      this.db.from('routes').select('*').eq('trip_key', this.key).order('created_at'),
      this.db.from('trip_settings').select('*').eq('trip_key', this.key).maybeSingle(),
    ]);
    check(places);
    check(routes);
    check(settings);
    return {
      places: places.data.map(fromRow),
      routes: routes.data.map(fromRouteRow),
      airbnb: settings.data?.airbnb ?? null,
      customCategories: settings.data?.custom_categories ?? [],
      flights: settings.data?.flights ?? {},
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

  async saveSettings({ airbnb, customCategories, flights }) {
    check(await this.db.from('trip_settings').upsert(
      { trip_key: this.key, airbnb, custom_categories: customCategories, flights, updated_at: new Date().toISOString() },
      { onConflict: 'trip_key' },
    ));
  }
}
