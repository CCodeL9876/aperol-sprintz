// Leaflet-Karte: Orts-Marker, Airbnb-Marker, Radius-Kreis, Live-Standort und Rennrad-Routen (Linien statt Punkte).
/* global L */

import { hasCoords, formatKm, formatReservation, routeUrl, homeRouteUrl } from './geo.js';
import { icon, categoryIcon, categoryStyle } from './icons.js';
import { ROUTE_CATEGORY } from './categories.js';
import { hoursStatus, hoursToday } from './hours.js';
import { POI_TYPES } from './pois.js';

export const MALLORCA = { center: [39.62, 2.95], zoom: 9 };

// Kartenkacheln von OpenStreetMap: kein API-Key nötig. Die Farbanpassung kommt per CSS-Filter
// (.leaflet-tile-pane in styles.css) – dort werden sie zurückgenommen, damit Orange und Grün leuchten. CARTO-Kacheln verlangen inzwischen einen API-Key.
const TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
  maxZoom: 19,
};

// Nur http(s)-Links in href übernehmen – nie javascript: o. Ä. aus der Datenbank
export const safeHttpUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Popup-Inhalte – gemeinsam für die OpenStreetMap-Karte (hier) und die Google-Test-Variante (map-google.js)
// Marker-Merkmale eines Orts; Favoriten bekommen zusätzlich einen gelben Stern oben links
export const pinFlags = (p) => ({ reserved: !!p.reservation, visited: !!p.visited, starred: !!p.starred });
export function pinHtml(cat, active, { reserved, visited, starred } = {}) {
  const cls = `pin${active ? ' is-active' : ''}${reserved ? ' is-reserved' : ''}${visited ? ' is-visited' : ''}${starred ? ' is-starred' : ''}`;
  const star = starred ? `<span class="pin-star" aria-hidden="true">${icon('star', { size: 15, stroke: 2.2 })}</span>` : '';
  return `<div class="${cls}" style="${categoryStyle(cat)}">${categoryIcon(cat, { size: 14, stroke: 2.3 })}${star}</div>`;
}

export function airbnbPopupHtml(airbnb) {
  return `
    <div class="popup">
      <span class="popup-cat" style="--c:#3F6B34;--ci:#3F6B34">Unser Airbnb</span>
      <strong class="popup-name">${escapeHtml(airbnb.name || airbnb.label)}</strong>
      ${airbnb.name && airbnb.address ? `<span class="popup-addr">${escapeHtml(airbnb.address)}</span>` : ''}
      <a class="popup-link" href="${escapeHtml(homeRouteUrl(airbnb))}" target="_blank" rel="noopener"${routeAttrs({ name: 'Unterkunft', lat: airbnb.lat, lng: airbnb.lng, home: true })}>${icon('navigation', { size: 13, stroke: 2.2 })} Route zur Unterkunft</a>
    </div>`;
}

export function popupHtml(p, cat) {
  const dist = p.distance != null ? `<span class="popup-dist">${formatKm(p.distance)} von der Unterkunft</span>` : '';
  const status = hoursStatus(p.hours);
  const today = hoursToday(p.hours);
  return `
    <div class="popup">
      <span class="popup-cat" style="${categoryStyle(cat)}">${escapeHtml(cat.label)}</span>
      <strong class="popup-name">${escapeHtml(p.name)}</strong>
      <span class="popup-src is-own">✓ Unser Ort</span>
      ${p.address ? `<span class="popup-addr">${escapeHtml(p.address)}</span>` : ''}
      ${p.starred ? `<span class="popup-star">${icon('star', { size: 13, stroke: 2.2 })} Favorit</span>` : ''}
      ${p.visited ? `<span class="popup-visited">${icon('check', { size: 13, stroke: 2.6 })} Besucht</span>` : ''}
      ${p.reservation ? `<span class="popup-res">${icon('calendar-check', { size: 13, stroke: 2 })} ${escapeHtml(formatReservation(p.reservation))}</span>` : ''}
      ${p.glutenFree ? `<span class="popup-gf">${icon('wheat-off', { size: 13, stroke: 2 })} Glutenfrei</span>` : ''}
      ${status ? `<span class="popup-hours ${status.open ? 'is-open' : 'is-closed'}">${icon('clock', { size: 13, stroke: 2.2 })} ${escapeHtml(status.text)}${today ? ` <small>· heute ${escapeHtml(today)}</small>` : ''}</span>` : ''}
      ${dist}
      <a class="popup-link" href="${escapeHtml(routeUrl(p))}" target="_blank" rel="noopener"${routeAttrs(p)}>${icon('navigation', { size: 13, stroke: 2.2 })} Route</a>
      <button type="button" class="popup-link popup-cash" data-popup-cash="${escapeHtml(p.id)}">${icon('receipt', { size: 13, stroke: 2 })} Rechnung erfassen</button>
    </div>`;
}

