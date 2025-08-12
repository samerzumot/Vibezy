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

  const color = activityLevel >= 8 ? '#ef4444' : activityLevel >= 3 ? '#f59e0b' : '#10b981';
  const size = activityLevel >= 8 ? 14 : activityLevel >= 3 ? 11 : 9;

  let marker = venueMarkers.get(venue.id);
  if (!marker) {
    marker = L.circleMarker([venue.location.lat, venue.location.lng], {
      radius: size,
      color: '#0b1220',
      weight: 2,
      fillColor: color,
      fillOpacity: 0.9,
      title: venue.name || 'Spot',
    }).addTo(venueLayer);
    marker.on('click', () => { onVenueClick && onVenueClick(venue.id); });
    venueMarkers.set(venue.id, marker);
  } else {
    marker.setLatLng([venue.location.lat, venue.location.lng]);
    marker.setStyle({ radius: size, fillColor: color });
  }
}

export function updateHeatmap(posts) {
  if (!heatLayer) return;
  heatLayer.clearLayers();
  const now = Date.now();
  posts.forEach(p => {
    const ageMs = now - new Date(p.timestamp?.toDate ? p.timestamp.toDate() : p.timestamp).getTime();
    const freshness = Math.max(0.1, 1 - (ageMs / (4 * 60 * 60 * 1000))); // 0..1
    const color = ageMs < 60 * 60 * 1000 ? '#ef4444' : ageMs < 2 * 60 * 60 * 1000 ? '#f59e0b' : '#10b981';
    L.circle([p.location.lat, p.location.lng], {
      radius: 50 + 200 * freshness, // meters
      color: color,
      fillColor: color,
      fillOpacity: 0.15 * (0.5 + freshness),
      weight: 0,
    }).addTo(heatLayer);
  });
}