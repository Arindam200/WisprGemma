// Tracks the focused editable element, handles the page push-to-talk hotkey
// (hold Alt/Option — a modifier key never types characters, so it can't
// interfere with the text box the way Space would), and inserts dictated
// text, either streamed token-by-token or in one shot.
//
// The whole file is wrapped in a guarded IIFE: the panel also injects it on
// demand (chrome.scripting) into tabs that were open before the extension
// loaded, and a second copy in the same isolated world must not register
// duplicate listeners (which would double-insert text).
(() => {
if (globalThis.__wisprgemmaInjected) return;
globalThis.__wisprgemmaInjected = true;

let lastEditable = null;
let pttActive = false;

function isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "number"].includes(t);
  }
  return false;
}

document.addEventListener(
  "focusin",
  (e) => {
    if (isEditable(e.target)) lastEditable = e.target;
  },
  true
);

function targetEl() {
  if (lastEditable && document.contains(lastEditable)) return lastEditable;
  return isEditable(document.activeElement) ? document.activeElement : null;
}

function insertText(text) {
  const el = targetEl();
  if (!el) return { ok: false, reason: "no-input" };
  el.focus();
  if (el.isContentEditable) {
    // execCommand plays nice with rich editors and undo history
    document.execCommand("insertText", false, text);
  } else {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { ok: true };
}

// ---------- push-to-talk: hold Alt/Option while in a text field ----------

async function sendPtt(type) {
  try {
    return await chrome.runtime.sendMessage({ type });
  } catch {
    return null; // no listener (side panel closed) or extension reloaded
  }
}

// The hotkey can fail for reasons the user can't see (panel closed, model
// still loading, stale content script). Show a small on-page hint instead
// of silently doing nothing.
let hintEl = null;
let hintTimer = null;
function showHint(text) {
  if (!hintEl) {
    hintEl = document.createElement("div");
    hintEl.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;" +
      "background:#111;color:#fff;padding:10px 14px;border-radius:8px;" +
      "font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);" +
      "max-width:320px;pointer-events:none";
  }
  hintEl.textContent = text;
  (document.body ?? document.documentElement).appendChild(hintEl);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hintEl.remove(), 4000);
}

function stopPtt() {
  if (pttActive) {
    pttActive = false;
    sendPtt("wisprgemma-ptt-stop");
  }
}

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Alt" && !e.repeat && !pttActive && targetEl()) {
      e.preventDefault(); // keep Alt from focusing the browser menu
      if (!chrome.runtime?.id) {
        // Extension was reloaded/updated; this copy of the script is orphaned.
        showHint("WisprGemma was updated — reload this page to use the hotkey.");
        return;
      }
      pttActive = true;
      sendPtt("wisprgemma-ptt-start").then((res) => {
        if (!res?.ok) {
          pttActive = false;
          showHint(
            res?.reason === "loading"
              ? "WisprGemma: the model is still loading — check the side panel."
              : res?.reason === "busy"
                ? "WisprGemma: still processing the previous dictation."
                : "WisprGemma: open the side panel (toolbar icon), then hold ⌥ again."
          );
        }
      });
    }
  },
  true
);

document.addEventListener(
  "keyup",
  (e) => {
    if (e.key === "Alt" && pttActive) {
      e.preventDefault();
      stopPtt();
    }
  },
  true
);

window.addEventListener("blur", stopPtt);

// ---------- messages from the side panel ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "wisprgemma-ping": // liveness check before on-demand injection
      sendResponse({ ok: true });
      break;
    case "wisprgemma-insert": // full-text insert (Insert button / non-streamed)
      sendResponse(insertText(msg.text));
      break;
    case "wisprgemma-token": // streaming insert during generation
      sendResponse(insertText(msg.text));
      break;
    case "wisprgemma-recording": // visual cue on the field while listening
      {
        const el = targetEl();
        if (el) el.style.outline = msg.on ? "2px solid #dc2626" : "";
        sendResponse({ ok: true });
      }
      break;
  }
});

// ---------- history bridge for the local web dashboard ----------
// Dictation history lives in chrome.storage.local; the web dashboard can't
// read that directly, so on localhost pages we answer a postMessage request
// with the most recent entries. Restricted to localhost so arbitrary sites
// can't read your dictations.

const HISTORY_KEY = "wisprgemma-history-v1";
if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.type !== "wisprgemma-get-history") return;
    try {
      const res = await chrome.storage.local.get(HISTORY_KEY);
      const limit = Math.min(50, e.data.limit ?? 10);
      window.postMessage(
        {
          type: "wisprgemma-history",
          entries: (res[HISTORY_KEY] ?? []).slice(0, limit),
        },
        window.location.origin
      );
    } catch {
      /* extension reloaded — ignore */
    }
  });
}
})();
