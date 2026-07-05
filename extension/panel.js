// Side-panel UI: mic capture + model worker + insert-into-page.
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
  autoInsert: document.getElementById("auto-insert"),
  insertBtn: document.getElementById("insert-btn"),
  copyBtn: document.getElementById("copy-btn"),
  insertStatus: document.getElementById("insert-status"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  clearHistory: document.getElementById("clear-history"),
};

const MAX_SECONDS = 30;
const HISTORY_KEY = "wisprgemma-history-v1";
const worker = new Worker("worker.js", { type: "module" });
// Surface worker boot failures (e.g. a blocked import) that would otherwise
// leave the UI stuck on "Preparing…" with no error anywhere.
worker.onerror = (e) => {
  const where = e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : "";
  els.progressText.textContent = `⚠️ Worker failed: ${e.message ?? "unknown error"}${where}`;
};
let streamingToTab = false;
// True when the current dictation was started with the page hotkey. Those
// always stream into the page — that's the point of the gesture — regardless
// of the auto-insert checkbox, which governs panel-button recordings.
let pttSession = false;
// Tab the dictation targets, captured when recording starts so streamed
// tokens keep landing in the right tab even if the user switches tabs.
let targetTabId = null;

// Statically declared content scripts only appear on page load, so tabs that
// were open before the extension was installed/reloaded don't have one — the
// hotkey and insert silently do nothing there. Ping the tab and inject
// content.js on demand if nobody answers. Returns false on pages Chrome
// won't let us touch (chrome://, web store).
async function ensureContentScript(tabId) {
  if (tabId == null) return false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "wisprgemma-ping" });
    if (res?.ok) return true;
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false;
  }
}

// Cover the active tab as soon as the panel opens, and every tab the user
// switches to while it stays open, so the hotkey works without a page reload.
chrome.tabs
  .query({ active: true, currentWindow: true })
  .then(([tab]) => ensureContentScript(tab?.id));
chrome.tabs.onActivated.addListener(({ tabId }) => ensureContentScript(tabId));

async function sendToTab(msg) {
  try {
    const tabId =
      targetTabId ??
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null;
  }
}

// Streamed tokens are buffered and flushed once per animation frame instead
// of one chrome.tabs.sendMessage round-trip per token.
let tokenBuf = "";
let flushScheduled = false;
let streamFailed = false;

function queueToken(text) {
  tokenBuf += text;
  if (!flushScheduled) {
    flushScheduled = true;
    requestAnimationFrame(flushTokens);
  }
}

async function flushTokens() {
  flushScheduled = false;
  if (!tokenBuf) return;
  const text = tokenBuf;
  tokenBuf = "";
  const res = await sendToTab({ type: "wisprgemma-token", text });
  // Surface delivery failures instead of claiming success later: null means
  // the tab is unreachable (stale content script, chrome:// page), ok:false
  // means no text field has been focused in it.
  if (!res?.ok) {
    streamFailed = true;
    els.insertStatus.textContent =
      res === null
        ? "Couldn't reach the page — reload the tab, then try again."
        : "Click into a text field on the page, then use Insert.";
  }
}

// ---------- dictation history (chrome.storage.local, device-only) ----------
// Stored in chrome.storage.local (not localStorage) so the content script
// can serve it to the local web dashboard's "recent dictations" list.

async function loadHistory() {
  try {
    return (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] ?? [];
  } catch {
    return [];
  }
}

async function saveHistory(text) {
  const t = text.trim();
  if (!t) return;
  const all = await loadHistory();
  all.unshift({ ts: Date.now(), text: t, mode: els.mode.value });
  if (all.length > 200) all.length = 200;
  await chrome.storage.local.set({ [HISTORY_KEY]: all });
  renderHistory();
}

async function renderHistory() {
  const all = await loadHistory();
  els.historyList.replaceChildren(
    ...all.slice(0, 50).map((h) => {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = new Date(h.ts).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const p = document.createElement("p");
      p.textContent = h.text;
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(h.text);
        copy.textContent = "✓";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      li.append(time, p, copy);
      return li;
    })
  );
  els.historyEmpty.hidden = all.length > 0;
}

