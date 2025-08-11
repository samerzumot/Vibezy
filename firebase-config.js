// firebase-config.js - Backend Integration
// ES Module

// SETUP INSTRUCTIONS:
// 1. Create project at console.firebase.google.com
// 2. Enable Firestore, Storage, Hosting
// 3. Replace firebaseConfig with your keys
// 4. Deploy with: firebase deploy

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import { getFirestore, collection, query, where, orderBy, limit, getDocs, addDoc, updateDoc, serverTimestamp, Timestamp, doc, deleteDoc } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';
import { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js';

// Initialize Firebase (use placeholder config)
const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  messagingSenderId: 'SENDER_ID',
  appId: 'APP_ID',
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

export function nowServerDate() { return serverTimestamp(); }

// Firestore collections
// "posts": { videoUrl, location, timestamp, expiresAt, userId, reportCount, venueId, thumbnailUrl }
// "venues": { name, location, address, recentActivityCount }

export async function uploadToFirebase(file, metadata = {}, onProgress) {
  try {
    // Basic validation
    if (!file || !file.type.startsWith('video/')) throw new Error('Invalid file');

    const userId = metadata.userId || 'anon';
    const path = `videos/${userId}/${Date.now()}_${file.name}`;
    const storageRef = ref(storage, path);

    const uploadTask = uploadBytesResumable(storageRef, file, { contentType: file.type, cacheControl: 'public,max-age=3600' });

    const downloadURL = await new Promise((resolve, reject) => {
      uploadTask.on('state_changed', (snap) => {
        if (onProgress) {
          const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
          onProgress(pct);
        }
      }, (err) => reject(err), async () => {
        const url = await getDownloadURL(uploadTask.snapshot.ref);
        resolve(url);
      });
    });

    // Optionally upload thumbnail if provided in metadata
    let thumbnailURL = null;
    if (metadata.thumbnailBlob) {
      const thumbPath = `thumbnails/${userId}/${Date.now()}.jpg`;
      const thumbRef = ref(storage, thumbPath);
      await uploadBytesResumable(thumbRef, metadata.thumbnailBlob, { contentType: 'image/jpeg', cacheControl: 'public,max-age=86400' });
      thumbnailURL = await getDownloadURL(thumbRef);
    }

    return { downloadURL, storagePath: path, thumbnailURL };
  } catch (e) { console.error(e); throw e; }
}

export async function addPost(data) {
  try {
    // Ensure expiration is set client-side to 4 hours if not provided
    if (!data.expiresAt) data.expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    if (!data.timestamp) data.timestamp = serverTimestamp();

    // Input safety
    if (!data.location || typeof data.location.lat !== 'number' || typeof data.location.lng !== 'number') {
      throw new Error('Invalid location');
    }
    if (typeof data.videoUrl !== 'string' || !data.videoUrl.startsWith('https://')) throw new Error('Invalid video URL');

    const postsCol = collection(db, 'posts');
    const refDoc = await addDoc(postsCol, data);
    return refDoc;
  } catch (e) { console.error(e); throw e; }
}

export async function fetchRecentPosts(bounds) {
  try {
    // Efficient Firestore queries (time-based). For geo, we filter client-side for simplicity.
    const since = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const q = query(collection(db, 'posts'), where('timestamp', '>', Timestamp.fromDate(since)), orderBy('timestamp', 'desc'), limit(200));
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(docu => {
      const d = docu.data();
      if (!d.location) return;
      if (bounds) {
        if (d.location.lat > bounds.north || d.location.lat < bounds.south) return;
        if (d.location.lng > bounds.east || d.location.lng < bounds.west) return;
      }
      items.push({ id: docu.id, ...d });
    });
    return items;
  } catch (e) { console.error(e); return []; }
}

export async function fetchVenuePosts(venueId) {
  try {
    // Fallback: fetch recent and filter by venue
    const since = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const q = query(collection(db, 'posts'), where('timestamp', '>', Timestamp.fromDate(since)), orderBy('timestamp', 'desc'), limit(200));
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(docu => { const d = docu.data(); if ((d.venueId || 'ad-hoc') === venueId) items.push({ id: docu.id, ...d }); });
    return items;
  } catch (e) { console.error(e); return []; }
}

export async function incrementReport(postId) {
  try {
    const { increment } = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js');
    const refDoc = doc(db, 'posts', postId);
    await updateDoc(refDoc, { reportCount: increment(1) });
  } catch (e) { console.error(e); throw e; }
}

export async function fetchReportedPosts() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const q = query(collection(db, 'posts'), where('timestamp', '>', Timestamp.fromDate(since)), orderBy('timestamp', 'desc'), limit(300));
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(d => { const data = d.data(); if ((data.reportCount || 0) > 0) items.push({ id: d.id, ...data }); });
    return items;
  } catch (e) { console.error(e); return []; }
}

export async function deletePost(postId) {
  try {
    // Load post to get its videoUrl
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const q = query(collection(db, 'posts'), where('timestamp', '>', Timestamp.fromDate(since)), limit(400));
    const snap = await getDocs(q);
    let target = null;
    snap.forEach(d => { if (d.id === postId) target = { id: d.id, ...d.data() }; });

    if (target && target.videoUrl) {
      // Delete storage object (best-effort)
      try {
        const videoRef = ref(storage, target.videoUrl);
        await deleteObject(videoRef);
      } catch (_) { /* ignore if using gs:// or URL ref not resolvable */ }
    }
    const refDoc = doc(db, 'posts', postId);
    await deleteDoc(refDoc);
  } catch (e) { console.error(e); throw e; }
}