/*
 * EdenExporter — portable HTML5 core (phase 1).
 *
 * Faithful rewrite of the DroidScript-era export1.js: an audio-driven
 * three-dimensional oscilloscope. A green sphere is steered by the first
 * FFT bin of whatever is playing, tracing a spiral path that can be
 * exported as a .obj polyline.
 *
 * DroidScript-isms removed:
 *   - file:///android_asset/app.js bridge  -> pure ES modules
 *   - app.WriteFile("/sdcard/...")        -> Blob + anchor download
 *   - THREE.Geometry (long removed)       -> THREE.BufferGeometry
 *   - dat.GUI                             -> lil-gui (ESM)
 *   - bundled osc.mp3 fetched over HTTP   -> demo track baked into the page
 *                                           as base64, decoded at runtime
 *                                           (no media fetch needed to begin)
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { TRACK_DATA_B64, TRACK_LABEL, TRACK_ATTRIBUTION } from './assets/track-data.js';

// ---------------------------------------------------------------------------
// Config (values kept faithful to the original)
// ---------------------------------------------------------------------------
const FFT_SIZE = 128;              // original analyser fftSize
const FPS = 30;                    // original throttled its render loop to ~30fps
const MAX_TRACE_POINTS = 200000;   // preallocated trace buffer cap
const SKYBOX_FILES = ['mbk.png', 'mft.png', 'mup.png', 'mdn.png', 'mlf.png', 'mrt.png'];

// Mobile profile: phones get a lighter GPU path (no MSAA, pixelRatio 1,
// low-power preference). Re-uploading the whole trace buffer every frame
// crashed mobile GPUs on touch; see step() below.
const IS_MOBILE = window.matchMedia('(pointer: coarse)').matches ||
  Math.min(window.screen.width, window.screen.height) < 768;

// iOS Safari: Web Audio output obeys the iPhone silent switch (and the media
// volume), which no web API can detect or override — so the UI says so on
// screen instead of failing silently. (iPadOS 13+ reports as MacIntel, hence
// the touch-points check.)
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let scene, camera, renderer, controls, sphere;
let traceGeo, traceAttr;
let traceCount = 0;
const tracePositions = new Float32Array(MAX_TRACE_POINTS * 3);

let audioCtx, analyser, freqData, bufferSource;
let started = false;
let simTime = 0;
let glAlive = true; // cleared on webglcontextlost, set again on restore
let lastAudioCheck = 0; // throttle for the suspended-context watchdog in render()
let currentTrackText = '';
let gui; // lil-gui panel: lives in the intro card until Begin, then docks top-right
let silentSeconds = 0;   // consecutive seconds of all-zero FFT bins (silence probe)
let silenceWarned = false;
const currentPosition = new THREE.Vector3();
const fileInput = document.getElementById('file-input');
const trackLabel = document.getElementById('track-label');
const creditFooter = document.getElementById('credit-footer');
// Footer credit always names what's actually playing.
function setCredit(html) { creditFooter.innerHTML = html; }

// GUI-tunable parameters — same names, ranges, and defaults as the original.
const params = {
  time: 0.001,
  radius: 0.1,
  velocity: 0.1,
  'Load song...': () => { if (started) fileInput.click(); },
  'Export .obj + FFT': () => { if (started) exportAll(); },
};

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
function initScene() {
  scene = new THREE.Scene();

  // Skybox (same six faces, same order as the original).
  const skybox = new THREE.CubeTextureLoader()
    .setPath('assets/')
    .load(SKYBOX_FILES);
  skybox.colorSpace = THREE.SRGBColorSpace;
  scene.background = skybox;

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(180, 180, 180);

  renderer = new THREE.WebGLRenderer({
    antialias: !IS_MOBILE,
    powerPreference: IS_MOBILE ? 'low-power' : 'high-performance',
  });
  renderer.setPixelRatio(IS_MOBILE ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const canvas = renderer.domElement;
  // Touch gestures belong to the canvas only (OrbitControls binds there);
  // the rest of the page keeps default touch behavior (scroll, tap).
  canvas.style.touchAction = 'none';

  // Graceful WebGL recovery: a lost context (backgrounded tab, GPU reset)
  // pauses the loop instead of dying; tapping the canvas restores it.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // allow the browser to restore the context later
    glAlive = false;
    setStatus('\u26A0 graphics paused \u2014 tap the canvas to resume');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    // GPU-side buffers are gone; force a full re-upload from our arrays.
    traceAttr.needsUpdate = true;
    glAlive = true;
    setStatus('\u266A ' + currentTrackText);
    render();
  });
  canvas.addEventListener('pointerdown', () => {
    if (!glAlive) renderer.forceContextRestore();
  });

  controls = new OrbitControls(camera, renderer.domElement);

  // The green sphere, radius 8, like the original.
  const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  sphere = new THREE.Mesh(new THREE.SphereGeometry(8, 20, 10), material);
  scene.add(sphere);

  // Trace path: one THREE.Line over a preallocated dynamic buffer.
  traceGeo = new THREE.BufferGeometry();
  traceAttr = new THREE.BufferAttribute(tracePositions, 3);
  traceAttr.setUsage(THREE.DynamicDrawUsage);
  traceGeo.setAttribute('position', traceAttr);
  traceGeo.setDrawRange(0, 0);
  const traceLine = new THREE.Line(
    traceGeo,
    new THREE.LineBasicMaterial({ color: 0x00ff00 })
  );
  traceLine.frustumCulled = false; // positions update in place; don't let culling hide it
  scene.add(traceLine);

  resetTrace();

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
}

function initGUI() {
  gui = new GUI({
    title: 'EdenExporter',
    // In normal flow inside the intro card (below the description) instead of
    // lil-gui's default fixed top-right overlay, which covered the
    // description text on phone widths and intercepted taps meant for the
    // card. Passing a container also disables lil-gui's auto-place fixed
    // positioning; on Begin the panel is moved to #gui-dock (see boot).
    container: document.getElementById('gui-slot'),
  });
  gui.add(params, 'time', 0.001, 0.1).step(0.001).name('time');
  gui.add(params, 'radius', 0.1, 3).name('radius');
  gui.add(params, 'velocity', 0.1, 3).name('velocity');
  gui.add(params, 'Load song...');
  gui.add(params, 'Export .obj + FFT');
}

// ---------------------------------------------------------------------------
// Audio — everything plays through one decodeAudioData path.
// ---------------------------------------------------------------------------
function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Same graph shape as the original: source -> analyser -> destination.
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.connect(audioCtx.destination);

  freqData = new Uint8Array(analyser.frequencyBinCount);

  // Mobile browsers suspend audio when the tab backgrounds; resume as soon
  // as we're visible again instead of going silent.
  const tryResume = () => {
    if (started && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  };
  audioCtx.onstatechange = tryResume;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tryResume();
  });
}

function b64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function setStatus(text) {
  trackLabel.hidden = false;
  trackLabel.textContent = text;
}

function playBuffer(buffer, label, credit) {
  // BufferSources are one-shot; build a fresh node per track.
  stopCurrentSource();
  bufferSource = audioCtx.createBufferSource();
  bufferSource.buffer = buffer;
  bufferSource.loop = true; // the original set layer.loop = true
  bufferSource.connect(analyser);
  bufferSource.start();
  currentTrackText = label;
  setStatus('\u266A ' + label);
  // The footer credit follows whatever is actually playing — demo credit for
  // the demo, the filename for user-loaded songs (it used to stay stuck on
  // the old demo credit no matter what played).
  setCredit(credit !== undefined ? credit : '\u266A ' + label);
}

// One active source at a time: stop whatever is playing (demo track or mic)
// before starting another, and release the mic hardware when we leave it.
function stopCurrentSource() {
  if (bufferSource) {
    try { bufferSource.stop(); } catch (e) { /* already stopped */ }
    bufferSource.disconnect();
    bufferSource = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

