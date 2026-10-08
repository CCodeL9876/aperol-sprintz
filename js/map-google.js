// Standardkarte: Google Maps statt OpenStreetMap/Leaflet. Gleiche Schnittstelle wie createMap in map.js,
// damit app.js nichts davon wissen muss. Zusätzlich: Restaurants, Cafés usw. von Google antippen und mit
// Details (Bewertung, Öffnungszeiten) ansehen und per Knopf zu den eigenen Orten hinzufügen.
// Aktiv, solange ein API-Schlüssel in config.js steht und auf dem Gerät nicht OpenStreetMap gewählt wurde.
/* global google */

import { hasCoords, haversineKm } from './geo.js';
import { icon, categoryIcon, categoryStyle } from './icons.js';
import { ROUTE_CATEGORY } from './categories.js';
import { MALLORCA, popupHtml, routePopupHtml, airbnbPopupHtml, escapeHtml, safeHttpUrl, pinHtml, pinFlags, poiPinHtml, poiPopupHtml, poiTitle, PLAN_COLOR, planPinHtml, planPinLabels, ROUTE_LINE_COLOR } from './map.js';
import { hoursFromGoogle } from './hours.js';
import { readPref, writePref } from './store.js';

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

// Google-Orte nach Art als eigene Ebene (Schalter unten auf der Karte); types = Places-Typen („Table A“).
// primary: nur Orte mit diesem Haupttyp (sonst kämen z. B. Restaurants mit Nebentyp „Café“ dazu); Essen breit,
// weil Restaurants meist einen Untertyp als Haupttyp haben (italian_restaurant …)
const GPLACE_TYPES = {
  cafe: { label: 'Cafés', icon: 'coffee', types: ['cafe', 'coffee_shop'], primary: true },
  bar: { label: 'Bars', icon: 'wine', types: ['bar', 'pub', 'wine_bar'], primary: true },
  food: { label: 'Essen', icon: 'utensils', types: ['restaurant'] },
};
const GPLACE_MAX_RADIUS_M = 8000; // weiter herausgezoomt: nicht suchen (höchstens 20 Treffer je Suche)

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

// Öffnungszeiten eigener Orte nachschlagen: Places-Textsuche „Name, Adresse“ nahe der gespeicherten Position.
// Lädt die Google-Bibliothek bei Bedarf – auch wenn gerade OpenStreetMap angezeigt wird. Ein Treffer zählt nur,
// wenn er höchstens 400 m neben dem Ort liegt; sonst gilt „keine Angaben“ (hours.p = null).
// onResult(place, hours) je Ort; ein grundsätzlicher Fehler (Schlüssel, API) bricht mit verständlichem Text ab.
export async function lookupHours(apiKey, places, onResult) {
  await loadGoogleMaps(apiKey);
  const { Place } = await google.maps.importLibrary('places');
  for (const p of places) {
    let hours;
    try {
      const { places: found } = await Place.searchByText({
        textQuery: p.address ? `${p.name}, ${p.address}` : p.name,
        fields: ['location', 'regularOpeningHours'],
        locationBias: { center: { lat: p.lat, lng: p.lng }, radius: 300 },
        maxResultCount: 1,
        language: 'de',
        region: 'es',
      });
      const hit = found?.[0];
      const near = hit?.location && haversineKm(hit.location.lat(), hit.location.lng(), p.lat, p.lng) <= 0.4;
      hours = hoursFromGoogle(near ? hit.regularOpeningHours : null);
    } catch (err) {
      const msg = String(err?.message || '');
      if (/referer|PERMISSION_DENIED|not been used|disabled|not enabled/i.test(msg)) throw new Error(placesErrorHint(err));
      console.warn('Öffnungszeiten:', p.name, msg);
      continue; // einzelner Fehler (z. B. kurz kein Netz): Ort beim nächsten Mal erneut versuchen
    }
    await onResult(p, hours);
  }
}

