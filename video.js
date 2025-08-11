// video.js - MediaRecorder Implementation
// ES Module

import { uploadToFirebase } from './firebase-config.js';

let mediaRecorder = null;
let chunks = [];
let previewEl = null;
let recordTimer = null;
let secondsElapsed = 0;

export async function ensureMediaSupport() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera not supported in this browser');
  }
  if (!window.MediaRecorder) {
    throw new Error('Recording not supported on this device');
  }
}

export async function startRecording(onTick) {
  try {
    previewEl = document.getElementById('record-preview');
    const constraints720 = { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment', frameRate: { ideal: 30 } }, audio: true };
    const constraints480 = { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment', frameRate: { ideal: 24 } }, audio: true };

    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia(constraints720); }
    catch { stream = await navigator.mediaDevices.getUserMedia(constraints480); }

    previewEl.srcObject = stream;
    await previewEl.play().catch(() => {});

    const options = getBestMediaRecorderOptions();
    mediaRecorder = new MediaRecorder(stream, options);
    chunks = [];

    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    const stopAfterMs = 30_000; // 30s auto stop
    secondsElapsed = 0;
    recordTimer = window.setInterval(() => { secondsElapsed += 1; onTick && onTick(secondsElapsed); }, 1000);

    mediaRecorder.start();
    // Auto stop after 30s
    window.setTimeout(() => { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); }, stopAfterMs);

    // Enable stop button externally
  } catch (error) {
    throw error;
  }
}

export async function stopRecording() {
  return new Promise((resolve, reject) => {
    try {
      if (!mediaRecorder) throw new Error('Not recording');
      mediaRecorder.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' });
          clearInterval(recordTimer);
          const durationSec = secondsElapsed;
          secondsElapsed = 0;
          if (durationSec < 15) {
            showInlineHint('Clip too short. Please record at least 15 seconds.');
          }
          // Generate thumbnail
          const thumbnailBlob = await generateThumbnailFromBlob(blob).catch(() => null);
          // Basic size hint
          if (blob.size > 10 * 1024 * 1024) {
            showInlineHint('Large file (>10MB). We will try to compress before upload.');
          }
          const compactBlob = blob.size > 10 * 1024 * 1024 ? await tryReencodeLowerBitrate(blob) : blob;
          const evt = new CustomEvent('vibezy:recorded', { detail: { blob: compactBlob, thumbnailBlob, durationSec: Math.max(15, Math.min(30, durationSec)) } });
          window.dispatchEvent(evt);
          resolve();
        } catch (e) { reject(e); }
      };
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      setTimeout(() => { try { const s = previewEl?.srcObject; s && s.getTracks().forEach(t => t.stop()); } catch(_){} }, 200);
    } catch (e) { reject(e); }
  });
}

export async function uploadVideo(blob, metadata = {}, onProgress) {
  try {
    const fileName = `vibe_${Date.now()}.webm`;
    const file = new File([blob], fileName, { type: blob.type || 'video/webm' });
    const { downloadURL, storagePath, thumbnailURL } = await uploadToFirebase(file, metadata, onProgress);
    return { downloadURL, storagePath, thumbnailURL };
  } catch (e) {
    e.userMessage = 'Upload failed.';
    throw e;
  }
}

export function playVideo(videoUrl, container) {
  const v = document.createElement('video');
  v.src = videoUrl; v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.setAttribute('controls', '');
  v.autoplay = true; v.muted = true;
  container.innerHTML = '';
  container.appendChild(v);
  v.play().catch(() => {});
}

export function getRecordingDurationSeconds() { return secondsElapsed; }

function getBestMediaRecorderOptions() {
  const mimeTypes = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const t of mimeTypes) { if (MediaRecorder.isTypeSupported(t)) return { mimeType: t, bitsPerSecond: 1_500_000 }; }
  return { bitsPerSecond: 1_200_000 };
}

async function generateThumbnailFromBlob(videoBlob) {
  const video = document.createElement('video');
  const url = URL.createObjectURL(videoBlob);
  video.src = url;
  video.muted = true; video.playsInline = true;
  await video.play().catch(() => {});
  await new Promise(r => setTimeout(r, 300)); // wait a bit to load a frame

  const canvas = document.createElement('canvas');
  const w = 480; const h = Math.round((video.videoHeight / video.videoWidth) * w) || 270;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  URL.revokeObjectURL(url);
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
}

async function tryReencodeLowerBitrate(blob) {
  try {
    // Re-mux via MediaRecorder by playing into a canvas stream at lower fps/size
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    await video.play().catch(() => {});
    await new Promise(r => setTimeout(r, 200));

    const targetWidth = 640;
    const targetHeight = Math.round((video.videoHeight / video.videoWidth) * targetWidth) || 360;

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth; canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    const stream = canvas.captureStream(20); // 20 fps
    const destChunks = [];
    const options = getBestMediaRecorderOptions();
    const rec = new MediaRecorder(stream, { ...options, bitsPerSecond: 800_000 });
    rec.ondataavailable = (e) => { if (e.data.size > 0) destChunks.push(e.data); };

    rec.start(200);
    const start = performance.now();
    while (performance.now() - start < Math.min(30000, (blob.size / (1_500_000/8)) * 1000)) {
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      await new Promise(r => requestAnimationFrame(r));
    }
    rec.stop();
    await new Promise(r => setTimeout(r, 250));
    URL.revokeObjectURL(video.src);
    return new Blob(destChunks, { type: destChunks[0]?.type || 'video/webm' });
  } catch (_) {
    return blob; // fallback to original
  }
}

function showInlineHint(text) {
  const hint = document.getElementById('record-hint');
  if (hint) hint.textContent = text;
}

// Listen for recorded media to store in app state
window.addEventListener('vibezy:recorded', (e) => {
  // app.js will read state.media by listening to this event if needed; but we will set DOM flags only
});