// ---------------------------------------------------------------------------
// Mic listen mode — the visualizer dances to the room (Spotify, car radio…)
// ---------------------------------------------------------------------------
let micStream = null;

// Called synchronously inside the Begin tap: iOS Safari only grants
// microphone access from a user gesture.
function requestMicStream() {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    // Raw signal, no voice processing: this is a music visualizer, and
    // echoCancellation would fight the room audio. Plain (non-exact)
    // constraints are best-effort, so this never rejects for lack of support.
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }
  // Legacy iOS Safari (< ~14.3): callback-style webkitGetUserMedia.
  const legacy = navigator.webkitGetUserMedia || navigator.getUserMedia;
  if (legacy) {
    return new Promise((resolve, reject) => {
      legacy.call(navigator, { audio: true }, resolve, reject);
    });
  }
  return Promise.reject(new Error('microphone not supported on this browser'));
}

function startMicSource(stream) {
  stopCurrentSource();
  micStream = stream;
  // Deliberately NOT connected to audioCtx.destination: routing the live mic
  // to the speakers would howl with feedback. The analyser tap alone drives
  // the visualizer, and a dead mic just yields zeros (the per-frame guard and
  // the silence probe in render() handle that gracefully).
  const micNode = audioCtx.createMediaStreamSource(stream);
  micNode.connect(analyser);
  currentTrackText = '\uD83C\uDFA4 mic listen mode';
  setStatus('\uD83C\uDFA4 mic listen mode \u2014 play anything in the room');
  setCredit('\uD83C\uDFA4 mic listen mode');
}

