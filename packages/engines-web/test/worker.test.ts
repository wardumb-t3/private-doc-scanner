import { afterEach, describe, expect, it, vi } from "vitest";
import { serveOcrWorker, WorkerOcrEngine } from "../src/platform.ts";

describe("OCR worker start-up", () => {
  const original = globalThis.PerformanceObserver;
  afterEach(() => {
    globalThis.PerformanceObserver = original;
  });

  it("still answers requests when resource observers are unsupported in workers (Safari)", async () => {
    globalThis.PerformanceObserver = class {
      observe() {
        throw new TypeError("type 'resource' not supported in workers");
      }
    } as unknown as typeof PerformanceObserver;
    const posted: unknown[] = [];
    const scope = { postMessage: (m: unknown) => posted.push(m), onmessage: null as ((e: MessageEvent) => void) | null };
    expect(() => serveOcrWorker(scope)).not.toThrow();
    expect(scope.onmessage).toBeTypeOf("function");
    await scope.onmessage!({ data: { id: 1, op: "dispose" } } as MessageEvent);
    await vi.waitFor(() => expect(posted).toContainEqual(expect.objectContaining({ id: 1, ok: true, value: null })));
    // It announces that it is listening, so the page knows when to send "init".
    expect(posted[0]).toMatchObject({ type: "ready" });
  });
});

describe("OCR worker requests", () => {
  it("reports why the engine failed to load instead of 'not initialised'", async () => {
    const posted: { id?: number; ok?: boolean; error?: string }[] = [];
    const scope = { postMessage: (m: unknown) => posted.push(m as never), onmessage: null as ((e: MessageEvent) => void) | null };
    serveOcrWorker(scope);
    // init with a manifest missing the models → load fails
    void scope.onmessage!({ data: { id: 1, op: "init", cfg: { assetBase: "https://x.invalid/", manifest: { version: "x", assets: {} }, tier: "W2", threads: false, cores: 1 } } } as MessageEvent);
    void scope.onmessage!({ data: { id: 2, op: "recognize", image: { page: 1, width: 1, height: 1, data: new Uint8ClampedArray(4) } } } as MessageEvent);
    await vi.waitFor(() => expect(posted.filter((p) => p.id).length).toBe(2));
    const recog = posted.find((p) => p.id === 2)!;
    expect(recog.ok).toBe(false);
    expect(recog.error).toMatch(/failed to load: model manifest is missing ppocr_det/);
  });
});

/** A scripted worker that behaves like WebKit's module workers can. */
class FlakyWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  loaded = false;
  started = false;
  boot = "boot-1";
  inits = 0;
  /** The worker's code has run: from now on it hears messages. */
  load() {
    this.loaded = true;
    this.emit({ type: "ready", boot: this.boot });
  }
  /** iOS restarted the worker: its engine is gone. */
  restart(boot: string) {
    this.started = false;
    this.boot = boot;
    this.emit({ type: "ready", boot });
  }
  postMessage(m: { id: number; op: string }) {
    if (!this.loaded) return; // dropped, as WebKit can before the module has run
    if (m.op === "init") {
      this.inits++;
      this.started = true;
      this.emit({ id: m.id, ok: true, value: { tier: "W2", id: "paddleocr-wasm" }, boot: this.boot });
    } else if (!this.started) this.emit({ id: m.id, ok: false, error: "the reading engine was not started", code: "not-started", boot: this.boot });
    else this.emit({ id: m.id, ok: true, value: [], boot: this.boot });
  }
  terminate() {}
  private emit(data: unknown) {
    queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
  }
}

describe("page side of the OCR worker (iOS)", () => {
  const cfg = { assetBase: "https://x.invalid/", manifest: { version: "x", assets: {} }, tier: "W2" as const, threads: false, cores: 1 };
  const image = { page: 1, width: 1, height: 1, data: new Uint8ClampedArray(4) };

  it("waits for the worker to listen before sending init (messages sent earlier are lost)", async () => {
    const worker = new FlakyWorker();
    const engine = new WorkerOcrEngine(worker as unknown as Worker);
    const tier = engine.init(cfg);
    setTimeout(() => worker.load(), 20);
    await expect(tier).resolves.toBe("W2");
    await expect(engine.recognize(image)).resolves.toEqual([]);
    expect(worker.inits).toBe(1);
  });

  it("starts a restarted worker again instead of failing with 'not started'", async () => {
    const worker = new FlakyWorker();
    worker.load();
    const engine = new WorkerOcrEngine(worker as unknown as Worker);
    await engine.init(cfg);
    worker.restart("boot-2");
    await new Promise((r) => setTimeout(r, 0));
    await expect(engine.recognize(image)).resolves.toEqual([]);
    expect(worker.inits).toBe(2);
  });

  it("recovers even when the restart was not announced", async () => {
    const worker = new FlakyWorker();
    worker.load();
    const engine = new WorkerOcrEngine(worker as unknown as Worker);
    await engine.init(cfg);
    worker.started = false; // engine lost, no "ready" seen
    await expect(engine.recognize(image)).resolves.toEqual([]);
    expect(worker.inits).toBe(2);
  });
});
