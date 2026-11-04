import type { BBox, DocumentInput, OcrEngine, OcrOptions, PageImage, PlatformEngines, RotatedBox, TextLine } from "@pde/core";
import { assessQuality } from "@pde/core";
import { loadAsset, type ModelManifest } from "./assets.ts";
import { detectCapabilities, type Capabilities, type Tier } from "./capabilities.ts";
import { createBrowserCanvas, decodeImageBrowser } from "./image.ts";
import { PaddleOcrEngine } from "./paddle/engine.ts";
import { PdfReader } from "./pdf.ts";
import { TesseractEngine } from "./tesseract.ts";

export interface OcrEngineConfig {
  /** Base URL of the app's self-hosted static assets (models, tesseract). */
  assetBase: string;
  manifest: ModelManifest;
  tier: Tier;
  threads: boolean;
  cores: number;
  onAssetProgress?: (loaded: number, total: number) => void;
  /** What start-up is doing now, in words a user can repeat ("loading the reading runtime"). */
  onStage?: (stage: string) => void;
}

/** Assets each tier downloads (for the offline check and progress UI). */
export function assetsForTier(manifest: ModelManifest, tier: Tier) {
  const names = tier === "L" ? ["tesseract_eng"] : ["ppocr_det", "ppocr_rec", "ppocr_dict"];
  return names.map((n) => manifest.assets[n]).filter((a): a is NonNullable<typeof a> => Boolean(a));
}

/**
 * Create the OCR engine for a tier. Works on the main thread or inside a
 * Web Worker (see `serveOcrWorker`). All files load from `assetBase`.
 */
export async function createOcrEngine(cfg: OcrEngineConfig): Promise<{ engine: OcrEngine; tier: Tier }> {
  const base = cfg.assetBase.replace(/\/?$/, "/");
  if (cfg.tier === "L") {
    const tesseract = await import("tesseract.js");
    const engine = new TesseractEngine({
      tesseract,
      workerPath: `${base}tesseract/worker.min.js`,
      corePath: `${base}tesseract/core/`,
      langPath: `${base}tesseract/lang/`,
      createCanvas: createBrowserCanvas,
    });
    return { engine, tier: "L" };
  }
  const useGpu = cfg.tier === "W1";
  const names = ["ppocr_det", "ppocr_rec", "ppocr_dict"];
  const refs = names.map((name) => {
    const ref = cfg.manifest.assets[name];
    if (!ref) throw new Error(`model manifest is missing ${name}`);
    return ref;
  });
  // One progress figure for all files (they download in parallel).
  const total = refs.reduce((n, r) => n + r.bytes, 0);
  const loaded = refs.map(() => 0);
  cfg.onStage?.("downloading the reading models");
  const [det, rec, dict] = await Promise.all(
    refs.map((ref, i) =>
      loadAsset({ ...ref, url: new URL(ref.url, base).href }, (n) => {
        loaded[i] = n;
        cfg.onAssetProgress?.(loaded.reduce((a, b) => a + b, 0), total);
      }),
    ),
  );
  const models = { det: new Uint8Array(det!), rec: new Uint8Array(rec!), dict: new TextDecoder().decode(dict!) };
  const load = async (gpu: boolean) => {
    // The bundler emits ORT's .wasm next to the app (same origin); no CDN.
    cfg.onStage?.(gpu ? "loading the reading runtime (GPU)" : "loading the reading runtime");
    const ort = gpu ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm");
    ort.env.wasm.numThreads = cfg.threads ? Math.min(4, cfg.cores) : 1;
    return PaddleOcrEngine.create({ ort, models, executionProviders: gpu ? ["webgpu", "wasm"] : ["wasm"], ...(cfg.onStage ? { onStage: cfg.onStage } : {}) });
  };
  try {
    return { engine: await load(useGpu), tier: cfg.tier };
  } catch (err) {
    if (!useGpu) throw err;
    // WebGPU adapter present but unusable (blocklisted driver, lost device…): use WASM.
    return { engine: await load(false), tier: "W2" };
  }
}