// decodeAudioData should settle in well under a second for a 30s MP3; if it
// hangs (older iOS never resolving the promise form), fall back to synth
// instead of sitting on "Loading…" forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
  ]);
}

async function playEmbeddedTrack() {
  // The demo track is baked into the page as base64: no fetch, no file
  // picker, nothing that can fail before the first note.
  try {
    const buffer = await withTimeout(
      audioCtx.decodeAudioData(b64ToBuffer(TRACK_DATA_B64)),
      10000,
      'demo track decode'
    );
    playBuffer(buffer, TRACK_LABEL, '\u266A ' + TRACK_ATTRIBUTION);
  } catch (err) {
    // Last resort: synthesize a short looping pad in-memory so the
    // visualization still dances even if the decode fails.
    console.warn('demo track decode failed, using synthesized fallback:', err);
    playBuffer(await synthFallbackLoop(), TRACK_LABEL + ' (synth fallback)');
  }
}

// ~8s evolving pad rendered offline: stacked sines with slow swells, so the
// FFT has real low-frequency energy to chew on. Only used if the embedded
// MP3 can't be decoded.
async function synthFallbackLoop() {
  const seconds = 8;
  const sampleRate = audioCtx.sampleRate;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineCtx(2, seconds * sampleRate, sampleRate);
  const notes = [55, 82.5, 110, 130.81, 164.81]; // A1 E2 A2 C3 E3
  for (const freq of notes) {
    for (const detune of [-4, 3]) {
      const osc = offline.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const gain = offline.createGain();
      gain.gain.setValueAtTime(0.0001, 0);
      // Slow swells, staggered per voice, so the loop point stays smooth.
      for (let t = 0; t < seconds; t += 2) {
        gain.gain.exponentialRampToValueAtTime(0.12, t + 1);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 2);
      }
      osc.connect(gain).connect(offline.destination);
      osc.start(0);
      osc.stop(seconds);
    }
  }
  return offline.startRendering();
}

async function handleFile(file) {
  if (!file || !started) return;
  setStatus('decoding ' + file.name + ' \u2026');
  try {
    const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
    playBuffer(buffer, file.name + ' (your song)');
  } catch (err) {
    console.warn('could not decode audio file:', err);
    setStatus('\u26A0 could not play that file');
    setTimeout(() => setStatus('\u266A ' + currentTrackText), 2500);
  }
}

// ---------------------------------------------------------------------------
// Simulation — the original's spiral formula, untouched
// ---------------------------------------------------------------------------
function resetTrace() {
  simTime = 0;
  // Seed the trace with the original's starting point so the first frame's
  // segment matches the old per-segment LineSegments geometry exactly.
  tracePositions[0] = params.radius;
  tracePositions[1] = 0;
  tracePositions[2] = 0;
  traceCount = 1;
  // Full re-upload: a reset rewrites the head of the buffer, and any pending
  // partial ranges from the old trace no longer apply.
  if (typeof traceAttr.clearUpdateRanges === 'function') traceAttr.clearUpdateRanges();
  traceAttr.needsUpdate = true;
  traceGeo.setDrawRange(0, traceCount);
  sphere.position.set(params.radius, 0, 0);
}

// Mark only [start, start+count) floats dirty. Uploading the whole 200k-point
// buffer every frame is what crashed mobile GPUs; the renderer clears these
// ranges itself after each upload.
function markTraceDirty(start, count) {
  if (typeof traceAttr.addUpdateRange === 'function') {
    traceAttr.addUpdateRange(start, count);
  } else {
    traceAttr.updateRange.offset = start;
    traceAttr.updateRange.count = count;
  }
  traceAttr.needsUpdate = true;
}

