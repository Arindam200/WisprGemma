# Web app

Standalone dictation UI and on-device stats dashboard.

## Run

From the repo root:

```sh
npm run serve:web
```

Or from this folder:

```sh
npx serve . -l 3000
```

Open http://localhost:3000 in Chrome or Edge 121+ (WebGPU required).

## Optional: local model server

To avoid re-downloading weights for every origin:

```sh
npm run download-model
```

This downloads `onnx-community/gemma-4-E2B-it-ONNX` into `web/models/` and serves it on http://localhost:8975. Both the web app and the Chrome extension auto-detect this server.

See the [root README](../README.md) for full project details.
