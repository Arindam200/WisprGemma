// UI + mic capture. Records while the button (or Space) is held, converts the
// clip to 16 kHz mono Float32, and hands it to the model worker.

import { logUtterance, countWords } from "./stats.js";

const els = {
  loadBtn: document.getElementById("load-btn"),
  progress: document.getElementById("progress"),
  progressFill: document.getElementById("progress-fill"),
  progressText: document.getElementById("progress-text"),
  webgpuWarning: document.getElementById("webgpu-warning"),
  loader: document.getElementById("loader"),
  app: document.getElementById("app"),
  recordBtn: document.getElementById("record-btn"),
  mode: document.getElementById("mode"),
  output: document.getElementById("output"),
  stats: document.getElementById("stats"),
  statFirst: document.getElementById("stat-first"),
  statTotal: document.getElementById("stat-total"),
  statAudio: document.getElementById("stat-audio"),
};

const HISTORY_KEY = "wisprgemma-history-v1";
const MODEL_MAX_SECONDS = 30; // Gemma 4 audio input limit per request
const RECORD_MAX_SECONDS = 300; // safety cap on a single hold
const SAMPLE_RATE = 16000;

const worker = new Worker("worker.js", { type: "module" });
// Surface worker boot failures (e.g. a blocked import) that would otherwise
// leave the UI stuck on "Preparing…" with no error anywhere.
worker.onerror = (e) => {
  const where = e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : "";
  els.progressText.textContent = `⚠️ Worker failed: ${e.message ?? "unknown error"}${where}`;
};

let mediaRecorder = null;
let chunks = [];
let recording = false;
let busy = false;
let tSubmit = 0;
let tFirstToken = 0;
let lastAudioSec = 0;
let recordTimer = null;
let segmentQueue = []; // remaining audio segments for long clips
let firstSegment = true;
let doneText = ""; // output from already-finished segments
const fileProgress = new Map();

// ---------- model loading ----------

if (!navigator.gpu) {
  els.webgpuWarning.hidden = false;
  els.loadBtn.disabled = true;
}

function startLoad(auto = false) {
  els.loadBtn.disabled = true;
  if (auto) els.loadBtn.textContent = "Model found in cache, loading…";
  els.progress.hidden = false;
  worker.postMessage({ type: "load" });
}

els.loadBtn.addEventListener("click", () => startLoad());

// If the weights are already cached from a previous visit, load without asking.
async function modelLikelyCached() {
  try {
    if (localStorage.getItem("wisprgemma-model-ready") === "1") return true;
    return await caches.has("transformers-cache");
  } catch {
    return false;
  }
}
if (navigator.gpu) {
  modelLikelyCached().then((cached) => {
    if (cached && !els.loadBtn.disabled) startLoad(true);
  });
}

worker.onmessage = ({ data }) => {
  switch (data.type) {
    case "source":
      els.progressText.textContent = `Loading from ${data.source}…`;
      break;
    case "status":
      els.progressText.textContent = data.text;
      break;
    case "progress": {
      const p = data.data;
      if (p.status === "progress" && p.total) {
        fileProgress.set(p.file, { loaded: p.loaded, total: p.total });
        els.progressFill.classList.remove("indeterminate");
        let loaded = 0,
          total = 0;
        for (const f of fileProgress.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        const pct = total ? (loaded / total) * 100 : 0;
        els.progressFill.style.width = `${pct.toFixed(1)}%`;
        els.progressText.textContent = `Downloading model… ${(loaded / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB (cached after first load)`;
      } else if (p.status === "done" && fileProgress.has(p.file)) {
        // A file finished downloading. Once every tracked file is complete,
        // the long, silent phase begins: building the ONNX session and
        // uploading weights to the GPU. Tell the user instead of appearing
        // frozen at the final "Downloading…" figure.
        fileProgress.get(p.file).loaded = fileProgress.get(p.file).total;
        const allDone = [...fileProgress.values()].every((f) => f.loaded >= f.total);
        if (allDone) {
          els.progressFill.style.width = "100%";
          els.progressFill.classList.add("indeterminate");
          els.progressText.textContent =
            "Download complete. Loading model onto the GPU… this can take a few minutes the first time.";
        }
      }
      break;
    }
    case "ready":
      els.loader.hidden = true;
      els.app.hidden = false;
      try {
        localStorage.setItem("wisprgemma-model-ready", "1");
      } catch {}
      break;
    case "token": {
      if (data.first) {
        if (firstSegment) tFirstToken = performance.now();
        firstSegment = false;
        els.output.textContent = doneText;
      }
      els.output.textContent += data.text;
      break;
    }
    case "done": {
      if (segmentQueue.length > 0) {
        // Long recording: keep transcribing the remaining segments.
        doneText = els.output.textContent.replace(/\s*$/, " ");
        submitSegment(segmentQueue.shift());
        break;
      }
      const now = performance.now();
      els.statFirst.textContent = `${((tFirstToken - tSubmit) / 1000).toFixed(2)}s`;
      els.statTotal.textContent = `${((now - tSubmit) / 1000).toFixed(2)}s`;
      els.stats.hidden = false;
      logUtterance({
        ts: Date.now(),
        mode: els.mode.value,
        audioSec: lastAudioSec,
        firstTokenMs: Math.round(tFirstToken - tSubmit),
        totalMs: Math.round(now - tSubmit),
        words: countWords(els.output.textContent),
      });
      saveHistory(els.output.textContent);
      setBusy(false);
      break;
    }
    case "error":
      segmentQueue = [];
      els.output.textContent = `⚠️ ${data.error}`;
      els.progressText.textContent = `⚠️ ${data.error}`;
      setBusy(false);
      break;
  }
};

// Keep the dictated text locally so the dashboard can show recent dictations.
function saveHistory(text) {
  const t = text.trim();
  if (!t) return;
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
    all.unshift({ ts: Date.now(), text: t, mode: els.mode.value });
    if (all.length > 200) all.length = 200;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {}
}

// ---------- recording ----------

function setBusy(b) {
  busy = b;
  els.recordBtn.disabled = b;
  els.recordBtn.textContent = b ? "🧠 Thinking…" : "🎙️ Hold to talk (Space)";
}

async function startRecording() {
  if (recording || busy) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      processClip(new Blob(chunks, { type: mediaRecorder.mimeType }));
    };
    // Request data periodically so long recordings aren't lost if anything
    // interrupts the recorder before its final stop event.
    mediaRecorder.start(1000);
    recording = true;
    els.recordBtn.classList.add("recording");
    els.recordBtn.textContent = "🔴 Listening… release to transcribe";
    // safety cap so a stuck key/pointer doesn't record forever
    recordTimer = setTimeout(() => recording && stopRecording(), RECORD_MAX_SECONDS * 1000);
  } catch (err) {
    els.output.textContent = `⚠️ Microphone error: ${err.message}`;
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  clearTimeout(recordTimer);
  els.recordBtn.classList.remove("recording");
  mediaRecorder.stop();
}