type WorkerRequest =
  | { id: number; op: "init"; cfg: Omit<OcrEngineConfig, "onAssetProgress" | "onStage"> }
  | { id: number; op: "recognize"; image: PageImage; options?: OcrOptions }
  | { id: number; op: "recognizeRegion"; image: PageImage; region: BBox | RotatedBox; options?: OcrOptions }
  | { id: number; op: "dispose" };

type WorkerMessage =
  | { id: number; ok: true; value: unknown; boot: string }
  | { id: number; ok: false; error: string; code?: "not-started"; boot: string }
  | { type: "ready"; boot: string }
  | { type: "net"; url: string; transferSize: number }
  | { type: "asset-progress"; loaded: number; total: number }
  | { type: "stage"; stage: string };

/**
 * Worker side: call from your worker module (`serveOcrWorker(self)`).
 * Heavy OCR runs here so the page stays responsive on slow phones. The
 * worker's own network requests (model downloads) are relayed to the page
 * so they appear in "What left this device".
 */
export function serveOcrWorker(scope: { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null }) {
  // The engine as a promise: requests that arrive while it is still loading
  // wait for it, and if loading failed they report why (instead of a bare
  // "not initialised").
  let engine: Promise<OcrEngine> | null = null;
  // Identifies this run of the worker, so the page can tell a worker that
  // was restarted (and lost its engine) from the one it started.
  const boot = Math.random().toString(36).slice(2, 10);
  const post = (m: WorkerMessage) => scope.postMessage(m);
  scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
    const msg = e.data;
    try {
      let value: unknown = null;
      if (msg.op === "init") {
        const loading = createOcrEngine({
          ...msg.cfg,
          onAssetProgress: (loaded, total) => post({ type: "asset-progress", loaded, total }),
          onStage: (stage) => post({ type: "stage", stage }),
        });
        engine = loading.then((r) => r.engine);
        const r = await loading;
        value = { tier: r.tier, id: r.engine.id };
      } else if (msg.op === "recognize") {
        value = await (await need()).recognize(msg.image, msg.options);
        msg.image.data.fill(0);
      } else if (msg.op === "recognizeRegion") {
        const eng = await need();
        if (!eng.recognizeRegion) throw new Error("engine cannot recognise regions");
        value = await eng.recognizeRegion(msg.image, msg.region, msg.options);
        msg.image.data.fill(0);
      } else if (msg.op === "dispose") {
        const eng = engine;
        engine = null;
        await (await eng?.catch(() => null))?.dispose?.();
      }
      post({ id: msg.id, ok: true, value, boot });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.error(`[ocr worker] ${msg.op} failed:`, err);
      post({ id: msg.id, ok: false, error: message, boot, ...(err instanceof NotStartedError ? { code: "not-started" as const } : {}) });
    }
  };
  // Tell the page we are listening. WebKit can drop messages posted to a
  // module worker before its code has run, so the page waits for this
  // before sending "init".
  post({ type: "ready", boot });
  async function need(): Promise<OcrEngine> {
    if (!engine) throw new NotStartedError();
    try {
      return await engine;
    } catch (err) {
      throw new Error(`the reading engine failed to load: ${(err as Error).message ?? String(err)}`, { cause: err });
    }
  }
  // Best effort, and only after we are listening: some browsers (Safari)
  // do not support resource timing observers in workers, and that must
  // never stop OCR from starting.
  try {
    if (typeof PerformanceObserver !== "undefined") {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceResourceTiming[]) post({ type: "net", url: e.name, transferSize: e.transferSize ?? 0 });
      }).observe({ type: "resource", buffered: true });
    }
  } catch {
    // Then the page's "What left this device" list cannot show this worker's
    // own downloads (models / runtime, same origin). The CSP still confines
    // every request, so this only affects the display, not what can leave.
  }
}

class NotStartedError extends Error {
  constructor() {
    super("the reading engine was not started");
  }
}

