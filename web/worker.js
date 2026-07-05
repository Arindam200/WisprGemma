// Model worker: loads Gemma 4 E2B (ONNX, q4f16) on WebGPU and runs
// audio -> polished-text generation in a single pass.

// MV3 CSP shim: Transformers.js loads ONNX Runtime's WASM factory through a
// blob: URL unless it detects a Chrome extension (chrome.runtime.id), and
// extension pages forbid blob: scripts. Dedicated workers don't get the
// chrome API, so fake just enough of it BEFORE the library is imported.
if (typeof chrome === "undefined" || !chrome.runtime?.id) {
  globalThis.chrome = { runtime: { id: "wisprgemma-csp-shim" } };
}

const { env, AutoProcessor, Gemma4ForConditionalGeneration, TextStreamer } =
  await import("./vendor/transformers.min.js");

// Point ONNX Runtime at the WASM files shipped with the extension instead of
// the jsdelivr CDN, which extension CSP would also block. Together with the
// shim above, the .mjs is imported directly from chrome-extension:// (allowed
// by 'self') instead of a blob: URL.
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL("./vendor/ort-wasm-simd-threaded.asyncify.mjs", import.meta.url).href,
  wasm: new URL("./vendor/ort-wasm-simd-threaded.asyncify.wasm", import.meta.url).href,
};
// Blob-booted pthread workers are also CSP-blocked; stay single-threaded.
// The heavy lifting runs on WebGPU anyway, so this costs little.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// The Cache API only accepts http(s) requests, so caching files served from
// non-http schemes (e.g. chrome-extension:// in the extension build) throws.
// Wrap the default cache to skip those — they load from disk anyway — and to
// warn loudly if caching the multi-GB weights fails, since a silent put
// failure means the model re-downloads on every load.
const CACHE_KEY = "transformers-cache";
env.useCustomCache = true;
env.customCache = {
  async match(request) {
    try {
      const cache = await caches.open(CACHE_KEY);
      return await cache.match(request);
    } catch {
      return undefined;
    }
  },
  async put(request, response) {
    const url = typeof request === "string" ? request : request.url;
    if (!/^https?:/.test(url)) return;
    try {
      const cache = await caches.open(CACHE_KEY);
      await cache.put(request, response);
    } catch (err) {
      console.warn(
        `Could not cache ${url} — it will be re-downloaded next time:`,
        err
      );
    }
  },
};

const MODEL_ID = "onnx-community/gemma-4-E2B-it-ONNX";
// Optional local weight server (see download-model.sh) — much faster than
// pulling 3.4 GB from the Hub, and shareable between web app and extension.
const LOCAL_MODEL_HOST = "http://localhost:8975";

async function configureModelSource() {
  try {
    const r = await fetch(`${LOCAL_MODEL_HOST}/${MODEL_ID}/config.json`, {
      method: "HEAD",
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      env.remoteHost = LOCAL_MODEL_HOST;
      env.remotePathTemplate = "{model}/";
      return "local server";
    }
  } catch {}
  return "Hugging Face Hub";
}

const PROMPTS = {
  clean:
    "Transcribe this audio, then clean it up: remove filler words (um, uh, like, you know), " +
    "false starts and repetitions, and fix punctuation and capitalization. Keep the speaker's " +
    "meaning and wording otherwise. Apply spoken commands like 'new paragraph' or 'make that a " +
    "bullet list' instead of transcribing them. Output ONLY the final cleaned text, nothing else.",
  verbatim:
    "Transcribe this audio exactly as spoken. Output ONLY the transcript, nothing else.",
  email:
    "Transcribe this audio and rewrite it as a polished, professional email body: fix grammar " +
    "and punctuation, remove fillers, keep it concise and friendly. Output ONLY the email text.",
  english:
    "The audio may be in any language. Transcribe it and output a polished English version of " +
    "what was said: natural phrasing, correct punctuation, no filler words. Output ONLY the " +
    "English text, nothing else.",
};

let processor = null;
let model = null;

async function load() {
  const progress = (data) => postMessage({ type: "progress", data });
  try {
    const source = await configureModelSource();
    postMessage({ type: "source", source });
    processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback: progress,
    });
    if (!processor?.apply_chat_template) {
      throw new Error(
        "Processor failed to load. The Transformers.js version may not support Gemma 4. Hard-refresh (Cmd+Shift+R) to clear the cached library."
      );
    }
    // Covers the cached-weights path, where no download progress events fire
    // but session creation + GPU upload still takes a while.
    postMessage({
      type: "status",
      text: "Loading model onto the GPU… this can take a few minutes.",
    });
    model = await Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, {
      dtype: "q4f16",
      device: "webgpu",
      progress_callback: progress,
    });
    await warmup();
    postMessage({ type: "ready" });
  } catch (err) {
    postMessage({ type: "error", error: String(err?.message ?? err) });
  }
}

// The first generation pays WebGPU shader compilation, which can add several
// seconds to first-token latency. Run a throwaway 1-token generation on half
// a second of silence so the user's first real dictation is fast.
async function warmup() {
  try {
    postMessage({ type: "status", text: "Compiling shaders / warming up…" });
    const silence = new Float32Array(8000); // 0.5s @ 16 kHz
    const messages = [
      {
        role: "user",
        content: [{ type: "audio" }, { type: "text", text: "Ignore the audio." }],
      },
    ];
    const prompt = processor.apply_chat_template(messages, {
      add_generation_prompt: true,
      enable_thinking: false,
    });
    const inputs = await processor(prompt, null, silence, {
      add_special_tokens: false,
    });
    await model.generate({ ...inputs, max_new_tokens: 1, do_sample: false });
  } catch {
    // Warm-up is best-effort; the first real dictation just pays the cost.
  }
}

async function transcribe({ audio, mode }) {
  try {
    if (!processor || !model) {
      throw new Error("Model is still loading. Wait for the recorder to appear, then try again.");
    }
    const messages = [
      {
        role: "user",
        content: [
          { type: "audio" },
          { type: "text", text: PROMPTS[mode] ?? PROMPTS.clean },
        ],
      },
    ];
    const prompt = processor.apply_chat_template(messages, {
      add_generation_prompt: true,
      enable_thinking: false,
    });

    // Audio is a Float32Array, 16 kHz mono, normalized to [-1, 1].
    const inputs = await processor(prompt, null, audio, {
      add_special_tokens: false,
    });

    let firstToken = true;
    const streamer = new TextStreamer(processor.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => {
        postMessage({ type: "token", text, first: firstToken });
        firstToken = false;
      },
    });

    await model.generate({
      ...inputs,
      max_new_tokens: 512,
      do_sample: false,
      streamer,
    });
    postMessage({ type: "done" });
  } catch (err) {
    postMessage({ type: "error", error: String(err?.message ?? err) });
  }
}

self.onmessage = ({ data }) => {
  if (data.type === "load") load();
  else if (data.type === "transcribe") transcribe(data);
};
