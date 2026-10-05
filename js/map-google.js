// Standardkarte: Google Maps statt OpenStreetMap/Leaflet. Gleiche Schnittstelle wie createMap in map.js,
// damit app.js nichts davon wissen muss. Zusätzlich: Restaurants, Cafés usw. von Google antippen und mit
// Details (Bewertung, Öffnungszeiten) ansehen und per Knopf zu den eigenen Orten hinzufügen.
// Aktiv, solange ein API-Schlüssel in config.js steht und auf dem Gerät nicht OpenStreetMap gewählt wurde.
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

const SEARCH_AREA = { south: 39.1, west: 2.25, north: 40.0, east: 3.55 }; // Mallorca und Cabrera

const PLACE_FIELDS = [
  'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'regularOpeningHours',
  'websiteURI', 'googleMapsURI', 'types', 'primaryType', 'primaryTypeDisplayName', 'nationalPhoneNumber',
];

// Fehler der Places API → kurzer Hinweis, was fehlt (Schlüssel-Einschränkung, API nicht aktiv, Netz)
function placesErrorHint(err) {
  const msg = String(err?.message || '');
  if (/referer/i.test(msg)) return `Schlüssel-Einschränkung: in der Google Cloud Console bei den Websites ${location.origin}/* ergänzen.`;
  if (/not been used|disabled|not enabled|PERMISSION_DENIED/i.test(msg)) return 'im Google-Cloud-Projekt die „Places API (New)“ aktivieren und beim Schlüssel freigeben.';
  return 'gerade keine Verbindung zu Google.';
}

