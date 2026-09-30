// Leaflet-Karte: Orts-Marker, Airbnb-Marker, Radius-Kreis und Rennrad-Routen (Linien statt Punkte).
/* global L */

import { hasCoords, formatKm } from './geo.js';
import { icon, categoryIcon, categoryStyle } from './icons.js';
import { ROUTE_CATEGORY } from './categories.js';

const MALLORCA = { center: [39.62, 2.95], zoom: 9 };

// Kartenkacheln von OpenStreetMap: kein API-Key nötig. Die Farbanpassung kommt per CSS-Filter
// (.leaflet-tile-pane in styles.css) – dort werden sie zurückgenommen, damit Orange und Grün leuchten. CARTO-Kacheln verlangen inzwischen einen API-Key.
const TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
  maxZoom: 19,
};

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Ersatz, falls Leaflet nicht geladen werden konnte: Die App läuft ohne Karte weiter,
// statt beim Start komplett abzubrechen (dann fehlte auch die Ortsliste).
function createFallbackMap(el) {
  el.innerHTML = '<div class="map-error"><strong>Karte nicht verfügbar</strong><span>Die Kartenbibliothek konnte nicht geladen werden. Liste und Filter funktionieren trotzdem – Seite neu laden versuchen.</span></div>';
  const noop = () => {};
  const fakeMap = { flyTo: noop, getZoom: () => 9, setView: noop, fitBounds: noop };
  return { map: fakeMap, setPlaces: noop, setAirbnb: noop, setActive: noop, focusPlace: noop, fitTo: noop, setRoutes: noop, fitToRoute: noop, centerOn: noop, invalidate: noop };
}

export function createMap(el, { onMapClick, onMarkerClick, getInsets }) {
  if (typeof L === 'undefined') return createFallbackMap(el);
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView(MALLORCA.center, MALLORCA.zoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer(TILES.url, { attribution: TILES.attribution, maxZoom: TILES.maxZoom }).addTo(map);

  const placeLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const markers = new Map();
  let airbnbMarker = null;
  let activeId = null;

  map.on('click', (e) => onMapClick?.(e.latlng));

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

  function fitPoints(pts, maxZoom) {
    const { top, right, bottom, left } = insets();
    map.fitBounds(pts, {
      paddingTopLeft: [left + 40, top + 40],
      paddingBottomRight: [right + 40, bottom + 40],
      maxZoom,
    });
  }

  function placeIcon(cat, active) {
    return L.divIcon({
      className: '',
      html: `<div class="pin${active ? ' is-active' : ''}" style="${categoryStyle(cat)}">${categoryIcon(cat, { size: 14, stroke: 2.3 })}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -20],
    });
  }

  function popupHtml(p, cat) {
    const dist = p.distance != null ? `<span class="popup-dist">${formatKm(p.distance)} von der Unterkunft</span>` : '';
    const gmaps = p.url || `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
    return `
      <div class="popup">
        <span class="popup-cat" style="${categoryStyle(cat)}">${escapeHtml(cat.label)}</span>
        <strong class="popup-name">${escapeHtml(p.name)}</strong>
        ${p.address ? `<span class="popup-addr">${escapeHtml(p.address)}</span>` : ''}
        ${dist}
        <a class="popup-link" href="${escapeHtml(gmaps)}" target="_blank" rel="noopener">In Google Maps öffnen ↗</a>
      </div>`;
  }

  function setPlaces(places, catOf, currentId) {
    activeId = currentId;
    placeLayer.clearLayers();
    markers.clear();
    for (const p of places) {
      if (!hasCoords(p)) continue;
      const cat = catOf(p.category);
      const m = L.marker([p.lat, p.lng], {
        icon: placeIcon(cat, p.id === currentId),
        title: p.name,
        zIndexOffset: p.id === currentId ? 1000 : 0,
        riseOnHover: true,
      });
      m.bindPopup(popupHtml(p, cat), { closeButton: false, className: 'llocs-popup' });
      m.on('click', () => onMarkerClick?.(p.id));
      m.addTo(placeLayer);
      markers.set(p.id, { marker: m, cat });
    }
  }

  function setAirbnb(airbnb) {
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
      .bindPopup(`<div class="popup"><span class="popup-cat" style="--c:#3F6B34;--ci:#3F6B34">Unser Airbnb</span><strong class="popup-name">${escapeHtml(airbnb.label)}</strong></div>`, { closeButton: false, className: 'llocs-popup' })
      .addTo(map);
  }

  // Hebt einen Marker hervor, ohne alle Marker neu zu zeichnen (offene Popups bleiben offen).
  function setActive(id) {
    for (const key of [activeId, id]) {
      const entry = markers.get(key);
      if (!entry) continue;
      const on = key === id;
      entry.marker.setIcon(placeIcon(entry.cat, on));
      entry.marker.setZIndexOffset(on ? 1000 : 0);
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

  function routePopupHtml(r) {
    return `
      <div class="popup">
        <span class="popup-cat" style="${categoryStyle(ROUTE_CATEGORY)}">${escapeHtml(ROUTE_CATEGORY.label)}</span>
        <strong class="popup-name">${escapeHtml(r.name)}</strong>
        <span class="popup-dist">${formatKm(r.distanceKm)}${Number.isFinite(r.elevationGainM) ? ` · ↑ ${Math.round(r.elevationGainM).toLocaleString('de-DE')} Hm` : ''}${Number.isFinite(r.elevationLossM) ? ` · ↓ ${Math.round(r.elevationLossM).toLocaleString('de-DE')} Hm` : ''}</span>
      </div>`;
  }

  // Zeichnet nur die gerade eingeblendeten Routen (Auswahl kommt aus app.js/state.ui.visibleRoutes) –
  // standardmäßig ist die Liste leer, also ist auch die Karte frei von Strecken.
  // Weiße Kontur + farbige Linie darüber, damit die Strecke auf jedem Kartenuntergrund lesbar bleibt.
  function setRoutes(routes) {
    routeLayer.clearLayers();
    for (const r of routes) {
      if (!r.points?.length) continue;
      L.polyline(r.points, { color: '#FFFFFF', weight: 6, opacity: 0.9, lineJoin: 'round', interactive: false }).addTo(routeLayer);
      L.polyline(r.points, { color: ROUTE_CATEGORY.ink, weight: 3.5, opacity: 0.95, lineJoin: 'round' })
        .bindPopup(routePopupHtml(r), { closeButton: false, className: 'llocs-popup' })
        .addTo(routeLayer);
    }
  }

  function fitToRoute(route) {
    if (!route?.points?.length) return;
    if (route.points.length === 1) return centerOn(route.points[0], 13);
    fitPoints(route.points, 14);
  }

  return { map, setPlaces, setAirbnb, setActive, focusPlace, fitTo, setRoutes, fitToRoute, centerOn, invalidate: () => map.invalidateSize() };
}
