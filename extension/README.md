# Chrome extension

Side-panel dictation that inserts polished text into the focused field on any page.

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**
2. Click **Load unpacked** and select this `extension/` folder
3. Click the WisprGemma toolbar icon to open the side panel
4. Load the model (one-time ~3.5 GB download), allow the microphone
5. Focus a text field on a page, hold **Hold to talk** in the panel (or hold **Option** on the page), speak, release

## Notes

- Model weights are cached per extension origin, separate from the web app cache
- Text insertion does not work on `chrome://` pages or the Chrome Web Store. Use **Copy** there
- The optional local model server from `web/download-model.sh` also works for the extension

See the [root README](../README.md) for full project details.