let mediaRecorder = null;
let chunks = [];
let recording = false;
let recordTimer = null;
let busy = false;
let tSubmit = 0;
let tFirstToken = 0;
let lastAudioSec = 0;
const fileProgress = new Map();

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
        let loaded = 0, total = 0;
        for (const f of fileProgress.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        els.progressFill.style.width = `${total ? ((loaded / total) * 100).toFixed(1) : 0}%`;
        els.progressText.textContent = `Downloading… ${(loaded / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`;
      } else if (p.status === "done" && fileProgress.has(p.file)) {
        // A file finished downloading. Once every tracked file is complete,
        // the long, silent phase begins: building the ONNX session and
        // uploading weights to the GPU. Tell the user instead of appearing
        // frozen at "Downloading… 3.40 / 3.40 GB".
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
    case "token":
      if (data.first) {
        tFirstToken = performance.now();
        els.output.textContent = "";
        tokenBuf = "";
        streamFailed = false;
        streamingToTab = pttSession || els.autoInsert.checked;
      }
      els.output.textContent += data.text;
      if (streamingToTab) queueToken(data.text);
      break;
    case "done": {
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
      if (streamingToTab) {
        flushTokens(); // deliver any tokens still buffered
        if (!streamFailed) els.insertStatus.textContent = "✓ Streamed into the page";
        streamingToTab = false;
      } else if (els.autoInsert.checked) {
        insertIntoPage();
      }
      pttSession = false;
      break;
    }
    case "error":
      tokenBuf = "";
      streamingToTab = false;
      pttSession = false;
      els.output.textContent = `⚠️ ${data.error}`;
      els.progressText.textContent = `⚠️ ${data.error}`;
      setBusy(false);
      break;
  }
};

// ---------- insert into page ----------

async function insertIntoPage() {
  const text = els.output.textContent.trim();
  if (!text) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!(await ensureContentScript(tab?.id))) {
      els.insertStatus.textContent =
        "Can't insert on this page (e.g. chrome:// or web store). Use Copy.";
      return;
    }
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "wisprgemma-insert",
      text,
    });
    els.insertStatus.textContent = res?.ok
      ? "✓ Inserted into the page"
      : "Click into a text field on the page first, then Insert.";
  } catch {
    els.insertStatus.textContent =
      "Can't insert on this page (e.g. chrome:// or web store). Use Copy.";
  }
}

els.insertBtn.addEventListener("click", insertIntoPage);
els.copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(els.output.textContent);
  els.insertStatus.textContent = "✓ Copied";
});

// ---------- recording ----------

function setBusy(b) {
  busy = b;
  els.recordBtn.disabled = b;
  els.recordBtn.textContent = b ? "🧠 Thinking…" : "🎙️ Hold to talk";
}

async function startRecording(tabId = null) {
  if (recording || busy) return;
  try {
    if (tabId != null) {
      targetTabId = tabId;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = tab?.id ?? null;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      processClip(new Blob(chunks, { type: mediaRecorder.mimeType }));
    };
    mediaRecorder.start(1000);
    recording = true;
    els.recordBtn.classList.add("recording");
    els.recordBtn.textContent = "🔴 Listening…";
    recordTimer = setTimeout(() => recording && stopRecording(), MAX_SECONDS * 1000);
  } catch (err) {
    if (err.name === "NotAllowedError") {
      // Chrome can't show the mic prompt inside the side panel ("Permission
      // dismissed"). Grant it once from a regular tab instead; the grant
      // covers the whole extension origin, including this panel.
      els.output.textContent =
        "Microphone permission needed. A tab just opened — click Allow there, then hold to talk again.";
      chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") });
    } else {
      els.output.textContent = `⚠️ Microphone error: ${err.message}`;
    }
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
  els.insertStatus.textContent = "";
  const ctx = new AudioContext({ sampleRate: 16000 });
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();

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
  worker.postMessage({ type: "transcribe", audio, mode: els.mode.value }, [
    audio.buffer,
  ]);
}

// Note: don't pass startRecording directly as the handler — the PointerEvent
// would land in its tabId parameter and get used as a (bogus) tab id.
els.recordBtn.addEventListener("pointerdown", () => {
  pttSession = false;
  startRecording();
});
els.recordBtn.addEventListener("pointerup", stopRecording);
els.recordBtn.addEventListener("pointerleave", stopRecording);

// ---------- push-to-talk from the page (hold Alt in a text field) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "wisprgemma-ptt-start") {
    if (els.app.hidden) {
      sendResponse({ ok: false, reason: "loading" }); // model not ready yet
      return;
    }
    if (busy || recording) {
      sendResponse({ ok: false, reason: "busy" });
      return;
    }
    pttSession = true;
    targetTabId = sender.tab?.id ?? null;
    sendToTab({ type: "wisprgemma-recording", on: true });
    startRecording(targetTabId);
    sendResponse({ ok: true });
  } else if (msg.type === "wisprgemma-ptt-stop") {
    sendToTab({ type: "wisprgemma-recording", on: false });
    stopRecording();
    sendResponse({ ok: true });
  }
});

// ---------- history UI ----------

els.clearHistory.addEventListener("click", async () => {
  await chrome.storage.local.remove(HISTORY_KEY);
  renderHistory();
});

// One-time migration of history from the old localStorage store.
(async () => {
  try {
    const old = JSON.parse(localStorage.getItem(HISTORY_KEY));
    if (old?.length && (await loadHistory()).length === 0) {
      await chrome.storage.local.set({ [HISTORY_KEY]: old });
    }
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
  renderHistory();
})();