function step() {
  analyser.getByteFrequencyData(freqData);

  if (params.time < freqData.length) {
    // Original: time += (.001 + guiParams.time)
    simTime += 0.001 + params.time;

    // Original spiral, driven by the first FFT bin:
    //   x = (freq[0]*radius) * sin(2*pi*t)
    //   y = (velocity*freq[0]) * t
    //   z = (freq[0]*radius) * cos(2*pi*t)
    const f0 = freqData[0];
    currentPosition.set(
      (f0 * params.radius) * Math.sin(2 * Math.PI * simTime),
      (params.velocity * f0) * simTime,
      (f0 * params.radius) * Math.cos(2 * Math.PI * simTime)
    );
    sphere.position.copy(currentPosition);

    if (traceCount < MAX_TRACE_POINTS) {
      const i3 = traceCount * 3;
      tracePositions[i3] = currentPosition.x;
      tracePositions[i3 + 1] = currentPosition.y;
      tracePositions[i3 + 2] = currentPosition.z;
      traceCount++;
      markTraceDirty(i3, 3); // only the new point goes to the GPU
      traceGeo.setDrawRange(0, traceCount);
    }
  }
}

function render() {
  if (!glAlive) return; // context lost; webglcontextrestored restarts us
  // ~30fps throttle, as in the original (motion speed depends on frame rate).
  setTimeout(() => requestAnimationFrame(render), 1000 / FPS);
  try {
    step();
  } catch (err) {
    // One bad frame must never kill the loop; log and carry on.
    console.warn('frame step failed:', err);
  }
  // Watchdog: if the OS suspends our AudioContext mid-session (phone call,
  // notification, aggressive power saving), the analyser starves and the
  // sphere freezes at the origin with no visible reason. Poll cheaply and
  // say so on screen instead of going silently static.
  const now = performance.now();
  if (now - lastAudioCheck > 2000) {
    lastAudioCheck = now;
    if (started && audioCtx) {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
        setStatus(IS_IOS
          ? '\u26A0 audio is paused \u2014 tap \u25B6 Begin again; iPhone: also check the silent switch'
          : '\u26A0 audio is paused \u2014 tap \u25B6 Begin again to enable sound');
      } else if (audioCtx.state === 'running' && currentTrackText &&
                 trackLabel.textContent.indexOf('audio paused') !== -1) {
        setStatus('\u266A ' + currentTrackText);
      }
      // Silence probe: if the context is running but the analyser has seen
      // nothing but digital zeros for ~6s, the SOURCE is silent (a decode
      // that slipped through, a truly silent file) — say so instead of
      // failing silently. Note this probe can NOT see an iPhone silent
      // switch: that mute happens in the OS, past the analyser tap, while
      // the sphere keeps dancing. The iOS hint in the overlay covers that.
      if (audioCtx.state === 'running') {
        let peak = 0;
        for (let i = 0; i < freqData.length; i++) {
          if (freqData[i] > peak) peak = freqData[i];
        }
        if (peak === 0) {
          silentSeconds += 2;
        } else {
          silentSeconds = 0;
          if (silenceWarned) {
            silenceWarned = false;
            setStatus('\u266A ' + currentTrackText);
          }
        }
        if (silentSeconds >= 6 && !silenceWarned && currentTrackText) {
          silenceWarned = true;
          setStatus(IS_IOS
            ? '\uD83D\uDD07 no audio signal \u2014 iPhone: check the silent switch (left side) + volume'
            : '\uD83D\uDD07 no audio signal \u2014 check your volume');
        }
      }
    }
  }
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Export — replaces app.WriteFile("/sdcard/export/...") with downloads
// ---------------------------------------------------------------------------
function tracePoints() {
  const pts = [];
  for (let i = 0; i < traceCount; i++) {
    pts.push(new THREE.Vector3(
      tracePositions[i * 3],
      tracePositions[i * 3 + 1],
      tracePositions[i * 3 + 2]
    ));
  }
  return pts;
}