export async function createGoogleMap(el, { apiKey, mapId, onMapClick, onMarkerClick, getInsets, onAddPlace, onError, onNotice, routePopup, onLocateMessage }) {
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

  // Googles Fenster hat oben eine eigene Zeile, in der nur das ✕ steht – darunter begann unser Inhalt erst nach
  // viel leerem Platz. Die Art (erste Zeile .popup-cat, z. B. „Rennrad-Hotspot“) kommt deshalb in diese Zeile,
  // neben das ✕. infoSource: zuletzt übergebener Inhalt (zum Vergleichen in setPlaces).
  let infoSource = null;
  function setInfo(content) {
    infoSource = content;
    let node = content;
    if (typeof content === 'string') {
      const wrap = document.createElement('div');
      wrap.innerHTML = content.trim();
      node = wrap.firstElementChild || wrap;
    }
    // Einmal je Inhalt herauslösen (ein DOM-Inhalt wie das Google-Ort-Fenster wird wiederverwendet)
    if (node.infoHeader === undefined) {
      const cat = node.querySelector(':scope > .popup-cat');
      cat?.remove();
      node.infoHeader = cat || null;
    }
    info.setHeaderContent(node.infoHeader || '');
    info.setContent(node);
  }
  const markers = new Map();
  let airbnbMarker = null;
  let activeId = null;
  let routeShapes = [];
  let zTop = 10;
  let drafting = false; // „Etappe planen“ läuft: Tipps setzen Wegpunkte statt Fenster zu öffnen

  // --- Kartenart: eigener Knopf, damit er nicht unter Leiste/Blatt verschwindet ------------------------
  const tools = document.createElement('div');
  tools.className = 'gmap-tools';
  // Google-Orte nach Art (siehe „Google-Orte nach Art“ weiter unten) und Satellit
  tools.innerHTML = `<span class="gplace-pills" role="group" aria-label="Google-Orte anzeigen">${Object.entries(GPLACE_TYPES)
    .map(([k, t]) => `<button type="button" data-gplace="${k}" aria-pressed="false" title="${t.label} von Google im Kartenausschnitt zeigen">${icon(t.icon, { size: 14, stroke: 2.2 })}${t.label}</button>`).join('')}</span>
    <button type="button" data-tool="satellite" aria-pressed="false">Satellit</button>`;
  el.parentElement.append(tools);
  tools.addEventListener('click', (e) => {
    const g = e.target.closest('[data-gplace]');
    if (g) return toggleGPlace(g.dataset.gplace, g);
    const btn = e.target.closest('[data-tool]');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (btn.dataset.tool === 'satellite') map.setMapTypeId(on ? 'hybrid' : 'roadmap');
  });

  // --- Popups nicht unter Boxen oder Listen-Blatt -----------------------------------------------------
  // Googles Popup kennt die Boxen oben und das Blatt unten nicht und schiebt sich nur in den Kartenrand.
  // Nach dem Öffnen daher prüfen und die Karte so verschieben, dass es im freien Teil liegt.
  // Geprüft wird gleich nach dem Öffnen und jedes Mal, wenn die Karte in den ersten 2 Sekunden danach zur Ruhe
  // kommt: Beim Antippen eines Orts fährt die Karte noch hin, während das Fenster schon aufgeht. Danach nicht
  // mehr – sonst würde die Karte gegen eigenes Verschieben ankämpfen.
  let popupOpenedAt = 0;
  info.addListener('domready', () => {
    popupOpenedAt = Date.now();
    requestAnimationFrame(keepPopupFree);
  });
  map.addListener('idle', () => {
    if (info.isOpen && Date.now() - popupOpenedAt < 2000) keepPopupFree();
  });
  function keepPopupFree() {
    {
      const box = el.querySelector('.gm-style-iw-c');
      if (!box) return;
      const r = box.getBoundingClientRect();
      const m = el.getBoundingClientRect();
      const { top, bottom } = insets();
      const freeTop = m.top + top + 12;
      // auch über der Knopfreihe unten (Google | OSM, Satellit) bleiben
      const toolsTop = tools.getBoundingClientRect().top;
      const freeBottom = Math.min(m.bottom - bottom - 12, toolsTop > m.top ? toolsTop - 8 : Infinity);
      if (r.top < freeTop - 1) map.panBy(0, -(freeTop - r.top));
      else if (r.bottom > freeBottom + 1 && r.height < freeBottom - freeTop) map.panBy(0, r.bottom - freeBottom);
    }
  }

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
    setInfo('<div class="popup"><span class="popup-addr">Lade Details …</span></div>');
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
      setInfo(`<div class="popup">
        <span class="popup-addr">Details nicht verfügbar – ${escapeHtml(placesErrorHint(err))}</span>
        <a class="popup-link" href="${escapeHtml(fallbackUrl)}" target="_blank" rel="noopener">In Google Maps öffnen ↗</a>
      </div>`);
      return;
    }
    setInfo(googlePlaceContent(place, fallbackUrl));
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
      <span class="popup-src">Von Google · nicht gespeichert</span>
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
        hours: hoursFromGoogle(place.regularOpeningHours),
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
  // Offenes Detailfenster eines eigenen Orts: Inhalt merken, damit setPlaces es aktuell halten kann
  let popupId = null;
  let popupShown = '';
  const hiddenMarkers = new Map(); // ausgeblendete Marker zum Wiederverwenden

  function openPlacePopup(id) {
    const entry = markers.get(id);
    if (!entry) return;
    popupId = id;
    popupShown = popupHtml(entry.place, entry.cat);
    setInfo(popupShown);
    info.open({ shouldFocus: false, map, anchor: entry.marker });
  }

  // Wird bei jeder Änderung (Filter, Stern, Suche …) aufgerufen. Bestehende Marker werden weiterverwendet
  // und nur angepasst, wo sich etwas geändert hat – alle neu zu erzeugen ist bei vielen Orten spürbar träge.
  function setPlaces(places, catOf, currentId) {
    activeId = currentId;
    // Google-Orte an Stellen eigener Orte weglassen (auch direkt nach „Zu unseren Orten hinzufügen“)
    ownCoords = places.filter(hasCoords).map((p) => [p.lat, p.lng]);
    for (const key of gActive) drawGPlaces(key);
    const keep = new Set();
    for (const p of places) {
      if (!hasCoords(p)) continue;
      const cat = catOf(p.category);
      const active = p.id === currentId;
      const pin = pinHtml(cat, active, pinFlags(p));
      const zIndex = active ? 1000 : p.starred ? 500 : 1;
      let entry = markers.get(p.id) || hiddenMarkers.get(p.id);
      if (entry && hiddenMarkers.has(p.id)) {
        hiddenMarkers.delete(p.id);
        entry.marker.map = map;
        markers.set(p.id, entry);
      }
      if (!entry) {
        const content = document.createElement('div');
        content.className = 'gpin';
        content.innerHTML = pin;
        const marker = new AdvancedMarkerElement({ map, position: { lat: p.lat, lng: p.lng }, content, title: p.name, zIndex });
        marker.addListener('click', () => {
          if (!drafting) openPlacePopup(p.id); // beim Planen wird der Ort zum Wegpunkt
          onMarkerClick?.(p.id);
        });
        entry = { marker, pin };
        markers.set(p.id, entry);
      } else {
        if (entry.pin !== pin) {
          entry.marker.content.innerHTML = pin;
          entry.pin = pin;
        }
        if (entry.place.lat !== p.lat || entry.place.lng !== p.lng) entry.marker.position = { lat: p.lat, lng: p.lng };
        if (entry.marker.title !== p.name) entry.marker.title = p.name;
        if (entry.marker.zIndex !== zIndex) entry.marker.zIndex = zIndex;
      }
      entry.cat = cat;
      entry.place = p;
      keep.add(p.id);
    }
    for (const [id, entry] of markers) {
      if (keep.has(id)) continue;
      entry.marker.map = null; // aufbewahren: kommt der Ort wieder (Filter aus), geht das schneller
      markers.delete(id);
      hiddenMarkers.set(id, entry);
    }
    // Offenes Detailfenster eines Orts: schliessen, wenn der Ort weggefiltert wurde, sonst Inhalt auffrischen
    if (popupId && info.isOpen && infoSource === popupShown) {
      const entry = markers.get(popupId);
      if (!entry) {
        info.close();
        popupId = null;
      } else {
        const html = popupHtml(entry.place, entry.cat);
        if (html !== popupShown) setInfo((popupShown = html));
      }
    }
  }

  function setActive(id) {
    for (const key of [activeId, id]) {
      const entry = markers.get(key);
      if (!entry) continue;
      const on = key === id;
      entry.pin = pinHtml(entry.cat, on, pinFlags(entry.place));
      entry.marker.content.innerHTML = entry.pin;
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

  let airbnbNow = null; // aktuelle Daten fürs Detailfenster
  let airbnbAt = '';
  function setAirbnb(airbnb) {
    airbnbNow = airbnb;
    const at = airbnb ? `${airbnb.lat},${airbnb.lng}` : '';
    if (at === airbnbAt) return; // gleiche Stelle: Marker stehen lassen
    airbnbAt = at;
    if (airbnbMarker) airbnbMarker.map = null;
    airbnbMarker = null;
    if (!airbnb) return;
    const content = document.createElement('div');
    content.innerHTML = `<div class="home-pin" title="Unser Airbnb">${icon('home', { size: 15, stroke: 2.2 })}</div>`;
    airbnbMarker = new AdvancedMarkerElement({ map, position: toLatLng(airbnb), content, title: 'Unser Airbnb', zIndex: 2000 });
    airbnbMarker.addListener('click', () => {
      setInfo(airbnbPopupHtml(airbnbNow));
      info.open({ shouldFocus: false, map, anchor: airbnbMarker });
    });
  }

  // --- Rennrad-Routen -----------------------------------------------------------------------------
  // Linien nur neu zeichnen, wenn sich Auswahl, Farbe oder Strecke geändert haben. Die Daten fürs
  // Detailfenster (gefahren, Links, Wetter) kommen beim Antippen immer frisch aus routeNow.
  const routeNow = new Map();
  let routeKey = [];
  function setRoutes(routes) {
    routeNow.clear();
    for (const r of routes) routeNow.set(r.id, r);
    const key = routes.flatMap((r) => [r.id, r.color, r.points]);
    if (key.length === routeKey.length && key.every((v, i) => v === routeKey[i])) return;
    routeKey = key;
    for (const s of routeShapes) s.setMap(null);
    routeShapes = [];
    for (const route of routes) {
      if (!route.points?.length) continue;
      const color = route.color || ROUTE_CATEGORY.ink;
      const current = () => routeNow.get(route.id) || route;
      const path = route.points.map(toLatLng);
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
        // Beim Planen: Tipp auf eine eingeblendete Etappe setzt dort einen Wegpunkt
        if (drafting) return onMapClick?.({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        raise();
        setInfo(routePopup ? routePopup(current(), color) : routePopupHtml(current(), color));
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
      setInfo(content);
      info.setPosition(pos);
      info.open({ shouldFocus: false, map });
    });
    centerOn([pos.lat(), pos.lng()], Math.max(map.getZoom(), 16));
    setInfo(content);
    info.setPosition(pos);
    info.open({ shouldFocus: false, map });
    return place.displayName || '';
  }

  function clearSearchMarker() {
    if (searchMarker) searchMarker.map = null;
    searchMarker = null;
  }

  // Etappe planen: Entwurf { waypoints: [[lat, lng]], segments: [{ points, pending, error }], selected, edit }
  // oder null (beenden). Noch nicht berechnete Abschnitte gestrichelt als Luftlinie, fehlgeschlagene rot.
  // edit: { onMove(i, [lat, lng]), onPick(i), onInsert(segIndex, [lat, lng]) } – Wegpunkte lassen sich dann
  // ziehen und antippen, ein Tipp auf die Linie fügt einen Zwischenpunkt ein.
  let draftShapes = [];
  let draggingDraft = false;
  let deferredDraft;
  const dashed = (color) => [{ icon: { path: 'M 0,-1 0,1', strokeColor: color, strokeOpacity: 0.9, strokeWeight: 4, scale: 2 }, offset: '0', repeat: '12px' }];
  function setDraft(draft) {
    if (draggingDraft) { deferredDraft = draft; return; } // Punkt wird gerade gezogen: danach zeichnen
    drafting = Boolean(draft);
    for (const s of draftShapes) {
      if (s.setMap) s.setMap(null); else s.map = null;
    }
    draftShapes = [];
    if (!draft) return;
    if (draft.segments.length || draft.waypoints.length) info.close();
    const edit = draft.edit;
    // Vergleichsstrecke (anderes Profil) gestrichelt grau unter der Planung
    if (draft.alt?.length) {
      draftShapes.push(new google.maps.Polyline({ map, path: draft.alt.map(toLatLng), strokeOpacity: 0, strokeWeight: 4, clickable: false, zIndex: 8990, icons: dashed('#5E5E50') }));
    }
    draft.segments.forEach((seg, si) => {
      const path = seg.points.map(toLatLng);
      const color = seg.error ? '#C92A2A' : PLAN_COLOR;
      const plain = !seg.error && !seg.pending;
      draftShapes.push(new google.maps.Polyline({ map, path, strokeColor: '#FFFFFF', strokeOpacity: plain ? 0.9 : 0, strokeWeight: 7, clickable: false, zIndex: 9000 }));
      draftShapes.push(new google.maps.Polyline({ map, path, strokeColor: color, strokeOpacity: plain ? 0.95 : 0, strokeWeight: 4, clickable: false, zIndex: 9001, icons: plain ? null : dashed(color) }));
      if (edit && !seg.pending) {
        // Breite unsichtbare Linie: leichter mit dem Finger zu treffen
        const hit = new google.maps.Polyline({ map, path, strokeColor: '#000000', strokeOpacity: 0, strokeWeight: 22, clickable: true, zIndex: 9002 });
        hit.addListener('click', (e) => edit.onInsert(si, [e.latLng.lat(), e.latLng.lng()]));
        draftShapes.push(hit);
      }
    });
    // steile Stücke farbig über der Linie (gelb ab 5 %, rot ab 8 %, violett ab 10 %)
    for (const run of draft.steep || []) {
      draftShapes.push(new google.maps.Polyline({ map, path: run.points.map(toLatLng), strokeColor: run.color, strokeOpacity: 1, strokeWeight: 5, clickable: false, zIndex: 9003 }));
    }
    const labels = planPinLabels(draft.waypoints);
    draft.waypoints.forEach((p, i) => {
      const content = document.createElement('div');
      content.innerHTML = planPinHtml(labels[i], draft.selected === i, p.coffee);
      content.style.transform = 'translateY(50%)'; // mittig auf den Punkt statt mit der Unterkante
      const m = new AdvancedMarkerElement({ map, position: toLatLng(p), content, zIndex: i === 0 ? 2600 : 2500, gmpDraggable: Boolean(edit), gmpClickable: Boolean(edit) });
      draftShapes.push(m);
      if (!edit) return;
      m.addListener('click', () => edit.onPick(i));
      m.addListener('dragstart', () => { draggingDraft = true; });
      m.addListener('dragend', () => {
        draggingDraft = false;
        deferredDraft = undefined; // onMove zeichnet ohnehin neu
        const pos = m.position;
        const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
        const lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
        edit.onMove(i, [lat, lng]);
      });
    });
  }

  // Routen-Vorschau (directions.js): Linie zum Ziel oder null; passt den Ausschnitt an
  let routeLine = [];
  function setRouteLine(points) {
    for (const l of routeLine) l.setMap(null);
    routeLine = [];
    if (!points?.length) return;
    info.close();
    const path = points.map(toLatLng);
    routeLine.push(new google.maps.Polyline({ map, path, strokeColor: '#FFFFFF', strokeOpacity: 0.9, strokeWeight: 8, clickable: false, zIndex: 8000 }));
    routeLine.push(new google.maps.Polyline({ map, path, strokeColor: ROUTE_LINE_COLOR, strokeOpacity: 0.95, strokeWeight: 5, clickable: false, zIndex: 8001 }));
    fitPoints(points, 16);
  }

  // Etappen-Details: steile Stücke der aufgeklappten Etappe farbig über ihrer Linie, der angetippte Anstieg
  // dick hervorgehoben. { runs: [{ color, points }], climb: { points, color } | null } oder null
  let steepShapes = [];
  function setRouteSteep(steep) {
    for (const s of steepShapes) s.setMap(null);
    steepShapes = [];
    if (!steep) return;
    const line = (points, color, weight, zIndex, opacity = 1) => steepShapes.push(new google.maps.Polyline({ map, path: points.map(toLatLng), strokeColor: color, strokeOpacity: opacity, strokeWeight: weight, clickable: false, zIndex }));
    if (steep.climb?.points?.length > 1) {
      line(steep.climb.points, '#1F1F1F', 12, 50000, 0.8);
      line(steep.climb.points, '#FFFFFF', 9, 50001);
      line(steep.climb.points, steep.climb.color, 5.5, 50002);
    }
    for (const run of steep.runs || []) line(run.points, run.color, steep.climb ? 5.5 : 4.5, 50003);
  }

  // Punkt zum Fadenkreuz im Höhenprofil (profile.js): [lat, lng] oder null
  let cursor = null;
  function setCursor(p) {
    if (!p) {
      if (cursor) cursor.map = null;
      cursor = null;
      return;
    }
    if (!cursor) {
      const content = document.createElement('div');
      content.className = 'elev-map-dot';
      content.style.transform = 'translateY(50%)'; // mittig auf den Punkt
      cursor = new AdvancedMarkerElement({ map, position: toLatLng(p), content, zIndex: 3000 });
    } else {
      cursor.position = toLatLng(p);
    }
  }

  // --- Google-Orte nach Art (Cafés, Bars, Essen) -----------------------------------------------------
  // Googles eigene Symbole lassen sich mit der Standard-Karten-ID nicht filtern – daher eine eigene Ebene:
  // Places „searchNearby“ im sichtbaren Ausschnitt (höchstens 20 Treffer je Art, beliebte zuerst). Gesucht wird
  // beim Einschalten und auf „In diesem Bereich suchen“ (jede Suche zählt zum Google-Kontingent).
  const gActive = new Set();
  const gFound = new Map(); // Art → [Place]
  const gMarkers = new Map(); // Art → [Marker]
  const gCache = new Map();
  let gSearchedAt = null;
  let ownCoords = [];
  const gSearchBtn = document.createElement('button');
  gSearchBtn.type = 'button';
  gSearchBtn.className = 'gplace-search';
  gSearchBtn.hidden = true;
  el.parentElement.append(gSearchBtn);
  gSearchBtn.addEventListener('click', () => searchGPlaces());

  function toggleGPlace(key, btn) {
    const on = !gActive.has(key);
    if (on) gActive.add(key); else gActive.delete(key);
    btn.setAttribute('aria-pressed', String(on));
    // Einmal pro Gerät erklären, was die weißen Kreise sind
    if (on && !readPref('gplaceHint')) {
      writePref('gplaceHint', true);
      onNotice?.('Weiße Kreise = Orte von Google (nicht gespeichert). Gefüllte Pins = eure gespeicherten Orte.');
    }
    if (on) searchGPlaces([key]);
    else {
      drawGPlaces(key);
      if (!gActive.size) gSearchBtn.hidden = true;
    }
  }

  function viewArea() {
    const c = map.getCenter();
    const ne = map.getBounds()?.getNorthEast();
    const radius = ne ? haversineKm(c.lat(), c.lng(), ne.lat(), ne.lng()) * 1000 : GPLACE_MAX_RADIUS_M;
    return { center: c, radius };
  }

  async function searchGPlaces(keys = [...gActive]) {
    const { center, radius } = viewArea();
    if (radius > GPLACE_MAX_RADIUS_M) {
      gSearchBtn.textContent = 'Für Google-Orte näher heranzoomen';
      gSearchBtn.disabled = true;
      gSearchBtn.hidden = false;
      return;
    }
    gSearchBtn.hidden = true;
    gSearchedAt = { lat: center.lat(), lng: center.lng(), zoom: map.getZoom(), radius };
    try {
      const { Place, SearchNearbyRankPreference } = await google.maps.importLibrary('places');
      for (const key of keys) {
        const ck = `${key}|${center.lat().toFixed(3)}|${center.lng().toFixed(3)}|${Math.round(radius / 250)}`;
        let places = gCache.get(ck);
        if (!places) {
          ({ places } = await Place.searchNearby({
            fields: ['id', 'displayName', 'location', 'rating'],
            locationRestriction: { center, radius: Math.max(150, radius) },
            [GPLACE_TYPES[key].primary ? 'includedPrimaryTypes' : 'includedTypes']: GPLACE_TYPES[key].types,
            maxResultCount: 20,
            rankPreference: SearchNearbyRankPreference.POPULARITY,
            language: 'de',
          }));
          gCache.set(ck, places);
        }
        gFound.set(key, places || []);
        if (gActive.has(key)) drawGPlaces(key);
      }
    } catch (err) {
      console.warn('Places (Umgebung):', err);
      onError?.(`Google-Orte nicht ladbar – ${placesErrorHint(err)}`);
    }
  }

  function drawGPlaces(key) {
    for (const m of gMarkers.get(key) || []) m.map = null;
    gMarkers.set(key, []);
    if (!gActive.has(key)) return;
    const near = (lat, lng) => ownCoords.some(([a, b]) => haversineKm(a, b, lat, lng) < 0.04);
    const markers = (gFound.get(key) || []).filter((p) => p.location && !near(p.location.lat(), p.location.lng())).map((p) => {
      const content = document.createElement('div');
      content.className = `gplace-pin gplace-${key}`;
      content.innerHTML = icon(GPLACE_TYPES[key].icon, { size: 13, stroke: 2.3 });
      content.style.transform = 'translateY(50%)'; // mittig auf den Punkt
      const name = p.displayName || GPLACE_TYPES[key].label;
      const m = new AdvancedMarkerElement({ map, position: p.location, content, title: p.rating ? `${name} · ★ ${p.rating}` : name, zIndex: 5 });
      m.addListener('click', () => {
        // Beim Planen wird der Ort zum Wegpunkt, sonst Google-Details mit „Zu unseren Orten hinzufügen“
        if (drafting) return onMapClick?.({ lat: p.location.lat(), lng: p.location.lng() });
        showGooglePlace(p.id, p.location);
      });
      return m;
    });
    gMarkers.set(key, markers);
  }

  // Nach Verschieben/Zoomen: „In diesem Bereich suchen“ anbieten (nicht automatisch – spart Abfragen)
  map.addListener('idle', () => {
    if (!gActive.size) return;
    const { center, radius } = viewArea();
    if (radius > GPLACE_MAX_RADIUS_M) {
      gSearchBtn.textContent = 'Für Google-Orte näher heranzoomen';
      gSearchBtn.disabled = true;
      gSearchBtn.hidden = false;
      return;
    }
    const moved = !gSearchedAt
      || haversineKm(gSearchedAt.lat, gSearchedAt.lng, center.lat(), center.lng()) * 1000 > gSearchedAt.radius * 0.4
      || Math.abs(map.getZoom() - gSearchedAt.zoom) >= 1;
    gSearchBtn.textContent = 'In diesem Bereich suchen';
    gSearchBtn.disabled = false;
    gSearchBtn.hidden = !moved;
  });

  // Trinkbrunnen und Velo-Werkstätten entlang der eingeblendeten Etappen: [{ id, type, name, lat, lng, km, routeName }]
  let poiMarkers = [];
  let poiKey = '';
  function setPois(pois) {
    const key = pois.map((x) => `${x.id}@${x.km}`).join('|');
    if (key === poiKey) return;
    poiKey = key;
    for (const m of poiMarkers) m.map = null;
    poiMarkers = pois.map((x) => {
      const content = document.createElement('div');
      content.innerHTML = poiPinHtml(x);
      content.style.transform = 'translateY(50%)'; // mittig auf den Punkt statt mit der Unterkante
      const m = new AdvancedMarkerElement({ map, position: { lat: x.lat, lng: x.lng }, content, title: poiTitle(x), zIndex: 0 });
      m.addListener('click', () => {
        setInfo(poiPopupHtml(x));
        info.open({ shouldFocus: false, map, anchor: m });
      });
      return m;
    });
  }

  return { map, setPlaces, setAirbnb, setActive, focusPlace, fitTo, setRoutes, fitToRoute, centerOn, setPois, setDraft, setCursor, setRouteLine, setRouteSteep, searchPlaces, openSearchResult, clearSearchMarker, locate: () => { if (!locating) toggleLocate(); }, invalidate: () => {} };
}
