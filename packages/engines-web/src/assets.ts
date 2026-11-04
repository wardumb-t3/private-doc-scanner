/**
 * Self-hosted, hash-pinned model loading. Models are fetched only from the
 * origin that serves the app, verified against SHA-256 digests baked into the
 * build (checked after every download and on every cache read) and kept
 * in the Cache API so later runs — and airplane mode — need no network.
 */

export interface AssetRef {
  /** URL relative to the app (same origin). */
  url: string;
  /** Hex SHA-256 of the file. */
  sha256: string;
  bytes: number;
}

export interface ModelManifest {
  version: string;
  assets: Record<string, AssetRef>;
}

const CACHE_NAME = "pde-models-v1";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class AssetIntegrityError extends Error {
  constructor(url: string) {
    super(`Integrity check failed for ${url}`);
    this.name = "AssetIntegrityError";
  }
}

/** A download that stops receiving bytes for this long is reported, not waited on. */
const STALL_MS = 45_000;

/** Fetch an asset, verifying its pinned hash; serve from cache when possible. */
export async function loadAsset(ref: AssetRef, onProgress?: (loaded: number, total: number) => void, stallMs = STALL_MS): Promise<ArrayBuffer> {
  const cache = typeof caches !== "undefined" ? await caches.open(CACHE_NAME).catch(() => null) : null;
  const cached = cache ? await cache.match(ref.url) : undefined;
  if (cached) {
    const buf = await cached.arrayBuffer();
    if ((await sha256Hex(buf)) === ref.sha256) {
      onProgress?.(ref.bytes, ref.bytes);
      return buf;
    }
    await cache?.delete(ref.url);
  }

  // The hash is checked below rather than with fetch's `integrity` option:
  // with it the browser buffers the whole body before handing it over, so
  // there would be no progress and no way to notice a stalled download.
  const name = ref.url.split("/").pop() ?? ref.url;
  const abort = new AbortController();
  let loaded = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(), stallMs);
  };
  let buf: ArrayBuffer;
  try {
    arm();
    const res = await fetch(ref.url, { credentials: "omit", signal: abort.signal });
    if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
    buf = await readWithProgress(res, abort.signal, (n) => {
      loaded = n;
      arm();
      onProgress?.(n, ref.bytes);
    });
  } catch (err) {
    if (abort.signal.aborted) {
      throw new Error(`downloading ${name} stopped at ${mb(loaded)} of ${mb(ref.bytes)} MB`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if ((await sha256Hex(buf)) !== ref.sha256) throw new AssetIntegrityError(ref.url);
  await cache?.put(ref.url, new Response(buf.slice(0))).catch(() => {});
  return buf;
}

function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(1);
}

async function readWithProgress(res: Response, signal: AbortSignal, onBytes: (loaded: number) => void): Promise<ArrayBuffer> {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  // Aborting the fetch does not always release a read that is already
  // waiting; cancelling the reader does.
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("download stalled");
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onBytes(loaded);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out.buffer;
}

/** True when every asset is already cached (⇒ extraction works offline). */
export async function assetsCached(refs: AssetRef[]): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  if (!cache) return false;
  for (const r of refs) if (!(await cache.match(r.url))) return false;
  return true;
}