// Trinkbrunnen / Velo-Werkstatt entlang einer Etappe (siehe pois.js): kleiner runder Marker und Detailfenster
export const poiTitle = (x) => `${POI_TYPES[x.type]?.label || 'Punkt'}${x.name ? `: ${x.name}` : ''}`;
export function poiPinHtml(x) {
  return `<div class="poi-pin poi-${x.type}" title="${escapeHtml(poiTitle(x))}">${icon(POI_TYPES[x.type]?.icon || 'pin', { size: 12, stroke: 2.4 })}</div>`;
}
export function poiPopupHtml(x) {
  return `<div class="popup">
      <span class="popup-cat">${escapeHtml(POI_TYPES[x.type]?.label || 'Punkt')}</span>
      ${x.name ? `<strong class="popup-name">${escapeHtml(x.name)}</strong>` : ''}
      ${Number.isFinite(x.km) ? `<span class="popup-dist">bei km ${Math.round(x.km)} von „${escapeHtml(x.routeName || 'Etappe')}“</span>` : ''}
      <a class="popup-link" href="${escapeHtml(routeUrl({ name: x.name || POI_TYPES[x.type]?.label || '', lat: x.lat, lng: x.lng }))}" target="_blank" rel="noopener"${routeAttrs({ name: x.name || POI_TYPES[x.type]?.label || '', lat: x.lat, lng: x.lng })}>${icon('navigation', { size: 13, stroke: 2.2 })} Route</a>
    </div>`;
}