// Minimal .obj serializer: v lines for vertices, one l line for the polyline.
function serializeTraceOBJ(pts) {
  const lines = [
    '# EdenExporter trace — exported from the portable HTML5 core',
    `# vertices: ${pts.length}`,
  ];
  for (const p of pts) {
    lines.push(`v ${p.x.toFixed(4)} ${p.y.toFixed(4)} ${p.z.toFixed(4)}`);
  }
  if (pts.length > 1) {
    const idx = [];
    for (let i = 1; i <= pts.length; i++) idx.push(i); // .obj indices are 1-based
    lines.push('l ' + idx.join(' '));
  }
  return lines.join('\n') + '\n';
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

function exportAll() {
  download('eden-trace.obj', serializeTraceOBJ(tracePoints()), 'text/plain');

  // The original wrote raw FFT bytes to a file misleadingly named "fft.obj".
  // Export a properly labeled JSON snapshot instead (deliberate fix).
  const fftSnapshot = {
    exportedAt: new Date().toISOString(),
    fftSize: FFT_SIZE,
    binCount: analyser.frequencyBinCount,
    sampleRate: audioCtx.sampleRate,
    bins: Array.from(freqData),
  };
  download('eden-fft.json', JSON.stringify(fftSnapshot, null, 2), 'application/json');

  // Like the original's Export: reset the sphere and start a fresh trace.
  resetTrace();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
initScene();
initGUI();

if (IS_IOS) {
  // Show the silent-switch tip before she ever taps Begin.
  document.getElementById('ios-hint').hidden = false;
}

const enterBtn = document.getElementById('enter');

// Audio source selector (demo track vs mic) — sits right above Begin as one
// of the two first, most prominent tappable controls.
let selectedSource = 'demo';
document.querySelectorAll('.src-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.src-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedSource = btn.dataset.source;
  });
});

enterBtn.addEventListener('click', () => {
  // iOS Safari only honors audioCtx.resume() when it is invoked
  // synchronously inside the user gesture — any awaited chain before the
  // call drops the gesture and the context stays suspended. So: create the
  // context and kick resume() FIRST, synchronously, then do the rest async.
  if (!started) {
    started = true;
    initAudio();
    // Chrome on Android may leave a freshly created AudioContext suspended
    // even when it is created inside the tap handler; resume explicitly
    // while we still have the user gesture. If it stays stuck, say so on
    // screen (the watchdog in render() keeps retrying) instead of letting
    // the sphere freeze silently at the origin.
    audioCtx.resume().catch(() => { /* needs another tap; the watchdog retries */ });
    // Mic permission must likewise be requested synchronously in the
    // gesture, or iOS Safari denies it outright.
    const micStreamPromise = selectedSource === 'mic' ? requestMicStream() : null;
    beginSequence(micStreamPromise);
  } else if (audioCtx && audioCtx.state === 'suspended') {
    // Second tap: the user-visible "audio paused" recovery path.
    audioCtx.resume().catch(() => {});
  }
});

// iOS quirk hardening: some iOS versions only honor the audio gesture on
// touchend rather than click. A permanent, cheap listener keeps the context
// running whenever the user touches the page. resume() on a running context
// is a no-op promise, so this is safe on every platform (including Android).
window.addEventListener('touchend', () => {
  if (started && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}, { passive: true });

async function beginSequence(micStreamPromise) {
  enterBtn.disabled = true;
  enterBtn.textContent = 'Loading\u2026';
  // The parameter panel lives in the intro card (below the description) so it
  // never overlaps it; once we're in, dock it top-right over the scene.
  document.getElementById('gui-dock').appendChild(gui.domElement);
  document.body.classList.add('started');
  document.getElementById('overlay').classList.add('gone');
  document.getElementById('credit-footer').hidden = false;
  render();
  try {
    if (micStreamPromise) {
      try {
        startMicSource(await micStreamPromise);
      } catch (err) {
        // Mic denied or unavailable: say so plainly, then fall back to the
        // demo track so the app still works.
        console.warn('mic unavailable, falling back to demo track:', err);
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        await playEmbeddedTrack();
        // playBuffer() just overwrote the status with the track label —
        // put the explanation back so it doesn't flash by unread.
        setStatus('\u266A ' + TRACK_LABEL + (denied ? ' (mic permission denied)' : ' (mic unavailable)'));
      }
    } else {
      await playEmbeddedTrack();
    }
  } catch (err) {
    console.warn('demo track failed:', err);
    setStatus('\u26A0 demo track failed \u2014 drop an audio file anywhere to play your own');
  } finally {
    if (audioCtx.state !== 'running') {
      setStatus(IS_IOS
        ? '\u26A0 audio is paused \u2014 tap \u25B6 Begin again; iPhone: also check the silent switch'
        : '\u26A0 audio is paused \u2014 tap \u25B6 Begin again to enable sound');
    }
    enterBtn.disabled = false;
    enterBtn.textContent = '\u25B6 Begin';
  }
}

fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

// Drag-and-drop anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragover');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragover');
  if (started && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
