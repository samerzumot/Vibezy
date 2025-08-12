// map.js - Leaflet Map Integration
// ES Module

let mapInstance = null;
let userMarker = null;
let venueLayer = null;
let heatLayer = null; // simple circles for activity visualization
let onVenueClick = null;
const venueMarkers = new Map(); // id -> marker

export function initMap(lat, lng) {
  if (mapInstance) return mapInstance;
  mapInstance = L.map('map-container', {
    zoomControl: false,
    attributionControl: true,
  }).setView([lat, lng], 15);

  const tile1 = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: ['a','b','c'],
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors',
  });
  tile1.addTo(mapInstance);

  // Secondary fallback provider
  tile1.on('tileerror', () => {
    try {
      const alt = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', { subdomains: ['a','b','c'], maxZoom: 20 });
      alt.addTo(mapInstance);
    } catch (_) {}
  });

  // User blue dot
  userMarker = L.circleMarker([lat, lng], {
    radius: 6,
    color: '#3b82f6',
    weight: 2,
    fillColor: '#60a5fa',
    fillOpacity: 0.7,
  }).addTo(mapInstance);

  venueLayer = L.layerGroup().addTo(mapInstance);
  heatLayer = L.layerGroup().addTo(mapInstance);

  // Try track user location updates
  if (navigator.geolocation) {
    navigator.geolocation.watchPosition((pos) => {
      const p = [pos.coords.latitude, pos.coords.longitude];
      userMarker.setLatLng(p);
    }, () => {}, { enableHighAccuracy: true });
  }

  return mapInstance;
}

export function getMapCenter() {
  const c = mapInstance.getCenter();
  return { lat: c.lat, lng: c.lng };
}

export function getMapBounds() {
  const b = mapInstance.getBounds();
  return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
}

export function setVenueClickHandler(cb) { onVenueClick = cb; }

export function resetVenueMarkers() {
  venueLayer.clearLayers();
  venueMarkers.clear();
}

export function addVenueMarker(venue, activityLevel) {
  if (!venueLayer) return;

  const avatarUrl = venue.avatarUrl || 'https://i.pravatar.cc/80?img=' + (Math.floor(Math.random() * 70) + 1);
  const count = typeof activityLevel === 'number' ? activityLevel : 0;

  const html = `
    <div class="avatar-marker">
      <div class="ring">
        <div class="inner"><img src="${avatarUrl}" alt="" /></div>
        <div class="badge">${count}</div>
      </div>
      <span class="label">${escapeHtml(venue.name || 'Spot')}</span>
    </div>`;

  const icon = L.divIcon({ html, className: '', iconSize: [0, 0] });

  let marker = venueMarkers.get(venue.id);
  if (!marker) {
    marker = L.marker([venue.location.lat, venue.location.lng], { icon });
    marker.addTo(venueLayer);
    marker.on('click', () => { onVenueClick && onVenueClick(venue.id); });
    venueMarkers.set(venue.id, marker);
  } else {
    marker.setLatLng([venue.location.lat, venue.location.lng]);
    marker.setIcon(icon);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]?/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
}

export function updateHeatmap(posts) {
  if (!heatLayer) return;
  heatLayer.clearLayers();
  const now = Date.now();
  // Convert posts to heat points: [lat, lng, intensity]
  const points = posts.map(p => {
    const ageMs = now - new Date(p.timestamp?.toDate ? p.timestamp.toDate() : p.timestamp).getTime();
    const freshness = Math.max(0.15, 1 - (ageMs / (4 * 60 * 60 * 1000)));
    return [p.location.lat, p.location.lng, freshness];
  });
  if (points.length === 0) return;
  const h = L.heatLayer(points, {
    radius: 28,
    blur: 22,
    maxZoom: 18,
    gradient: { 0.2: '#22d3ee', 0.4: '#60a5fa', 0.6: '#f59e0b', 0.8: '#ef4444', 1.0: '#dc2626' }
  });
  h.addTo(heatLayer);
}

export function locate(lat, lng) {
  if (!mapInstance) return;
  mapInstance.flyTo([lat, lng], 16, { duration: 0.6 });
}