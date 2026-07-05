// Chrome can't reliably show a getUserMedia permission prompt inside the side
// panel, so this page runs in a normal tab. Once the user allows the mic here,
// the grant applies to the whole chrome-extension:// origin, panel included.
const status = document.getElementById("status");

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.textContent = "✓ Microphone access granted. You can close this tab and dictate from the side panel.";
    status.className = "ok";
    setTimeout(() => window.close(), 2500);
  } catch (err) {
    status.textContent =
      `⚠️ ${err.name === "NotAllowedError" ? "Permission was denied or dismissed." : err.message} ` +
      "Reload this tab to try again, or enable the microphone for WisprGemma under " +
      "chrome://settings/content/microphone.";
    status.className = "err";
  }
})();