export async function createGoogleMap(el, { apiKey, mapId, onMapClick, onMarkerClick, getInsets, onAddPlace, onError, routePopup, onLocateMessage }) {
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

  // --- Kartenart: eigener Knopf, damit er nicht unter Leiste/Blatt verschwindet ------------------------
  const tools = document.createElement('div');
  tools.className = 'gmap-tools';
  tools.innerHTML = '<button type="button" data-tool="satellite" aria-pressed="false">Satellit</button>';
  el.parentElement.append(tools);
  tools.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tool]');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (btn.dataset.tool === 'satellite') map.setMapTypeId(on ? 'hybrid' : 'roadmap');
  });

  // --- Popups nicht unter Boxen oder Listen-Blatt -----------------------------------------------------
  // Googles Popup kennt die Boxen oben und das Blatt unten nicht und schiebt sich nur in den Kartenrand.
  // Nach dem Öffnen daher prüfen und die Karte so verschieben, dass es im freien Teil liegt.
  info.addListener('domready', () => {
    requestAnimationFrame(() => {
      const box = el.querySelector('.gm-style-iw-c');
      if (!box) return;
      const r = box.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      const { top, bottom } = insets();
      const freeTop = m.top + top + 12;
      const freeBottom = m.bottom - bottom - 12;
      if (r.top < freeTop) map.panBy(0, -(freeTop - r.top));
      else if (r.bottom > freeBottom && r.height < freeBottom - freeTop) map.panBy(0, r.bottom - freeBottom);
    });
  });

  // --- Live-Standort (wie in map.js) ------------------------------------------------------------------
  // Knopf über den Zoom-Knöpfen. 1. Tipp: Standort verfolgen, die Karte läuft beim Gehen mit. Verschiebt
  // man die Karte selbst, hört das Mitlaufen auf; ein Tipp springt zurück. Tipp in der Mitte: ausschalten.
  // Die Position bleibt im Browser. Dazu ein Blickrichtungs-Kegel aus dem Kompass.
  let locating = false;
  let firstFix = false;
  let following = false;
  let meLatLng = null;
  let meMarker = null;
  let meCircle = null;
  let watchId = null;
  const locateBtn = document.createElement('button');
  locateBtn.type = 'button';
  locateBtn.className = 'locate-btn gmap-locate';
  locateBtn.setAttribute('aria-label', 'Mein Standort');
  locateBtn.innerHTML = icon('locate', { size: 20, stroke: 2.2 });
  el.parentElement.append(locateBtn);
  const setLocateState = (state) => {
    locateBtn.classList.toggle('is-waiting', state === 'waiting');
    locateBtn.setAttribute('aria-pressed', String(state !== 'off'));
    locateBtn.title = state === 'off' ? 'Mein Standort' : 'Standort: nochmals tippen zum Zentrieren bzw. Ausschalten';
  };
  setLocateState('off');

  let headingOn = false;
  let headingAngle = null;
  let headingFrame = 0;
  function applyHeading() {
    headingFrame = 0;
    const wrap = meMarker?.content?.querySelector('.me-wrap');
    if (!wrap || headingAngle == null) return;
    wrap.classList.add('has-heading');
    wrap.style.setProperty('--heading', `${headingAngle}deg`);
  }
  function onOrientation(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h == null) return;
    const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
    h = (h + screenAngle + 360) % 360;
    headingAngle = headingAngle == null ? h : headingAngle + ((h - headingAngle + 540) % 360) - 180;
    if (!headingFrame) headingFrame = requestAnimationFrame(applyHeading);
  }
  // Muss synchron aus dem Tipp heraus starten (iOS fragt sonst nicht nach)
  async function startHeading() {
    if (headingOn || typeof window.DeviceOrientationEvent === 'undefined') return;
    headingOn = true;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const answer = await DeviceOrientationEvent.requestPermission();
        if (answer !== 'granted') {
          headingOn = false;
          onLocateMessage?.('heading-denied');
          return;
        }
      }
    } catch {
      headingOn = false;
      return;
    }
    if (!locating) { headingOn = false; return; }
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
  }
  function stopHeading() {
    headingOn = false;
    headingAngle = null;
    window.removeEventListener('deviceorientationabsolute', onOrientation);
    window.removeEventListener('deviceorientation', onOrientation);
  }

  function stopLocate() {
    stopHeading();
    locating = false;
    following = false;
    meLatLng = null;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (meMarker) meMarker.map = null;
    meCircle?.setMap(null);
    meMarker = meCircle = null;
    setLocateState('off');
  }

  // Liegt der Standort schon in der Mitte des freien Kartenteils (unter Boxen, über dem Blatt)?
  function meIsCentered() {
    const proj = map.getProjection();
    if (!meLatLng || !proj) return false;
    const { top, right, bottom, left } = insets();
    const scale = 2 ** map.getZoom();
    const p = proj.fromLatLngToPoint(new google.maps.LatLng(meLatLng));
    const c = proj.fromLatLngToPoint(map.getCenter());
    const dx = (p.x - c.x) * scale - (left - right) / 2;
    const dy = (p.y - c.y) * scale - (top - bottom) / 2;
    return Math.hypot(dx, dy) < 40;
  }

  function onPosition(pos) {
    if (!locating) return;
    meLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const accuracy = pos.coords.accuracy || 0;
    if (!meMarker) {
      meCircle = new google.maps.Circle({
        map, center: meLatLng, radius: accuracy, clickable: false, zIndex: 1,
        fillColor: '#2F6FD6', fillOpacity: 0.12, strokeColor: '#2F6FD6', strokeOpacity: 0.6, strokeWeight: 1.5,
      });
      const content = document.createElement('div');
      content.className = 'gmap-me';
      // Kegel (Blickrichtung) hinter dem Punkt; erscheint erst, wenn der Kompass Werte liefert
      content.innerHTML = '<div class="me-wrap"><svg class="me-heading" viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="me-beam-g" x1="0" y1="1" x2="0" y2="0"><stop offset=".45" stop-color="#2F6FD6" stop-opacity=".75"/><stop offset="1" stop-color="#2F6FD6" stop-opacity="0"/></linearGradient></defs><path d="M60 60 33 6a60 60 0 0 1 54 0Z" fill="url(#me-beam-g)"/></svg><div class="me-dot"></div></div>';
      meMarker = new AdvancedMarkerElement({ map, position: meLatLng, content, zIndex: 3000 });
      applyHeading();
    } else {
      meMarker.position = meLatLng;
      meCircle.setCenter(meLatLng);
      meCircle.setRadius(accuracy);
    }
    if (firstFix) {
      firstFix = false;
      following = true;
      setLocateState('on');
      centerOn([meLatLng.lat, meLatLng.lng], Math.max(map.getZoom(), 16));
    } else if (following && !meIsCentered()) {
      centerOn([meLatLng.lat, meLatLng.lng], map.getZoom());
    }
  }

  function onPositionError(err) {
    if (!locating) return;
    // Bei laufender Verfolgung kurze Aussetzer ignorieren – nur beim Start melden
    if (!firstFix && meLatLng && err.code !== 1) return;
    stopLocate();
    onLocateMessage?.(err.code === 1 ? 'denied' : 'unavailable', err.message);
  }

  function toggleLocate() {
    if (!locating) {
      if (!navigator.geolocation) return onLocateMessage?.('unsupported');
      locating = true;
      firstFix = true;
      startHeading();
      setLocateState('waiting');
      watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
      return;
    }
    if (meLatLng && (!following || !meIsCentered())) {
      following = true;
      return centerOn([meLatLng.lat, meLatLng.lng], Math.max(map.getZoom(), 16));
    }
    stopLocate();
  }
  locateBtn.addEventListener('click', toggleLocate);
  // Selbst verschoben → nicht mehr mitlaufen (bis zum nächsten Tipp auf den Knopf)
  map.addListener('dragstart', () => { following = false; });

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
    info.open({ shouldFocus: false, map });
    const fallbackUrl = `https://www.google.com/maps/search/?api=1&query=${latLng.lat()},${latLng.lng()}&query_place_id=${encodeURIComponent(placeId)}`;
    let place;
    try {
      const { Place } = await google.maps.importLibrary('places');
      place = new Place({ id: placeId, requestedLanguage: 'de' });
      await place.fetchFields({ fields: PLACE_FIELDS });
    } catch (err) {
      console.warn('Places API:', err);
      info.setContent(`<div class="popup">
        <span class="popup-addr">Details nicht verfügbar – ${escapeHtml(placesErrorHint(err))}</span>
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
    info.open({ shouldFocus: false, map, anchor: entry.marker });
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
      info.open({ shouldFocus: false, map, anchor: airbnbMarker });
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
      const line = new google.maps.Polyline({ map, path, strokeColor: color, strokeOpacity: 0.95, strokeWeight: 3.5, clickable: false, zIndex: ++zTop });
      // Unsichtbare, breite Tippfläche – die schmale Linie trifft man auf dem Handy kaum
      const hit = new google.maps.Polyline({ map, path, strokeColor: color, strokeOpacity: 0.01, strokeWeight: 22, zIndex: ++zTop });
      const raise = () => {
        casing.setOptions({ zIndex: ++zTop, strokeWeight: 8 });
        line.setOptions({ zIndex: ++zTop, strokeWeight: 5.5 });
        hit.setOptions({ zIndex: ++zTop });
      };
      const lower = () => {
        casing.setOptions({ strokeWeight: 6 });
        line.setOptions({ strokeWeight: 3.5 });
      };
      hit.addListener('mouseover', raise);
      hit.addListener('mouseout', lower);
      hit.addListener('click', (e) => {
        raise();
        info.setContent(routePopup ? routePopup(r, color) : routePopupHtml(r, color));
        info.setPosition(e.latLng);
        info.open({ shouldFocus: false, map });
      });
      routeShapes.push(casing, line, hit);
    }
  }

  function fitToRoute(route) {
    if (!route?.points?.length) return;
    if (route.points.length === 1) return centerOn(route.points[0], 13);
    fitPoints(route.points, 14);
  }

  // --- Suche (Places Autocomplete) ----------------------------------------------------------------
  // Vorschläge zu einem Suchtext, nur auf Mallorca (samt Cabrera) – sonst kämen bei „Café“ auch Treffer
  // aus Ibiza oder Paris. Ein Sitzungs-Token fasst
  // die Tipp-Anfragen bis zum Öffnen eines Treffers zusammen (so rechnet Google sie als eine Suche ab).
  let searchToken = null;
  const predictions = new Map();
  let searchMarker = null;

  async function searchPlaces(input) {
    try {
      const { AutocompleteSuggestion, AutocompleteSessionToken } = await google.maps.importLibrary('places');
      searchToken ||= new AutocompleteSessionToken();
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input, sessionToken: searchToken, language: 'de', region: 'es', locationRestriction: SEARCH_AREA,
      });
      predictions.clear();
      return suggestions.map((s) => s.placePrediction).filter(Boolean).slice(0, 5).map((p) => {
        predictions.set(p.placeId, p);
        return { placeId: p.placeId, name: p.mainText?.text || p.text?.text || '', sub: p.secondaryText?.text || '' };
      });
    } catch (err) {
      console.warn('Places-Suche:', err);
      throw new Error(`Google-Suche nicht verfügbar – ${placesErrorHint(err)}`);
    }
  }

  // Treffer öffnen: Details laden, Stecknadel setzen, hinfahren und das Detailfenster zeigen.
  // Rückgabe: Name des Orts (für das Suchfeld). Fehler werden mit verständlichem Text geworfen.
  async function openSearchResult(placeId) {
    const prediction = predictions.get(placeId);
    searchToken = null; // Sitzung endet mit dem Abruf der Details
    let place;
    try {
      const { Place } = await google.maps.importLibrary('places');
      place = prediction ? prediction.toPlace() : new Place({ id: placeId, requestedLanguage: 'de' });
      await place.fetchFields({ fields: PLACE_FIELDS });
    } catch (err) {
      console.warn('Places API:', err);
      throw new Error(`Details nicht verfügbar – ${placesErrorHint(err)}`);
    }
    const pos = place.location;
    if (!pos) throw new Error('Für diesen Treffer kennt Google keine Position.');
    const fallbackUrl = `https://www.google.com/maps/search/?api=1&query=${pos.lat()},${pos.lng()}&query_place_id=${encodeURIComponent(placeId)}`;
    const content = googlePlaceContent(place, fallbackUrl);
    clearSearchMarker();
    searchMarker = new AdvancedMarkerElement({ map, position: pos, title: place.displayName || '', zIndex: 5000 });
    searchMarker.addListener('click', () => {
      info.setContent(content);
      info.setPosition(pos);
      info.open({ shouldFocus: false, map });
    });
    centerOn([pos.lat(), pos.lng()], Math.max(map.getZoom(), 16));
    info.setContent(content);
    info.setPosition(pos);
    info.open({ shouldFocus: false, map });
    return place.displayName || '';
  }

  function clearSearchMarker() {
    if (searchMarker) searchMarker.map = null;
    searchMarker = null;
  }

  return { map, setPlaces, setAirbnb, setActive, focusPlace, fitTo, setRoutes, fitToRoute, centerOn, searchPlaces, openSearchResult, clearSearchMarker, locate: () => { if (!locating) toggleLocate(); }, invalidate: () => {} };
}
