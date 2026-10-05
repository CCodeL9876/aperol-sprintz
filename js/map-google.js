// Test-Variante: Google Maps statt OpenStreetMap/Leaflet. Gleiche Schnittstelle wie createMap in map.js,
// damit app.js nichts davon wissen muss. Zusätzlich: Restaurants, Cafés usw. von Google antippen und mit
// Details (Bewertung, Öffnungszeiten) ansehen und per Knopf zu den eigenen Orten hinzufügen.
// Aktiv nur mit ?karte=google bzw. über das Menü – Standard bleibt OpenStreetMap.
/* global google */

import { hasCoords } from './geo.js';
import { icon, categoryIcon, categoryStyle } from './icons.js';
import { ROUTE_CATEGORY } from './categories.js';
import { MALLORCA, popupHtml, routePopupHtml, airbnbPopupHtml, escapeHtml, safeHttpUrl, pinHtml, pinFlags } from './map.js';

const LOAD_TIMEOUT_MS = 12000;

// Lädt die Maps JavaScript API einmalig. Bricht nach LOAD_TIMEOUT_MS ab, damit die App bei einem
// blockierten Skript auf OpenStreetMap zurückfallen kann, statt ohne Karte zu hängen.
function loadGoogleMaps(key) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cb = '__aperolGoogleMapsReady';
    const timer = setTimeout(() => reject(new Error('Zeitüberschreitung beim Laden von Google Maps')), LOAD_TIMEOUT_MS);
    window[cb] = () => {
      clearTimeout(timer);
      delete window[cb];
      resolve();
    };
    const s = document.createElement('script');
    const params = new URLSearchParams({ key, v: 'weekly', loading: 'async', language: 'de', region: 'ES', callback: cb });
    s.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    s.async = true;
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Google Maps konnte nicht geladen werden'));
    };
    document.head.append(s);
  });
}

const toLatLng = (p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : { lat: p.lat, lng: p.lng });

// Google-Kategorien → eigene Kategorien (erste passende gewinnt; primaryType steht vorne)
const GOOGLE_TYPE_CATEGORY = [
  [/^(cafe|coffee_shop|bakery|cafeteria|tea_house|ice_cream_shop|dessert_shop)$/, 'kaffee'],
  [/^(bar|pub|wine_bar|night_club|cocktail_bar|bar_and_grill)$/, 'bar'],
  [/restaurant$|^(meal_takeaway|meal_delivery|food|brunch_restaurant|diner)$/, 'restaurant'],
  [/^(bicycle_store)$/, 'rennrad'],
  [/^(beach)$/, 'strand'],
  [/^(park|national_park|hiking_area|natural_feature|campground|state_park|scenic_point|observation_deck)$/, 'aussicht'],
  [/^(museum|church|place_of_worship|historical_landmark|historical_place|monument|art_gallery|tourist_attraction|cultural_landmark|castle)$/, 'kultur'],
  [/store$|^(supermarket|market|shopping_mall|grocery_store|farmers_market)$/, 'einkaufen'],
];

export function categoryFromGoogleTypes(types = []) {
  for (const t of types) {
    for (const [re, id] of GOOGLE_TYPE_CATEGORY) if (re.test(t)) return id;
  }
  return null;
}

const PLACE_FIELDS = [
  'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'regularOpeningHours',
  'websiteURI', 'googleMapsURI', 'types', 'primaryType', 'primaryTypeDisplayName', 'nationalPhoneNumber',
];

