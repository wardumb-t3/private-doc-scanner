/**
 * "What left this device": an exact list of every network request the page
 * (and its workers, which report in via `record`) makes, built from the
 * browser's own Resource Timing entries — not from our claims. CSP
 * violations (requests the browser blocked) are listed too.
 *
 * Any request to an origin outside the allow-list marks the session as
 * untrusted and the flow refuses to submit.
 */

export type RequestKind = "app" | "model" | "submission" | "unexpected" | "blocked";

export interface NetworkEntry {
  url: string;
  origin: string;
  kind: RequestKind;
  /** Bytes received over the network (0 = served from cache). */
  transferSize: number;
  at: number;
  /** For models: the pinned hash the file was verified against. */
  sha256?: string;
}

export interface NetworkMonitorOptions {
  /**
   * Where the encrypted submission goes: origins (`https://node.example`) or
   * URL prefixes (`https://app.example/t3` for a same-origin relay).
   */
  destinationOrigins: string[];
  /** Same-origin path prefixes that hold reading models. */
  modelPaths?: string[];
  /** Known model hashes by URL path, shown next to the download. */
  modelHashes?: Record<string, string>;
}

type Listener = (entries: NetworkEntry[]) => void;

export class NetworkMonitor {
  readonly entries: NetworkEntry[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly opts: Required<NetworkMonitorOptions>;
  private readonly self: string;
  private observer: PerformanceObserver | null = null;
  private onViolation = (e: SecurityPolicyViolationEvent) => {
    this.push({ url: e.blockedURI, origin: safeOrigin(e.blockedURI), kind: "blocked", transferSize: 0, at: Date.now() });
  };

  constructor(opts: NetworkMonitorOptions) {
    this.opts = { modelPaths: ["/models/", "/tesseract/", "/ort-wasm"], modelHashes: {}, ...opts };
    this.self = typeof location !== "undefined" ? location.origin : "";
  }

  start(): void {
    if (typeof PerformanceObserver === "undefined" || this.observer) return;
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceResourceTiming[]) this.record(e.name, e.transferSize ?? 0);
    });
    this.observer.observe({ type: "resource", buffered: true });
    for (const nav of performance.getEntriesByType("navigation") as PerformanceNavigationTiming[]) this.record(nav.name, nav.transferSize ?? 0);
    document.addEventListener("securitypolicyviolation", this.onViolation);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (typeof document !== "undefined") document.removeEventListener("securitypolicyviolation", this.onViolation);
  }

  /** Record a request (workers relay their own Resource Timing entries here). */
  record(url: string, transferSize = 0): void {
    if (url.startsWith("data:") || url.startsWith("blob:")) return; // in-memory, not network
    const origin = safeOrigin(url);
    const path = safePath(url);
    let kind: RequestKind;
    if (this.isDestination(url, origin)) kind = "submission";
    else if (origin === this.self) kind = this.opts.modelPaths.some((p) => path.includes(p)) ? "model" : "app";
    else kind = "unexpected";
    const sha256 = this.opts.modelHashes[path];
    this.push({ url, origin, kind, transferSize, at: Date.now(), ...(sha256 ? { sha256 } : {}) });
  }

  private isDestination(url: string, origin: string): boolean {
    return this.opts.destinationOrigins.some((d) => {
      const prefix = d.replace(/\/+$/, "");
      // A bare origin matches everything on it; a path prefix matches that path and below.
      if (safePath(prefix) === "/" || prefix === safeOrigin(prefix)) return origin === safeOrigin(prefix);
      return url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`);
    });
  }

  /** True while nothing has reached (or tried to reach) a non-allowed origin. */
  get trusted(): boolean {
    return !this.entries.some((e) => e.kind === "unexpected" || e.kind === "blocked");
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.entries);
    return () => this.listeners.delete(fn);
  }

  private push(e: NetworkEntry) {
    this.entries.push(e);
    for (const l of this.listeners) l(this.entries);
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url, typeof location !== "undefined" ? location.href : undefined).origin;
  } catch {
    return url;
  }
}

function safePath(url: string): string {
  try {
    return new URL(url, typeof location !== "undefined" ? location.href : undefined).pathname;
  } catch {
    return url;
  }
}