/** Page side: an OcrEngine that forwards to `serveOcrWorker` in a Web Worker. */
export class WorkerOcrEngine implements OcrEngine {
  id = "worker";
  tier: Tier = "W2";
  private readonly worker: Worker;
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private canRegion = true;
  /** Last start-up stage the worker reported, so a stall can say where it stopped. */
  private stage = "starting the reading engine";
  /** Resolves once the worker has said it is listening. */
  private readonly listening: Promise<void>;
  private onListening!: () => void;
  /** The worker run that was initialised, and the config to start a new one. */
  private startedBoot: string | null = null;
  private cfg: Omit<OcrEngineConfig, "onAssetProgress" | "onStage"> | null = null;

  constructor(
    worker: Worker,
    hooks: { onNetwork?: (url: string, transferSize: number) => void; onAssetProgress?: (l: number, t: number) => void; onStage?: (stage: string) => void } = {},
  ) {
    this.worker = worker;
    this.listening = new Promise((resolve) => (this.onListening = resolve));
    // A worker that fails to load or crashes must fail loudly, not hang.
    const failAll = (reason: string) => {
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      failAll(`the reading engine failed to start${e.message ? `: ${e.message}` : ""}`);
    };
    worker.onmessageerror = () => failAll("the reading engine sent an unreadable message");
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if ("type" in m) {
        if (m.type === "ready") {
          this.onListening();
          // A different run than the one we started: iOS restarted it.
          if (this.startedBoot && m.boot !== this.startedBoot) this.startedBoot = null;
        } else if (m.type === "net") hooks.onNetwork?.(m.url, m.transferSize);
        else if (m.type === "stage") {
          this.stage = m.stage;
          hooks.onStage?.(m.stage);
        } else hooks.onAssetProgress?.(m.loaded, m.total);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve({ value: m.value, boot: m.boot });
      else p.reject(m.code === "not-started" ? new NotStartedError() : new Error(m.error));
    };
  }

  private async call<T>(req: Omit<WorkerRequest, "id"> & Record<string, unknown>): Promise<T> {
    return (await this.callRaw<T>(req)).value;
  }