export async function createGoogleMap(el, { apiKey, mapId, onMapClick, onMarkerClick, getInsets, onAddPlace, onError, routePopup }) {
  // Ungültiger Schlüssel oder nicht freigegebene Adresse: Google ruft diese globale Funktion auf
  window.gm_authFailure = () => onError?.('Google Maps lehnt den API-Schlüssel ab – Einschränkungen (Website-Adressen) in der Google Cloud Console prüfen.');
  await loadGoogleMaps(apiKey);
  const [{ Map: GoogleMap, InfoWindow }, { AdvancedMarkerElement }, { LatLngBounds, event: gEvent }] = await Promise.all([
    google.maps.importLibrary('maps'),
    google.maps.importLibrary('marker'),
    google.maps.importLibrary('core'),
  ]);

  const mobile = () => window.matchMedia('(max-width: 899px)').matches;
  el.innerHTML = '';
  const map = new GoogleMap(el, {
    center: toLatLng(MALLORCA.center),
    zoom: MALLORCA.zoom,
    // Erweiterte Marker brauchen eine Map-ID; DEMO_MAP_ID ist Googles Test-ID (für eigene Stile später eine eigene anlegen)
    mapId: mapId || 'DEMO_MAP_ID',
    disableDefaultUI: true,
    zoomControl: !mobile(), // Handy: Zoomen mit zwei Fingern; unten liegt dort das Listen-Blatt
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
    clickableIcons: true, // Restaurants, Cafés usw. von Google antippbar
    gestureHandling: 'greedy', // auf dem Handy mit einem Finger verschieben
  });
  await new Promise((resolve) => gEvent.addListenerOnce(map, 'idle', resolve));

  const info = new InfoWindow({ maxWidth: 300 });
  const markers = new Map();
  let airbnbMarker = null;
  let activeId = null;
  let routeShapes = [];
  let zTop = 10;

  // --- Kartenart & Radwege: eigene Knöpfe, damit sie nicht unter Leiste/Blatt verschwinden ----------
  const tools = document.createElement('div');
  tools.className = 'gmap-tools';
  tools.innerHTML = `
    <button type="button" data-tool="satellite" aria-pressed="false">Satellit</button>
    <button type="button" data-tool="bike" aria-pressed="false">${icon('bike', { size: 14, stroke: 2 })} Radwege</button>`;
  el.parentElement.append(tools);
  let bikeLayer = null;
  tools.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tool]');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (btn.dataset.tool === 'satellite') map.setMapTypeId(on ? 'hybrid' : 'roadmap');
    if (btn.dataset.tool === 'bike') {
      bikeLayer ||= new google.maps.BicyclingLayer();
      bikeLayer.setMap(on ? map : null);
    }
  });

  // --- Klicks: eigene Karte vs. Google-Orte ---------------------------------------------------------
  map.addListener('click', (e) => {
    const ll = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    if (e.placeId) {
      e.stop(); // Googles Standard-Fenster unterdrücken, stattdessen unseres mit Details
      if (onMapClick?.(ll)) return; // z. B. „Airbnb auf der Karte wählen“ läuft gerade
      showGooglePlace(e.placeId, e.latLng);
      return;
    }
    info.close();
    onMapClick?.(ll);
  });

  async function showGooglePlace(placeId, latLng) {
    info.setContent('<div class="popup"><span class="popup-addr">Lade Details …</span></div>');
    info.setPosition(latLng);
    info.open({ map });
    const fallbackUrl = `https://www.google.com/maps/search/?api=1&query=${latLng.lat()},${latLng.lng()}&query_place_id=${encodeURIComponent(placeId)}`;
    let place;
    try {
      const { Place } = await google.maps.importLibrary('places');
      place = new Place({ id: placeId, requestedLanguage: 'de' });
      await place.fetchFields({ fields: PLACE_FIELDS });
    } catch (err) {
      console.warn('Places API:', err);
      info.setContent(`<div class="popup">
        <span class="popup-addr">Details nicht verfügbar – im Google-Cloud-Projekt die „Places API (New)“ aktivieren.</span>
        <a class="popup-link" href="${escapeHtml(fallbackUrl)}" target="_blank" rel="noopener">In Google Maps öffnen ↗</a>
      </div>`);
      return;
    }
    info.setContent(googlePlaceContent(place, fallbackUrl));
  }

  function googlePlaceContent(place, fallbackUrl) {
    const name = place.displayName || 'Ort';
    const today = place.regularOpeningHours?.weekdayDescriptions?.[(new Date().getDay() + 6) % 7]; // Liste beginnt montags
    const rating = Number.isFinite(place.rating)
      ? `★ ${place.rating.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${place.userRatingCount ? ` <small>(${place.userRatingCount.toLocaleString('de-DE')})</small>` : ''}`
      : '';
    const mapsUrl = safeHttpUrl(place.googleMapsURI) || fallbackUrl;
    const website = safeHttpUrl(place.websiteURI);
    const div = document.createElement('div');
    div.className = 'popup popup-google';
    div.innerHTML = `
      ${place.primaryTypeDisplayName ? `<span class="popup-cat">${escapeHtml(place.primaryTypeDisplayName)}</span>` : ''}
      <strong class="popup-name">${escapeHtml(name)}</strong>
      ${rating ? `<span class="popup-rating">${rating}</span>` : ''}
      ${place.formattedAddress ? `<span class="popup-addr">${escapeHtml(place.formattedAddress)}</span>` : ''}
      ${today ? `<span class="popup-hours">${escapeHtml(today)}</span>` : ''}
      ${place.nationalPhoneNumber ? `<a class="popup-addr" href="tel:${escapeHtml(place.nationalPhoneNumber.replace(/\s/g, ''))}">${escapeHtml(place.nationalPhoneNumber)}</a>` : ''}
      ${onAddPlace && place.location ? '<button type="button" class="btn btn-small btn-primary popup-add">Zu unseren Orten hinzufügen</button>' : ''}
      <span class="popup-links">
        <a class="popup-link" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener">Google Maps ↗</a>
        ${website ? `<a class="popup-link" href="${escapeHtml(website)}" target="_blank" rel="noopener">Website ↗</a>` : ''}
      </span>`;
    div.querySelector('.popup-add')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Wird hinzugefügt …';
      const result = await onAddPlace({
        name,
        address: place.formattedAddress || '',
        lat: place.location.lat(),
        lng: place.location.lng(),
        url: mapsUrl,
        types: [place.primaryType, ...(place.types || [])].filter(Boolean),
      });
      btn.textContent = result === 'added' ? '✓ Hinzugefügt' : result === 'dupe' ? 'Schon in eurer Liste' : 'Zu unseren Orten hinzufügen';
      btn.disabled = result === 'added' || result === 'dupe';
    });
    return div;
  }

  // --- Versatz durch Seitenleiste / Boxen / Listen-Blatt (wie in map.js) ------------------------------
  const insets = () => ({ top: 0, right: 0, bottom: 0, left: 0, ...(getInsets?.() || {}) });

  function centerOn(latlng, zoom) {
    const { top, right, bottom, left } = insets();
    const ll = new google.maps.LatLng(toLatLng(latlng));
    const proj = map.getProjection();
    let target = ll;
    if (proj) {
      const scale = 2 ** zoom;
      const pt = proj.fromLatLngToPoint(ll);
      target = proj.fromPointToLatLng(new google.maps.Point(pt.x - (left - right) / 2 / scale, pt.y - (top - bottom) / 2 / scale));
    }
    if (map.getZoom() === zoom) map.panTo(target);
    else map.moveCamera({ center: target, zoom });
  }

  function fitPoints(pts, maxZoom) {
    const { top, right, bottom, left } = insets();
    const bounds = new LatLngBounds();
    for (const p of pts) bounds.extend(toLatLng(p));
    map.fitBounds(bounds, { top: top + 40, right: right + 40, bottom: bottom + 40, left: left + 40 });
    gEvent.addListenerOnce(map, 'idle', () => {
      if (map.getZoom() > maxZoom) map.setZoom(maxZoom);
    });
  }

  // --- Eigene Orte --------------------------------------------------------------------------------
  function pinElement(cat, active, flags) {
    const wrap = document.createElement('div');
    wrap.className = 'gpin';
    wrap.innerHTML = pinHtml(cat, active, flags);
    return wrap;
  }

  function openPlacePopup(id) {
    const entry = markers.get(id);
    if (!entry) return;
    info.setContent(popupHtml(entry.place, entry.cat));
    info.open({ map, anchor: entry.marker });
  }

  function setPlaces(places, catOf, currentId) {
    activeId = currentId;
    for (const { marker } of markers.values()) marker.map = null;
    markers.clear();
    for (const p of places) {
      if (!hasCoords(p)) continue;
      const cat = catOf(p.category);
      const marker = new AdvancedMarkerElement({
        map,
        position: { lat: p.lat, lng: p.lng },
        content: pinElement(cat, p.id === currentId, pinFlags(p)),
        title: p.name,
        zIndex: p.id === currentId ? 1000 : p.starred ? 500 : 1,
      });
      marker.addListener('click', () => {
        openPlacePopup(p.id);
        onMarkerClick?.(p.id);
      });
      markers.set(p.id, { marker, cat, place: p });
    }
  }

  function setActive(id) {
    for (const key of [activeId, id]) {
      const entry = markers.get(key);
      if (!entry) continue;
      const on = key === id;
      entry.marker.content.querySelector('.pin')?.classList.toggle('is-active', on);
      entry.marker.zIndex = on ? 1000 : entry.place.starred ? 500 : 1;
    }
    activeId = id;
  }

  function focusPlace(id) {
    const entry = markers.get(id);
    if (!entry) return;
    setActive(id);
    centerOn([entry.place.lat, entry.place.lng], Math.max(map.getZoom(), 13));
    openPlacePopup(id);
  }

  function fitTo(places, airbnb) {
    const pts = places.filter(hasCoords).map((p) => [p.lat, p.lng]);
    if (airbnb) pts.push([airbnb.lat, airbnb.lng]);
    if (!pts.length) return map.moveCamera({ center: toLatLng(MALLORCA.center), zoom: MALLORCA.zoom });
    if (pts.length === 1) return centerOn(pts[0], 13);
    fitPoints(pts, 14);
  }

  function setAirbnb(airbnb) {
    if (airbnbMarker) airbnbMarker.map = null;
    airbnbMarker = null;
    if (!airbnb) return;
    const content = document.createElement('div');
    content.innerHTML = `<div class="home-pin" title="Unser Airbnb">${icon('home', { size: 15, stroke: 2.2 })}</div>`;
    airbnbMarker = new AdvancedMarkerElement({ map, position: toLatLng(airbnb), content, title: 'Unser Airbnb', zIndex: 2000 });
    airbnbMarker.addListener('click', () => {
      info.setContent(airbnbPopupHtml(airbnb));
      info.open({ map, anchor: airbnbMarker });
    });
  }

  // --- Rennrad-Routen -----------------------------------------------------------------------------
  function setRoutes(routes) {
    for (const s of routeShapes) s.setMap(null);
    routeShapes = [];
    for (const r of routes) {
      if (!r.points?.length) continue;
      const color = r.color || ROUTE_CATEGORY.ink;
      const path = r.points.map(toLatLng);
      const casing = new google.maps.Polyline({ map, path, strokeColor: '#FFFFFF', strokeOpacity: 0.9, strokeWeight: 6, clickable: false, zIndex: ++zTop });
      const line = new google.maps.Polyline({ map, path, strokeColor: color, strokeOpacity: 0.95, strokeWeight: 3.5, zIndex: ++zTop });
      const raise = () => {
        casing.setOptions({ zIndex: ++zTop, strokeWeight: 8 });
        line.setOptions({ zIndex: ++zTop, strokeWeight: 5.5 });
      };
      const lower = () => {
        casing.setOptions({ strokeWeight: 6 });
        line.setOptions({ strokeWeight: 3.5 });
      };
      line.addListener('mouseover', raise);
      line.addListener('mouseout', lower);
      line.addListener('click', (e) => {
        raise();
        info.setContent(routePopup ? routePopup(r, color) : routePopupHtml(r, color));
        info.setPosition(e.latLng);
        info.open({ map });
      });
      routeShapes.push(casing, line);
    }
  }

  function fitToRoute(route) {
    if (!route?.points?.length) return;
    if (route.points.length === 1) return centerOn(route.points[0], 13);
    fitPoints(route.points, 14);
  }

  return { map, setPlaces, setAirbnb, setActive, focusPlace, fitTo, setRoutes, fitToRoute, centerOn, invalidate: () => {} };
}