export function routePopupHtml(r, color) {
  return `
    <div class="popup">
      <span class="popup-cat" style="${categoryStyle({ ...ROUTE_CATEGORY, ink: color })}">${escapeHtml(ROUTE_CATEGORY.label)}</span>
      <strong class="popup-name">${escapeHtml(r.name)}</strong>
      <span class="popup-dist">${formatKm(r.distanceKm)}${Number.isFinite(r.elevationGainM) ? ` · ↑ ${Math.round(r.elevationGainM).toLocaleString('de-DE')} Hm` : ''}${Number.isFinite(r.elevationLossM) ? ` · ↓ ${Math.round(r.elevationLossM).toLocaleString('de-DE')} Hm` : ''}</span>
      ${safeHttpUrl(r.url) ? `<a class="popup-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Tour öffnen ↗</a>` : ''}
    </div>`;
}

// Etappe planen: Farbe der Entwurfslinie (Aperol-Orange) und Wegpunkt – S = Start, dann nummeriert
// Ziel für die Routen-Vorschau in der App (app.js fängt Klicks auf [data-route-lat] ab); der href bleibt als
// Ersatz (Google Maps), z. B. auf der OpenStreetMap-Ersatzkarte. home = Route zur Unterkunft.
export function routeAttrs({ name, lat, lng, home = false }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return ` data-route-lat="${lat}" data-route-lng="${lng}" data-route-name="${escapeHtml(name || '')}"${home ? ' data-route-home="1"' : ''}`;
}

export const PLAN_COLOR = '#E8733A';
// Routen-Vorschau zu einem Ort: Blau wie bei Navigations-Apps, klar unterscheidbar von Etappen und Planer
export const ROUTE_LINE_COLOR = '#2F6E8C';
export const planPinHtml = (i) => `<span class="plan-pin${i === 0 ? ' is-start' : ''}">${i === 0 ? 'S' : i}</span>`;

// Ersatz, falls Leaflet nicht geladen werden konnte: Die App läuft ohne Karte weiter,
// statt beim Start komplett abzubrechen (dann fehlte auch die Ortsliste).
function createFallbackMap(el) {
  el.innerHTML = '<div class="map-error"><strong>Karte nicht verfügbar</strong><span>Die Kartenbibliothek konnte nicht geladen werden. Liste und Filter funktionieren trotzdem – Seite neu laden versuchen.</span></div>';
  const noop = () => {};
  const fakeMap = { flyTo: noop, getZoom: () => 9, setView: noop, fitBounds: noop };
  return { map: fakeMap, setPlaces: noop, setAirbnb: noop, setActive: noop, focusPlace: noop, fitTo: noop, setRoutes: noop, fitToRoute: noop, centerOn: noop, setPois: noop, setDraft: noop, setCursor: noop, setRouteLine: noop, invalidate: noop };
}

export function createMap(el, { onMapClick, onMarkerClick, getInsets, onLocateMessage, routePopup }) {
  if (typeof L === 'undefined') return createFallbackMap(el);
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView(MALLORCA.center, MALLORCA.zoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  // crossOrigin: damit der Service Worker (sw.js) gesehene Kacheln für unterwegs ohne Netz speichern kann
  L.tileLayer(TILES.url, { attribution: TILES.attribution, maxZoom: TILES.maxZoom, crossOrigin: true }).addTo(map);

  const placeLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const poiLayer = L.layerGroup().addTo(map);
  const draftLayer = L.layerGroup().addTo(map);
  let drafting = false; // „Etappe planen“ läuft: Tipps setzen Wegpunkte statt Popups zu öffnen
  const markers = new Map();
  let airbnbMarker = null;
  let activeId = null;

  map.on('click', (e) => onMapClick?.(e.latlng));

  // Geöffnete Detailfenster in den freien Kartenteil schieben: nicht unter die Boxen oben, das Listen-Blatt
  // unten oder die Knopfreihe (Google | OSM) – Leaflet selbst kennt nur den Kartenrand.
  // Geprüft wird gleich nach dem Öffnen und jedes Mal, wenn die Karte in den ersten 2 Sekunden danach zur Ruhe
  // kommt (fährt sie noch zum Ort, stimmt die erste Messung nicht). Danach nicht mehr – sonst würde die Karte
  // gegen eigenes Verschieben ankämpfen.
  let openPopup = null;
  let popupOpenedAt = 0;
  map.on('popupopen', (e) => {
    openPopup = e.popup;
    popupOpenedAt = Date.now();
    requestAnimationFrame(() => keepPopupFree(e.popup));
  });
  map.on('popupclose', (e) => { if (openPopup === e.popup) openPopup = null; });
  map.on('moveend', () => {
    // erst im nächsten Bild messen: panBy kann moveend sofort auslösen, noch bevor die Lage neu berechnet ist
    if (openPopup && Date.now() - popupOpenedAt < 2000) requestAnimationFrame(() => openPopup && keepPopupFree(openPopup));
  });
  function keepPopupFree(popup) {
    {
      if (!map.hasLayer(popup)) return;
      const box = popup.getElement()?.getBoundingClientRect();
      if (!box) return;
      const m = el.getBoundingClientRect();
      const { top, bottom } = insets();
      const toolsTop = el.parentElement.querySelector('.gmap-tools')?.getBoundingClientRect().top ?? Infinity;
      const freeTop = m.top + top + 12;
      const freeBottom = Math.min(m.bottom - bottom - 12, toolsTop > m.top ? toolsTop - 8 : Infinity);
      if (box.top < freeTop - 1) map.panBy([0, -(freeTop - box.top)]);
      else if (box.bottom > freeBottom + 1 && box.height < freeBottom - freeTop) map.panBy([0, box.bottom - freeBottom]);
    }
  }

  // Seitenleiste, Boxen-Zeile und (auf dem Handy) die Liste unten liegen über der Karte. getInsets
  // liefert, wie viele Pixel davon an jedem Rand verdeckt sind, damit Orte und Routen in der Mitte
  // des sichtbaren Kartenteils landen statt darunter.
  const insets = () => ({ top: 0, right: 0, bottom: 0, left: 0, ...(getInsets?.() || {}) });

  function centerOn(latlng, zoom, { animate = true } = {}) {
    const { top, right, bottom, left } = insets();
    const target = map.unproject(
      map.project(latlng, zoom).subtract([(left - right) / 2, (top - bottom) / 2]),
      zoom,
    );
    if (animate) map.flyTo(target, zoom, { duration: 0.6 });
    else map.setView(target, zoom);
  }

  // --- Live-Standort --------------------------------------------------------------------------
  // Knopf über den Zoom-Knöpfen. 1. Tipp: Standort verfolgen, die Karte läuft beim Gehen mit.
  // Verschiebt man die Karte selbst, hört das Mitlaufen auf; ein Tipp springt dann zurück und
  // läuft wieder mit. Tipp, wenn der Standort schon in der Mitte ist: ausschalten.
  // Die Position bleibt im Browser – sie wird weder gespeichert noch an die Datenbank geschickt.
  // Dazu ein Blickrichtungs-Kegel aus dem Kompass (iPhone: „Bewegung und Ausrichtung“ erlauben).
  let locating = false;
  let firstFix = false;
  let following = false;
  let meLatLng = null;
  let meMarker = null;
  let meCircle = null;
  let locateBtn = null;

  const setLocateState = (state) => {
    if (!locateBtn) return;
    locateBtn.classList.toggle('is-waiting', state === 'waiting');
    locateBtn.setAttribute('aria-pressed', String(state !== 'off'));
    locateBtn.title = state === 'off' ? 'Mein Standort' : 'Standort: nochmals tippen zum Zentrieren bzw. Ausschalten';
  };

  // --- Blickrichtung (Kompass) ---
  // iOS liefert die Richtung als webkitCompassHeading (Grad ab Norden, im Uhrzeigersinn) und verlangt
  // vorher eine Erlaubnis, die nur direkt nach einem Tipp abgefragt werden darf. Android liefert sie
  // über „deviceorientationabsolute“ (alpha, gegen den Uhrzeigersinn). Ohne Sensor: kein Kegel.
  let headingOn = false;
  let headingAngle = null; // fortlaufend (ohne Sprung bei 359° → 0°), damit die Drehung weich bleibt
  let headingFrame = 0;

  function applyHeading() {
    headingFrame = 0;
    const wrap = meMarker?.getElement()?.querySelector('.me-wrap');
    if (!wrap || headingAngle == null) return;
    wrap.classList.add('has-heading');
    wrap.style.setProperty('--heading', `${headingAngle}deg`);
  }

  function onOrientation(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;
    if (h == null) return;
    // Querformat: Bildschirmdrehung dazurechnen, damit der Kegel zur Oberkante des Bildschirms zeigt
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
    map.stopLocate();
    meMarker?.remove();
    meCircle?.remove();
    meMarker = meCircle = null;
    setLocateState('off');
  }

  function meIsCentered() {
    if (!meLatLng) return false;
    const { top, right, bottom, left } = insets();
    const size = map.getSize();
    const mid = L.point((left + size.x - right) / 2, (top + size.y - bottom) / 2);
    return map.latLngToContainerPoint(meLatLng).distanceTo(mid) < 40;
  }

  function toggleLocate() {
    if (!locating) {
      if (!navigator.geolocation) return onLocateMessage?.('unsupported');
      locating = true;
      firstFix = true;
      startHeading();
      setLocateState('waiting');
      map.locate({ watch: true, enableHighAccuracy: true, setView: false, maximumAge: 10000, timeout: 20000 });
      return;
    }
    if (meLatLng && (!following || !meIsCentered())) {
      following = true;
      return centerOn(meLatLng, Math.max(map.getZoom(), 16));
    }
    stopLocate();
  }

  map.on('locationfound', (e) => {
    if (!locating) return;
    meLatLng = e.latlng;
    if (!meMarker) {
      meCircle = L.circle(e.latlng, { radius: e.accuracy, className: 'me-accuracy', interactive: false }).addTo(map);
      meMarker = L.marker(e.latlng, {
        // Kegel (Blickrichtung) hinter dem Punkt; erscheint erst, wenn der Kompass Werte liefert
        icon: L.divIcon({
          className: '',
          html: '<div class="me-wrap"><svg class="me-heading" viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="me-beam" x1="0" y1="1" x2="0" y2="0"><stop offset=".45" stop-color="#2E4AD8" stop-opacity=".75"/><stop offset="1" stop-color="#2E4AD8" stop-opacity="0"/></linearGradient></defs><path d="M60 60 33 6a60 60 0 0 1 54 0Z" fill="url(#me-beam)"/></svg><div class="me-dot"></div></div>',
          iconSize: [120, 120], iconAnchor: [60, 60],
        }),
        interactive: false, keyboard: false, zIndexOffset: 2000,
      }).addTo(map);
      applyHeading();
    } else {
      meMarker.setLatLng(e.latlng);
      meCircle.setLatLng(e.latlng).setRadius(e.accuracy);
    }
    if (firstFix) {
      firstFix = false;
      following = true;
      setLocateState('on');
      centerOn(e.latlng, Math.max(map.getZoom(), 16));
    } else if (following && !meIsCentered()) {
      centerOn(e.latlng, map.getZoom());
    }
  });
  // Selbst verschoben → nicht mehr mitlaufen (bis zum nächsten Tipp auf den Knopf)
  map.on('dragstart', () => { following = false; });

  map.on('locationerror', (e) => {
    if (!locating) return;
    // Bei laufender Verfolgung kurze Aussetzer (z. B. im Tunnel) ignorieren – nur beim Start melden
    if (!firstFix && meLatLng && e.code !== 1) return;
    stopLocate();
    onLocateMessage?.(e.code === 1 ? 'denied' : 'unavailable', e.message);
  });

  const LocateControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      locateBtn = L.DomUtil.create('button', 'locate-btn');
      locateBtn.type = 'button';
      locateBtn.setAttribute('aria-label', 'Mein Standort');
      locateBtn.innerHTML = icon('locate', { size: 20, stroke: 2.2 });
      setLocateState('off');
      L.DomEvent.disableClickPropagation(locateBtn);
      L.DomEvent.on(locateBtn, 'click', toggleLocate);
      return locateBtn;
    },
  });
  // Unten rechts stapelt Leaflet neue Knöpfe über die bestehenden: Standort liegt also über dem Zoom
  new LocateControl().addTo(map);

  function fitPoints(pts, maxZoom) {
    const { top, right, bottom, left } = insets();
    map.fitBounds(pts, {
      paddingTopLeft: [left + 40, top + 40],
      paddingBottomRight: [right + 40, bottom + 40],
      maxZoom,
    });
  }

  // flags: { reserved, visited, starred } – siehe pinFlags
  function placeIcon(cat, active, flags = {}) {
    return L.divIcon({
      className: '',
      html: pinHtml(cat, active, flags),
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -20],
    });
  }


  const hiddenMarkers = new Map(); // ausgeblendete Marker zum Wiederverwenden
  // Wird bei jeder Änderung (Filter, Stern, Suche …) aufgerufen. Bestehende Marker werden weiterverwendet
  // und nur angepasst, wo sich etwas geändert hat – alle neu zu erzeugen ist bei vielen Orten spürbar träge.
  function setPlaces(places, catOf, currentId) {
    activeId = currentId;
    const keep = new Set();
    for (const p of places) {
      if (!hasCoords(p)) continue;
      const cat = catOf(p.category);
      const active = p.id === currentId;
      const flags = pinFlags(p);
      const pin = pinHtml(cat, active, flags);
      const popup = popupHtml(p, cat);
      const zIndex = active ? 1000 : p.starred ? 500 : 0; // Favoriten über den anderen
      let entry = markers.get(p.id) || hiddenMarkers.get(p.id);
      if (entry && hiddenMarkers.has(p.id)) {
        hiddenMarkers.delete(p.id);
        entry.marker.addTo(placeLayer);
        markers.set(p.id, entry);
      }
      if (!entry) {
        const m = L.marker([p.lat, p.lng], { icon: placeIcon(cat, active, flags), title: p.name, zIndexOffset: zIndex, riseOnHover: true });
        m.bindPopup(popup, { closeButton: false, className: 'llocs-popup' });
        m.on('click', () => {
          if (drafting) m.closePopup(); // beim Planen wird der Ort zum Wegpunkt
          onMarkerClick?.(p.id);
        });
        m.addTo(placeLayer);
        entry = { marker: m, pin, popup, place: p };
        markers.set(p.id, entry);
      } else {
        const m = entry.marker;
        if (entry.pin !== pin || m.options.title !== p.name) {
          m.options.title = p.name;
          m.setIcon(placeIcon(cat, active, flags));
          entry.pin = pin;
        }
        if (entry.place.lat !== p.lat || entry.place.lng !== p.lng) m.setLatLng([p.lat, p.lng]);
        if (entry.popup !== popup) {
          m.setPopupContent(popup);
          entry.popup = popup;
        }
        if (m.options.zIndexOffset !== zIndex) m.setZIndexOffset(zIndex);
      }
      entry.cat = cat;
      entry.flags = flags;
      entry.place = p;
      keep.add(p.id);
    }
    for (const [id, entry] of markers) {
      if (keep.has(id)) continue;
      placeLayer.removeLayer(entry.marker); // aufbewahren: kommt der Ort wieder (Filter aus), geht das schneller
      markers.delete(id);
      hiddenMarkers.set(id, entry);
    }
  }

  let airbnbAt = '';
  function setAirbnb(airbnb) {
    const at = airbnb ? `${airbnb.lat},${airbnb.lng}` : '';
    if (at && at === airbnbAt) { // gleiche Stelle: Marker stehen lassen, nur Text auffrischen
      airbnbMarker.setPopupContent(airbnbPopupHtml(airbnb));
      return;
    }
    airbnbAt = at;
    if (airbnbMarker) airbnbMarker.remove();
    airbnbMarker = null;
    if (!airbnb) return;

    airbnbMarker = L.marker([airbnb.lat, airbnb.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="home-pin" title="Unser Airbnb">${icon('home', { size: 15, stroke: 2.2 })}</div>`,
        iconSize: [32, 38],
        iconAnchor: [16, 38],
        popupAnchor: [0, -38],
      }),
      zIndexOffset: 2000,
      keyboard: false,
    })
      .bindPopup(airbnbPopupHtml(airbnb), { closeButton: false, className: 'llocs-popup' })
      .addTo(map);
  }

  // Hebt einen Marker hervor, ohne alle Marker neu zu zeichnen (offene Popups bleiben offen).
  function setActive(id) {
    for (const key of [activeId, id]) {
      const entry = markers.get(key);
      if (!entry) continue;
      const on = key === id;
      entry.marker.setIcon(placeIcon(entry.cat, on, entry.flags));
      entry.pin = pinHtml(entry.cat, on, entry.flags);
      entry.marker.setZIndexOffset(on ? 1000 : entry.flags.starred ? 500 : 0);
    }
    activeId = id;
  }

  function focusPlace(id) {
    const m = markers.get(id)?.marker;
    if (!m) return;
    setActive(id);
    centerOn(m.getLatLng(), Math.max(map.getZoom(), 13));
    m.openPopup();
  }

  function fitTo(places, airbnb) {
    const pts = places.filter(hasCoords).map((p) => [p.lat, p.lng]);
    if (airbnb) pts.push([airbnb.lat, airbnb.lng]);
    if (!pts.length) return map.setView(MALLORCA.center, MALLORCA.zoom);
    if (pts.length === 1) return centerOn(pts[0], 13, { animate: false });
    fitPoints(pts, 14);
  }


  // Zeichnet nur die gerade eingeblendeten Routen (Auswahl kommt aus app.js/state.ui.visibleRoutes) –
  // standardmäßig ist die Liste leer, also ist auch die Karte frei von Strecken.
  // Weiße Kontur + farbige Linie darüber, damit die Strecke auf jedem Kartenuntergrund lesbar bleibt.
  // Linien nur neu zeichnen, wenn sich Auswahl, Farbe oder Strecke geändert haben. Die Daten fürs
  // Detailfenster (gefahren, Links, Wetter) kommen beim Öffnen immer frisch aus routeNow.
  const routeNow = new Map();
  let routeKey = [];
  function setRoutes(routes) {
    routeNow.clear();
    for (const r of routes) routeNow.set(r.id, r);
    const key = routes.flatMap((r) => [r.id, r.color, r.points]);
    if (key.length === routeKey.length && key.every((v, i) => v === routeKey[i])) return;
    routeKey = key;
    routeLayer.clearLayers();
    for (const r of routes) {
      if (!r.points?.length) continue;
      const color = r.color || ROUTE_CATEGORY.ink;
      const current = () => routeNow.get(r.id) || r;
      const casing = L.polyline(r.points, { color: '#FFFFFF', weight: 6, opacity: 0.9, lineJoin: 'round', interactive: false }).addTo(routeLayer);
      const line = L.polyline(r.points, { color, weight: 3.5, opacity: 0.95, lineJoin: 'round', interactive: false }).addTo(routeLayer);
      // Unsichtbare, breite Tippfläche über der Linie – die 3,5 px schmale Linie trifft man auf dem Handy kaum
      const hit = L.polyline(r.points, { color, weight: 22, opacity: 0, lineJoin: 'round', className: 'route-hit' });
      // Inhalt erst beim Öffnen erzeugen: so zeigt das Popup immer aktuelles Wetter, Tempo und Stopps.
      // Dabei auch den Abstand zu den Boxen oben und der Liste unten setzen, damit die Karte das Popup
      // nicht dahinter, sondern in den freien Teil schiebt.
      hit.bindPopup(() => {
        const { top, right, bottom, left } = insets();
        const popup = hit.getPopup();
        popup.options.autoPanPaddingTopLeft = L.point(left + 12, top + 12);
        popup.options.autoPanPaddingBottomRight = L.point(right + 12, bottom + 12);
        return routePopup ? routePopup(current(), color) : routePopupHtml(current(), color);
      }, { closeButton: false, className: 'llocs-popup', maxWidth: 300 }).addTo(routeLayer);
      // Bei überlappenden Strecken: die berührte/angetippte Route nach vorne holen und hervorheben.
      // Nur umsortieren, wenn sie nicht schon vorne liegt – das Umsortieren mitten im Klick würde ihn verschlucken.
      const raise = () => {
        if (hit._path?.nextSibling) {
          casing.bringToFront();
          line.bringToFront();
          hit.bringToFront();
        }
        line.setStyle({ weight: 5.5 });
        casing.setStyle({ weight: 8 });
      };
      const lower = () => {
        line.setStyle({ weight: 3.5 });
        casing.setStyle({ weight: 6 });
      };
      hit.on('mouseover', raise).on('mouseout', lower).on('popupopen', raise).on('popupclose', lower);
      // Beim Planen: Tipp auf eine eingeblendete Etappe setzt dort einen Wegpunkt
      hit.on('click', (e) => {
        if (!drafting) return;
        hit.closePopup();
        onMapClick?.(e.latlng);
      });
    }
  }

  function fitToRoute(route) {
    if (!route?.points?.length) return;
    if (route.points.length === 1) return centerOn(route.points[0], 13);
    fitPoints(route.points, 14);
  }

  // Etappe planen: Entwurf { waypoints: [[lat, lng]], segments: [{ points, pending, error }] } oder null (beenden).
  // Noch nicht berechnete Abschnitte gestrichelt als Luftlinie, fehlgeschlagene rot.
  function setDraft(draft) {
    drafting = Boolean(draft);
    draftLayer.clearLayers();
    if (!draft) return;
    for (const seg of draft.segments) {
      const style = seg.error ? { color: '#C92A2A', dashArray: '6 8' } : seg.pending ? { color: PLAN_COLOR, dashArray: '6 8', opacity: 0.7 } : { color: PLAN_COLOR };
      L.polyline(seg.points, { color: '#FFFFFF', weight: 7, opacity: 0.9, lineJoin: 'round', interactive: false }).addTo(draftLayer);
      L.polyline(seg.points, { weight: 4, opacity: 0.95, lineJoin: 'round', interactive: false, ...style }).addTo(draftLayer);
    }
    draft.waypoints.forEach((p, i) => {
      L.marker(p, {
        icon: L.divIcon({ className: '', html: planPinHtml(i), iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1500,
      }).addTo(draftLayer);
    });
  }

  // Routen-Vorschau (directions.js): Linie zum Ziel oder null; passt den Ausschnitt an
  const routeLineLayer = L.layerGroup().addTo(map);
  function setRouteLine(points) {
    routeLineLayer.clearLayers();
    if (!points?.length) return;
    L.polyline(points, { color: '#FFFFFF', weight: 8, opacity: 0.9, lineJoin: 'round', interactive: false }).addTo(routeLineLayer);
    L.polyline(points, { color: ROUTE_LINE_COLOR, weight: 5, opacity: 0.95, lineJoin: 'round', interactive: false }).addTo(routeLineLayer);
    fitPoints(points, 16);
  }

  // Punkt zum Fadenkreuz im Höhenprofil (profile.js): [lat, lng] oder null
  let cursor = null;
  function setCursor(p) {
    if (!p) {
      cursor?.remove();
      cursor = null;
      return;
    }
    if (!cursor) cursor = L.circleMarker(p, { radius: 6, weight: 2, color: '#FFFFFF', fillColor: PLAN_COLOR, fillOpacity: 1, interactive: false }).addTo(map);
    else cursor.setLatLng(p);
  }

  // Trinkbrunnen und Velo-Werkstätten entlang der eingeblendeten Etappen: [{ id, type, name, lat, lng, km, routeName }]
  let poiKey = '';
  function setPois(pois) {
    const key = pois.map((x) => `${x.id}@${x.km}`).join('|');
    if (key === poiKey) return;
    poiKey = key;
    poiLayer.clearLayers();
    for (const x of pois) {
      L.marker([x.lat, x.lng], {
        icon: L.divIcon({ className: '', html: poiPinHtml(x), iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12] }),
        title: poiTitle(x),
        keyboard: false,
        zIndexOffset: -500, // unter den eigenen Orten
      }).bindPopup(poiPopupHtml(x), { closeButton: false, className: 'llocs-popup' }).addTo(poiLayer);
    }
  }

  return { map, setPlaces, setAirbnb, setActive, focusPlace, fitTo, setRoutes, fitToRoute, centerOn, setPois, setDraft, setCursor, setRouteLine, locate: () => { if (!locating) toggleLocate(); }, invalidate: () => map.invalidateSize() };
}