async function processClip(blob) {
  setBusy(true);
  els.output.textContent = "…";
  // Decode at 16 kHz: an AudioContext with a fixed sampleRate resamples for us.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();

  // Downmix to mono, normalized [-1, 1] Float32Array.
  let audio;
  if (buf.numberOfChannels === 1) {
    audio = buf.getChannelData(0);
  } else {
    const a = buf.getChannelData(0);
    const b = buf.getChannelData(1);
    audio = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) audio[i] = (a[i] + b[i]) / 2;
  }

  if (buf.duration < 0.4) {
    els.output.textContent = "(too short. Hold while speaking)";
    setBusy(false);
    return;
  }

  lastAudioSec = buf.duration;
  els.statAudio.textContent = `${buf.duration.toFixed(1)}s`;
  tSubmit = performance.now();
  firstSegment = true;
  doneText = "";

  // The model only accepts ~30s of audio per request, so longer recordings
  // are split into segments (at quiet points where possible) and transcribed
  // sequentially, appending the output of each one.
  segmentQueue = splitAudio(audio);
  submitSegment(segmentQueue.shift());
}

// Split audio into segments of at most MODEL_MAX_SECONDS, preferring to cut
// at the quietest moment near each boundary so words aren't chopped in half.
function splitAudio(audio) {
  const maxLen = MODEL_MAX_SECONDS * SAMPLE_RATE;
  if (audio.length <= maxLen) return [audio];

  const segments = [];
  let start = 0;
  while (audio.length - start > maxLen) {
    // Look for the quietest 100ms window in the last 5s of the segment.
    const searchStart = start + maxLen - 5 * SAMPLE_RATE;
    const searchEnd = start + maxLen;
    const win = Math.floor(0.1 * SAMPLE_RATE);
    let bestPos = searchEnd;
    let bestEnergy = Infinity;
    for (let i = searchStart; i + win <= searchEnd; i += win) {
      let energy = 0;
      for (let j = i; j < i + win; j++) energy += audio[j] * audio[j];
      if (energy < bestEnergy) {
        bestEnergy = energy;
        bestPos = i + win / 2;
      }
    }
    segments.push(audio.slice(start, bestPos));
    start = bestPos;
  }
  segments.push(audio.slice(start));
  return segments;
}

function submitSegment(segment) {
  // slice() above gives each segment its own buffer, safe to transfer.
  worker.postMessage(
    { type: "transcribe", audio: segment, mode: els.mode.value },
    [segment.buffer]
  );
}

// hold-to-talk: mouse/touch on the button, or Space anywhere.
// Pointer capture keeps the hold alive even if the cursor/finger drifts
// off the button, so long recordings don't get cut off accidentally.
els.recordBtn.addEventListener("pointerdown", (e) => {
  els.recordBtn.setPointerCapture(e.pointerId);
  startRecording();
});
els.recordBtn.addEventListener("pointerup", stopRecording);
els.recordBtn.addEventListener("pointercancel", stopRecording);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && e.target === document.body && !els.app.hidden) {
    e.preventDefault();
    startRecording();
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && e.target === document.body) {
    e.preventDefault();
    stopRecording();
  }
});
