![Demo](./assets/banner.png)

# WisprGemma

Local-first multilingual dictation powered by **Gemma 4 E2B**. Speak in any language, get polished text. Audio never leaves your device.

Built for the [Gemma 4 Hackathon](https://www.kaggle.com/competitions/gemma-4-hackathon). Public repo: [github.com/Arindam200/WisprGemma](https://github.com/Arindam200/WisprGemma)

This monorepo contains two deliverables:

| Package | Path | What it is |
|---------|------|------------|
| Web app | [`web/`](web/) | Standalone dictation page + stats dashboard |
| Chrome extension | [`extension/`](extension/) | Side panel that inserts text into any focused input on a page |

## What we built

WisprGemma is a WisprFlow-style dictation tool that runs entirely in the browser on WebGPU. One Gemma 4 model handles the full pipeline in a single pass:

1. **Speech recognition** from raw audio
2. **Cleanup** (fillers, false starts, punctuation)
3. **Rewriting** based on the selected output style

No Whisper, no cloud API, no API key. After a one-time model download (~3.5 GB, q4f16), both the web app and extension work offline.

### Web app (`web/`)

- Hold-to-talk dictation (button or Space), with streaming output
- Output styles: clean dictation, verbatim, polished email, any language to English
- Latency stats per utterance (time to first token, total, audio length)
- Stats dashboard: words dictated, WPM, estimated time saved vs typing, streak, 14-day chart
- All stats stored in `localStorage` on the device
- Editorial UI with on-device privacy messaging throughout

### Chrome extension (`extension/`)

- Side panel with the same dictation flow as the web app
- Inserts text into the last focused input, textarea, or contenteditable on the active page
- Push-to-talk on any page: hold **Option** while a text field is focused
- Dictation history in the panel for quick copy
- Separate stats dashboard scoped to the extension origin
- Microphone permission helper tab (`mic-permission.html`) — Chrome cannot show the mic prompt inside the side panel, so the extension opens a one-time permission page when needed

## How we built it

Both packages share the same architecture pattern: vanilla HTML/CSS/JS with no build step, a module **Web Worker** for model inference, and the browser **MediaRecorder** API for microphone capture.

```
Mic (MediaRecorder)
  → decode to 16 kHz mono Float32
  → worker.js (Transformers.js + Gemma 4 E2B on WebGPU)
  → streamed tokens back to UI
  → display / insert into page / log stats
```

### Model loading

- Model ID: [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX)
- Quantization: `q4f16`
- Execution: WebGPU via Transformers.js
- Weights are fetched from Hugging Face Hub on first load, then cached by the browser
- The UI distinguishes **download progress** from the longer **GPU upload / session build** phase so the app does not look frozen at "3.40 / 3.40 GB"
- Optional: run `npm run download-model` to serve weights from disk at `http://localhost:8975` (faster for development, shared by web + extension)

### Web app specifics

- `main.js`: UI, mic capture, segment queue for clips longer than 30s (Gemma 4 audio limit)
- `worker.js`: loads vendored Transformers.js from `vendor/transformers.min.js`, runs `Gemma4ForConditionalGeneration`
- `stats.js` + `dashboard.*`: local analytics computed entirely on-device
- `editorial.css` + `home.css`: shared editorial design system (hero layout, dot grid, texture overlays)

### Extension specifics

- `panel.js` + `panel.html`: side panel UI and mic flow
- `worker.js`: same inference logic with extra MV3 CSP workarounds:
  - Vendored `vendor/transformers.min.js` (Manifest V3 blocks remote scripts in extension pages)
  - Vendored ONNX Runtime WASM (`ort-wasm-simd-threaded.asyncify.*`) instead of CDN/blob URLs
  - A minimal `chrome.runtime.id` shim so Transformers.js loads WASM from `chrome-extension://` paths
- `mic-permission.html/js`: one-time microphone grant in a regular extension tab
- `content.js`: tracks focused editable elements, handles Option push-to-talk, inserts text with undo-friendly APIs
- `background.js`: opens the side panel from the toolbar icon
- Model weights are still fetched from Hugging Face at runtime (data, not code)

## Tech stack

| Layer | Technology |
|-------|------------|
| Model | Gemma 4 E2B instruction-tuned (`gemma-4-E2B-it`) |
| Inference | [Transformers.js](https://huggingface.co/docs/transformers.js) 4.2.0 |
| Runtime | WebGPU (Chrome / Edge 121+) |
| Model format | ONNX, q4f16 quantized |
| Web app | HTML, CSS, vanilla JS, ES module Web Worker |
| Extension | Chrome Manifest V3, Side Panel API, content scripts |
| Audio | MediaRecorder → Web Audio API decode → 16 kHz mono Float32 |
| Storage | `localStorage` (stats, dictation history in extension) |
| Serving | Any static file server (`npx serve`) |

## Quick start

### Web app

```sh
npm run serve:web
```

Open http://localhost:3000, click **Load model**, allow the microphone, hold Space and speak.

Requires Chrome or Edge 121+ with WebGPU enabled. First load downloads ~3.5 GB, then spends a few minutes uploading weights to the GPU.

### Chrome extension

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Click the WisprGemma icon, load the model, allow the microphone
4. If mic access fails in the side panel, follow the permission tab that opens automatically
5. Focus a text field on any page and dictate

### Optional: local model server

```sh
npm run download-model
```

Downloads weights into `web/models/` and serves them on port 8975. Leave it running while developing.

## Repository layout

```
wisprgemma/
├── README.md              Project overview (this file)
├── package.json           Convenience scripts
├── serve.json             Static server config (trailing slashes)
├── web/                   Web app + stats dashboard
│   ├── index.html         Dictation UI
│   ├── main.js            Mic capture + UI logic
│   ├── worker.js          Gemma 4 inference worker
│   ├── stats.js           localStorage stats helpers
│   ├── dashboard.html     Stats dashboard
│   ├── editorial.css      Shared editorial design system
│   ├── home.css           Home page layout
│   ├── download-model.sh  Optional local weight server
│   ├── assets/            Static assets (Gemma logo, textures)
│   └── vendor/            Vendored Transformers.js bundle
└── extension/             Chrome MV3 extension
    ├── manifest.json
    ├── panel.html/js      Side panel UI
    ├── mic-permission.*   One-time microphone permission page
    ├── worker.js          Inference worker (CSP-safe Transformers.js + ORT WASM)
    ├── content.js         Page text insertion + push-to-talk
    ├── background.js      Toolbar → side panel
    ├── dashboard.html     Extension stats dashboard
    ├── editorial.css      Shared editorial design system
    └── vendor/            Vendored Transformers.js + ONNX Runtime WASM
```

## Privacy

Audio is captured locally, processed locally, and never sent to a server. Stats and history live in browser storage on your machine only.
