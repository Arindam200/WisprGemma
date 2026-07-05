// Tracks the focused editable element, handles the page push-to-talk hotkey
// (hold Alt/Option — a modifier key never types characters, so it can't
// interfere with the text box the way Space would), and inserts dictated
// text, either streamed token-by-token or in one shot.
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

function sendPtt(type) {
  try {
    chrome.runtime.sendMessage({ type });
  } catch {
    /* extension reloaded — ignore */
  }
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
      pttActive = true;
      sendPtt("wisprgemma-ptt-start");
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
