// app.js - Core Application Logic for Vibezy
// ES Module

import { initMap, addVenueMarker, updateHeatmap, setVenueClickHandler, getMapCenter, getMapBounds } from './map.js';
import { startRecording, stopRecording, uploadVideo, playVideo, ensureMediaSupport } from './video.js';
import { uploadToFirebase, fetchRecentPosts, addPost, fetchVenuePosts, incrementReport, deletePost, nowServerDate } from './firebase-config.js';

// Global-ish app state contained in module scope
const state = {
  userId: null,
  userLocation: null,
  map: null,
  venues: new Map(), // venueId -> { id, name, location, address, recentActivityCount }
  posts: new Map(), // postId -> post
  currentVenueId: null,
  media: { stream: null, blob: null, thumbnailBlob: null, durationSec: 0 },
  timers: { record: null, refresh: null, heat: null, cleanup: null },
};

// Constants
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const POSTS_REFRESH_MS = 30_000;

// Utility: Toast
function showToast(message, ms = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  window.setTimeout(() => el.classList.add('hidden'), ms);
}

// Utility: Haptics
function haptic(ms = 15) { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} }

// Anonymous persistent ID
export function generateAnonymousId() {
  const existing = localStorage.getItem('userId');
  if (existing) return existing;
  const id = `anon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  localStorage.setItem('userId', id);
  return id;
}

// Rate limiting: max 3 posts/hour per device
function canPostNow() {
  const raw = localStorage.getItem('recentPosts') || '[]';
  const arr = JSON.parse(raw).filter(ts => (Date.now() - ts) < 60 * 60 * 1000);
  localStorage.setItem('recentPosts', JSON.stringify(arr));
  return arr.length < 3;
}
function recordPostTimestamp() {
  const raw = localStorage.getItem('recentPosts') || '[]';
  const arr = JSON.parse(raw);
  arr.push(Date.now());
  localStorage.setItem('recentPosts', JSON.stringify(arr));
}

// App lifecycle
export async function initApp() {
  try {
    state.userId = generateAnonymousId();
    setupEventListeners();

    // Geolocation first
    await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
      navigator.geolocation.getCurrentPosition(
        pos => { state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude }; resolve(); },
        err => { console.warn('Geolocation error', err); resolve(); },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });

    const center = state.userLocation || { lat: 40.73061, lng: -73.935242 }; // NYC fallback
    state.map = initMap(center.lat, center.lng);
    // Ensure map sizes correctly after layout
    setTimeout(() => { try { state.map && state.map.invalidateSize(true); } catch(_){} }, 250);
    window.addEventListener('resize', () => { try { state.map && state.map.invalidateSize(false); } catch(_){} });
    window.addEventListener('orientationchange', () => { try { state.map && state.map.invalidateSize(false); } catch(_){} });

    // Venue click callback
    setVenueClickHandler((venueId) => showVenueVideos(venueId));

    await loadNearbyPosts(center.lat, center.lng, true);

    // Auto refresh posts and heatmap
    state.timers.refresh = setInterval(async () => {
      const c = getMapCenter();
      await loadNearbyPosts(c.lat, c.lng, false);
    }, POSTS_REFRESH_MS);

    state.timers.heat = setInterval(() => {
      const posts = Array.from(state.posts.values());
      updateHeatmap(posts);
    }, POSTS_REFRESH_MS);

    // Periodic local cleanup of own expired content
    state.timers.cleanup = setInterval(() => cleanupExpiredContent(), 5 * 60 * 1000);

    window.addEventListener('online', () => showToast('Back online'));
    window.addEventListener('offline', () => showToast('You are offline'));
  } catch (error) {
    console.error(error);
    showToast('Failed to initialize. Some features may not work.');
  }
}

function setupEventListeners() {
  const recordBtn = document.getElementById('record-btn');
  const modal = document.getElementById('video-modal');
  const closeModal = document.getElementById('close-modal');
  const startBtn = document.getElementById('start-record');
  const stopBtn = document.getElementById('stop-record');
  const uploadBtn = document.getElementById('upload-video');
  const changeVenueBtn = document.getElementById('change-venue');
  const closeSheetBtn = document.getElementById('close-sheet');

  recordBtn?.addEventListener('click', async () => {
    if (!canPostNow()) { showToast('Rate limit: max 3 posts per hour'); return; }
    await showRecordModal();
  });

  closeModal?.addEventListener('click', () => hideRecordModal());

  startBtn?.addEventListener('click', async () => {
    try {
      haptic();
      startBtn.disabled = true; stopBtn.disabled = false;
      await ensureMediaSupport();
      await startRecording(onRecordTick);
      document.getElementById('record-overlay')?.classList.remove('hidden');
    } catch (e) {
      console.error(e); showToast(e.message || 'Unable to start recording');
      startBtn.disabled = false; stopBtn.disabled = true;
    }
  });

  stopBtn?.addEventListener('click', async () => {
    try {
      haptic();
      await stopRecording();
      startBtn.disabled = false; stopBtn.disabled = true;
      document.getElementById('record-overlay')?.classList.add('hidden');
      await prepareUploadUI();
    } catch (e) {
      console.error(e); showToast('Failed to stop recording');
    }
  });

  uploadBtn?.addEventListener('click', async () => {
    try {
      if (!state.media.blob || (state.media.durationSec || 0) < 15) {
        showToast('Please record at least 15 seconds before uploading.');
        return;
      }
      const progress = document.getElementById('upload-progress');
      progress?.classList.remove('hidden');
      const bar = progress?.querySelector('.bar');

      const location = await getCurrentLocationFallback();
      const metadata = { userId: state.userId, location, venueId: state.currentVenueId };

      const { downloadURL, storagePath, thumbnailURL } = await uploadVideo(
        state.media.blob,
        { ...metadata, durationSec: state.media.durationSec, thumbnailBlob: state.media.thumbnailBlob },
        (pct) => { if (bar) bar.style.width = `${pct}%`; }
      );

      const expiresAt = new Date(Date.now() + FOUR_HOURS_MS);
      const postData = {
        videoUrl: downloadURL,
        thumbnailUrl: thumbnailURL || null,
        location,
        venueId: state.currentVenueId,
        timestamp: nowServerDate(),
        expiresAt,
        userId: state.userId,
        reportCount: 0,
      };
      const docRef = await addPost(postData);

      recordPostTimestamp();
      showToast('Uploaded! Visible for 4 hours.');
      hideRecordModal();
      // Refresh posts
      const c = location || getMapCenter();
      await loadNearbyPosts(c.lat, c.lng, false);
    } catch (e) {
      console.error(e);
      showToast(e.userMessage || 'Upload failed. Will retry when online.');
    } finally {
      const progress = document.getElementById('upload-progress');
      progress?.classList.add('hidden');
      const bar = progress?.querySelector('.bar');
      if (bar) bar.style.width = '0%';
    }
  });

  changeVenueBtn?.addEventListener('click', async () => {
    try {
      // Open bottom sheet to pick nearby venue
      await openVenuePicker();
    } catch (e) { console.error(e); }
  });

  closeSheetBtn?.addEventListener('click', () => hideVenueSheet());

  // Listen to recorded event from video.js to store media
  window.addEventListener('vibezy:recorded', (e) => {
    const { blob, thumbnailBlob, durationSec } = e.detail || {};
    state.media.blob = blob; state.media.thumbnailBlob = thumbnailBlob; state.media.durationSec = durationSec || 0;
  });
}

function onRecordTick(seconds) {
  state.media.durationSec = seconds;
  const t = document.getElementById('timer');
  if (!t) return;
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  t.textContent = `${mm}:${ss}`;
}

async function getCurrentLocationFallback() {
  if (state.userLocation) return state.userLocation;
  return await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(getMapCenter()),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// UI flows
async function showRecordModal() {
  try {
    const modal = document.getElementById('video-modal');
    const preview = document.getElementById('record-preview');
    const uploadControls = document.getElementById('upload-controls');
    const recordControls = document.getElementById('record-controls');
    const overlay = document.getElementById('record-overlay');
    if (!modal || !preview) return;

    // Reset UI
    uploadControls?.classList.add('hidden');
    recordControls?.classList.remove('hidden');
    overlay?.classList.add('hidden');
    document.getElementById('timer').textContent = '00:00';

    modal.classList.remove('hidden');

    // Prepare stream preview
    await ensureMediaSupport();
    const ms = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
    state.media.stream = ms;
    preview.srcObject = ms;
    await preview.play().catch(() => {});
  } catch (e) {
    console.error(e);
    showToast('Camera permission denied or not available.');
  }
}

function hideRecordModal() {
  const modal = document.getElementById('video-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  const preview = document.getElementById('record-preview');
  if (preview) { try { preview.pause(); preview.removeAttribute('src'); preview.srcObject = null; } catch(_){} }
  try { state.media.stream && state.media.stream.getTracks().forEach(t => t.stop()); } catch(_){}
  state.media = { stream: null, blob: null, thumbnailBlob: null, durationSec: 0 };
  const progress = document.getElementById('upload-progress');
  progress?.classList.add('hidden');
  const bar = progress?.querySelector('.bar'); if (bar) bar.style.width = '0%';
  const hint = document.getElementById('record-hint'); if (hint) hint.textContent = 'Record 15–30 seconds. Avoid faces and private info. Be respectful.';
}

async function prepareUploadUI() {
  const recordControls = document.getElementById('record-controls');
  const uploadControls = document.getElementById('upload-controls');
  recordControls?.classList.add('hidden');
  uploadControls?.classList.remove('hidden');

  // Auto-detect venue based on proximity
  const { venueId, venueName } = await detectNearestVenue();
  state.currentVenueId = venueId;
  const label = document.getElementById('venue-label');
  if (label) label.textContent = venueName ? `Venue: ${venueName}` : 'Near an unlisted venue';
}

async function detectNearestVenue() {
  // For MVP, derive venues from cluster of posts
  const posts = Array.from(state.posts.values());
  const loc = await getCurrentLocationFallback();
  let nearest = null; let minD = Infinity;
  posts.forEach(p => {
    const d = haversine(loc.lat, loc.lng, p.location.lat, p.location.lng);
    if (d < minD) { minD = d; nearest = p; }
  });
  const withinMeters = minD * 1000;
  if (nearest && withinMeters < 120) {
    return { venueId: nearest.venueId || 'ad-hoc', venueName: nearest.venueName || 'Nearby spot' };
  }
  return { venueId: 'ad-hoc', venueName: null };
}

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // km
}

export async function showVenueVideos(venueId) {
  try {
    const sheet = document.getElementById('venue-sheet');
    const content = document.getElementById('venue-content');
    if (!sheet || !content) return;

    sheet.classList.remove('hidden');
    content.innerHTML = '<div class="placeholder">Loading…</div>';

    const posts = await fetchVenuePosts(venueId);
    if (!posts.length) { content.innerHTML = '<div class="placeholder">No videos yet. Be the first!</div>'; return; }

    const list = document.createElement('div');
    list.className = 'video-list';
    posts.forEach(p => {
      const item = document.createElement('div');
      item.className = 'video-item';
      const header = document.createElement('header');
      const time = new Date(p.timestamp?.toDate ? p.timestamp.toDate() : p.timestamp);
      header.innerHTML = `<span>${time.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>`;
      const actions = document.createElement('div'); actions.className = 'actions';
      const reportBtn = document.createElement('button'); reportBtn.className = 'secondary-btn'; reportBtn.textContent = 'Report';
      reportBtn.addEventListener('click', () => reportVideo(p.id));
      actions.appendChild(reportBtn);
      header.appendChild(actions);
      const v = document.createElement('video'); v.className = 'player'; v.setAttribute('playsinline', ''); v.setAttribute('controls', ''); v.setAttribute('muted', '');
      if (p.thumbnailUrl) v.setAttribute('poster', p.thumbnailUrl);
      v.addEventListener('click', () => v.play().catch(() => {}));
      const source = document.createElement('source'); source.src = p.videoUrl; source.type = 'video/webm';
      v.appendChild(source);
      item.appendChild(header); item.appendChild(v); list.appendChild(item);
    });
    content.innerHTML = '';
    content.appendChild(list);
  } catch (e) {
    console.error(e);
    showToast('Failed to load venue videos');
  }
}

function hideVenueSheet() {
  const sheet = document.getElementById('venue-sheet');
  sheet?.classList.add('hidden');
}

export async function reportVideo(videoId) {
  try {
    const { db } = await import('./firebase-config.js');
    const { doc, updateDoc, increment } = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js');
    await updateDoc(doc(db, 'posts', videoId), { reportCount: increment(1) });
    showToast('Reported. Thank you.');
  } catch (e) { console.error(e); showToast('Failed to report'); }
}

// Data management
export async function saveVideoPost(videoBlob, location) {
  // Deprecated in favor of uploadVideo from video.js which already handles upload
  try {
    const { downloadURL } = await uploadToFirebase(new File([videoBlob], 'vibe.webm', { type: 'video/webm' }), { userId: state.userId, location });
    const expiresAt = new Date(Date.now() + FOUR_HOURS_MS);
    return await addPost({ videoUrl: downloadURL, location, timestamp: nowServerDate(), expiresAt, userId: state.userId, reportCount: 0 });
  } catch (e) { console.error(e); throw e; }
}

export async function loadNearbyPosts(lat, lng, initial = false) {
  try {
    const bounds = getMapBounds ? getMapBounds() : undefined;
    const posts = await fetchRecentPosts(bounds);

    // Cache in state and update map markers
    const byVenue = new Map();
    posts.forEach(p => {
      state.posts.set(p.id, p);
      const key = p.venueId || 'ad-hoc';
      const arr = byVenue.get(key) || []; arr.push(p); byVenue.set(key, arr);
    });

    // Clear and then add markers for this refresh cycle
    const { resetVenueMarkers } = await import('./map.js');
    resetVenueMarkers();

    // Derive venues from posts for MVP
    byVenue.forEach((arr, key) => {
      const centroid = arr.reduce((acc, p) => ({ lat: acc.lat + p.location.lat, lng: acc.lng + p.location.lng }), { lat: 0, lng: 0 });
      centroid.lat /= arr.length; centroid.lng /= arr.length;
      const activityCount = arr.filter(p => (Date.now() - new Date(p.timestamp?.toDate ? p.timestamp.toDate() : p.timestamp).getTime()) < FOUR_HOURS_MS).length;
      addVenueMarker({ id: key, name: 'Spot', location: centroid }, activityCount);
    });

    updateHeatmap(posts);

    if (initial) showToast('Loaded nearby vibes');
  } catch (e) {
    console.error(e);
    showToast('Could not load nearby posts. Working offline.');
  }
}

export function cleanupExpiredContent() {
  try {
    const now = Date.now();
    // Remove expired posts from state
    Array.from(state.posts.values()).forEach(p => {
      const exp = new Date(p.expiresAt?.toDate ? p.expiresAt.toDate() : p.expiresAt).getTime();
      if (exp < now) state.posts.delete(p.id);
    });
  } catch (e) { console.error(e); }
}

// Venue picker (simple)
async function openVenuePicker() {
  const sheet = document.getElementById('venue-sheet');
  const content = document.getElementById('venue-content');
  if (!sheet || !content) return;
  const posts = Array.from(state.posts.values());
  const unique = new Map();
  posts.forEach(p => { const k = p.venueId || 'ad-hoc'; if (!unique.has(k)) unique.set(k, p); });
  const list = document.createElement('div'); list.className = 'video-list';
  unique.forEach((p, id) => {
    const btn = document.createElement('button'); btn.className = 'secondary-btn'; btn.style.width = '100%';
    btn.textContent = p.venueName ? p.venueName : `Nearby spot (${id})`;
    btn.addEventListener('click', () => { state.currentVenueId = id; document.getElementById('venue-label').textContent = `Venue: ${btn.textContent}`; hideVenueSheet(); });
    const wrap = document.createElement('div'); wrap.className = 'video-item';
    const header = document.createElement('header'); header.textContent = btn.textContent; wrap.appendChild(header); wrap.appendChild(btn); list.appendChild(wrap);
  });
  content.innerHTML = '';
  content.appendChild(list);
  sheet.classList.remove('hidden');
}