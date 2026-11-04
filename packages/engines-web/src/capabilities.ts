/**
 * Runtime capability detection → engine tier. The same build runs on a new
 * iPhone, a 2 GB Android Go phone and a desktop; the tier decides how much
 * OCR we attempt so low-end devices stay inside their memory budget.
 *
 *  W1  WebGPU + ≥4 GB      PP-OCR on WebGPU, full-page OCR (not on Safari / iOS)
 *  W2  WASM SIMD           PP-OCR on WASM (threads when cross-origin isolated)
 *  L   ≤2 GB / no SIMD     text layer + MRZ band only; manual entry otherwise
 */
export type Tier = "W1" | "W2" | "L";

export interface Capabilities {
  tier: Tier;
  /** iPhone / iPad (any browser there is WebKit): tight per-tab memory limits. */
  ios: boolean;
  /** Safari, or any iOS browser (all WebKit). */
  webkit: boolean;
  webgpu: boolean;
  wasmSimd: boolean;
  /** SharedArrayBuffer available ⇒ multi-threaded WASM. */
  threads: boolean;
  /** navigator.deviceMemory (GB, coarse, Chromium only). */
  deviceMemoryGb: number | null;
  cores: number;
  offscreenCanvas: boolean;
}

// Smallest module using a v128 instruction; validates only with SIMD support.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export async function detectCapabilities(override?: Partial<Capabilities>): Promise<Capabilities> {
  const nav = (typeof navigator !== "undefined" ? navigator : {}) as Navigator & {
    deviceMemory?: number;
    gpu?: { requestAdapter(): Promise<unknown> };
  };
  let webgpu = false;
  if (nav.gpu) {
    try {
      // Some browsers take a long time (or never answer) here; don't let
      // GPU detection block the reader — fall back to WASM after 3 s.
      const adapter = await Promise.race([
        nav.gpu.requestAdapter(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      webgpu = adapter !== null && adapter !== undefined;
    } catch {
      webgpu = false;
    }
  }
  let wasmSimd: boolean;
  try {
    wasmSimd = typeof WebAssembly !== "undefined" && WebAssembly.validate(SIMD_PROBE);
  } catch {
    wasmSimd = false;
  }
  const threads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";
  const deviceMemoryGb = typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
  const cores = nav.hardwareConcurrency ?? 1;
  const offscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const ua = nav.userAgent ?? "";
  // iPadOS reports itself as a Mac; touch support gives it away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  // Desktop Chrome and Edge also say "AppleWebKit"; only Safari lacks a Chromium token.
  const webkit = ios || (/AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua));

  const caps: Capabilities = {
    tier: "L",
    ios,
    webkit,
    webgpu,
    wasmSimd,
    // ONNX Runtime's thread pool runs in nested workers, which can stall
    // WebKit while the model loads; one thread is slower but reliable there.
    threads: threads && !webkit,
    deviceMemoryGb,
    cores,
    offscreenCanvas,
    ...override,
  };
  if (!override?.tier) caps.tier = pickTier(caps);
  return caps;
}

export function pickTier(c: Omit<Capabilities, "tier" | "ios" | "webkit"> & { ios?: boolean; webkit?: boolean }): Tier {
  const lowMemory = c.deviceMemoryGb !== null && c.deviceMemoryGb <= 2;
  if (!c.wasmSimd || lowMemory) return "L";
  // iOS kills tabs that grow past a few hundred MB, and ONNX Runtime's
  // WebGPU build (26 MB, not supported on Safari) is the heaviest option, so
  // every WebKit browser uses WASM.
  if (c.ios || c.webkit) return "W2";
  if (c.webgpu && (c.deviceMemoryGb === null || c.deviceMemoryGb >= 4)) return "W1";
  return "W2";
}