  private callRaw<T>(req: Omit<WorkerRequest, "id"> & Record<string, unknown>): Promise<{ value: T; boot: string }> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // Structured clone copies the pixels; the worker wipes its copy after use.
      this.worker.postMessage({ ...req, id });
    });
  }

  async init(cfg: Omit<OcrEngineConfig, "onAssetProgress" | "onStage">, timeoutMs = 180_000): Promise<Tier> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the reading engine did not start in time (stuck ${this.stage})`)), timeoutMs);
    });
    this.cfg = cfg;
    const r = await Promise.race([this.start(cfg), timeout]).finally(() => clearTimeout(timer));
    this.tier = r.tier;
    this.id = r.id;
    this.canRegion = r.id.startsWith("paddleocr");
    return r.tier;
  }

  private async start(cfg: Omit<OcrEngineConfig, "onAssetProgress" | "onStage">) {
    // Workers built before the "ready" message never send it; don't wait forever.
    await Promise.race([this.listening, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    const r = await this.callRaw<{ tier: Tier; id: string }>({ op: "init", cfg });
    this.startedBoot = r.boot;
    return r.value;
  }

  /**
   * Run a request; if the worker answers that it has no engine (it was
   * restarted, or never got "init"), start it again and retry once.
   */
  private async withEngine<T>(req: Omit<WorkerRequest, "id"> & Record<string, unknown>): Promise<T> {
    if (this.cfg && !this.startedBoot) await this.start(this.cfg);
    try {
      return await this.call<T>(req);
    } catch (err) {
      if (!(err instanceof NotStartedError) || !this.cfg) throw err;
      console.warn("[ocr] the reading engine had restarted; starting it again");
      await this.start(this.cfg);
      return this.call<T>(req);
    }
  }

  recognize(image: PageImage, options?: OcrOptions): Promise<TextLine[]> {
    return this.withEngine({ op: "recognize", image, ...(options ? { options } : {}) });
  }

  recognizeRegion?: OcrEngine["recognizeRegion"] = (image, region, options) => {
    if (!this.canRegion) return Promise.resolve({ text: "", confidence: 0 });
    return this.withEngine({ op: "recognizeRegion", image, region, ...(options ? { options } : {}) });
  };

  async dispose(): Promise<void> {
    await this.call({ op: "dispose" });
    this.worker.terminate();
  }
}

export interface WebEnginesConfig {
  /** Base URL of the app's self-hosted static assets (models, ORT, pdf.js, tesseract). */
  assetBase: string;
  /** Hash-pinned model files, generated at build time. */
  manifest: ModelManifest;
  capabilities?: Capabilities;
  /** Run OCR in this worker (it must call `serveOcrWorker(self)`). Recommended. */
  ocrWorker?: Worker;
  /** Longest side for OCR input; lower on low-memory devices. */
  maxImageSide?: number;
  onAssetProgress?: (loaded: number, total: number) => void;
  onStage?: (stage: string) => void;
  /** URL of pdf.js's worker script (default `<assetBase>/pdfjs/pdf.worker.min.mjs`). */
  pdfWorkerUrl?: string;
  /** Network requests made inside the OCR worker. */
  onWorkerNetwork?: (url: string, transferSize: number) => void;
}

export interface WebEngines {
  engines: PlatformEngines;
  capabilities: Capabilities;
  dispose(): Promise<void>;
}

/**
 * Wire the browser implementation of every platform capability the
 * pipeline needs. pdf.js and image decoding run on the page (pdf.js parses
 * in its own worker); OCR runs in `ocrWorker` when given.
 */
export async function createWebEngines(cfg: WebEnginesConfig): Promise<WebEngines> {
  const base = cfg.assetBase.replace(/\/?$/, "/");
  const capabilities = cfg.capabilities ?? (await detectCapabilities());
  // Smaller images on low-end devices only: a 1600 px page is ~8 MB, which
  // iOS handles, and smaller makes the MRZ's small print unreadable.
  const maxSide = cfg.maxImageSide ?? (capabilities.tier === "L" ? 1200 : 1600);

  // The legacy build supports older browsers (the default one needs very
  // recent JS features), which matters on low-end and older phones.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = cfg.pdfWorkerUrl ?? `${base}pdfjs/pdf.worker.min.mjs`;
  const pdf = new PdfReader({ pdfjs, createCanvas: createBrowserCanvas, assetBase: `${base}pdfjs/`, maxSide });

  const engineCfg = { assetBase: base, manifest: cfg.manifest, tier: capabilities.tier, threads: capabilities.threads, cores: capabilities.cores };
  let ocr: OcrEngine;
  if (cfg.ocrWorker) {
    const proxy = new WorkerOcrEngine(cfg.ocrWorker, {
      ...(cfg.onWorkerNetwork ? { onNetwork: cfg.onWorkerNetwork } : {}),
      ...(cfg.onAssetProgress ? { onAssetProgress: cfg.onAssetProgress } : {}),
      ...(cfg.onStage ? { onStage: cfg.onStage } : {}),
    });
    capabilities.tier = await proxy.init(engineCfg);
    ocr = proxy;
  } else {
    const r = await createOcrEngine({
      ...engineCfg,
      ...(cfg.onAssetProgress ? { onAssetProgress: cfg.onAssetProgress } : {}),
      ...(cfg.onStage ? { onStage: cfg.onStage } : {}),
    });
    capabilities.tier = r.tier;
    ocr = r.engine;
  }

  const engines: PlatformEngines = {
    pdfText: async (input: DocumentInput) => (PdfReader.isPdf(input) ? pdf.text(input) : null),
    pageCount: async (input) => (PdfReader.isPdf(input) ? pdf.pageCount(input) : 1),
    rasterize: async (input, page) => (PdfReader.isPdf(input) ? pdf.render(input, page) : decodeImageBrowser(input, maxSide)),
    ocr,
    quality: (img) => assessQuality(img),
  };

  return {
    engines,
    capabilities,
    async dispose() {
      await ocr.dispose?.();
    },
  };
}
