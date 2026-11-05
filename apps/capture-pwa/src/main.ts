import "@pde/engines-web/polyfills";
import { extractDocument, type DocType } from "@pde/core";
import { assetsCached, assetsForTier, createWebEngines, detectCapabilities, type ModelManifest, type WebEngines } from "@pde/engines-web";
import { NetworkMonitor, type Extractor, type PdeFlow } from "@pde/ui";
import "@pde/ui";
import { createDestination, type DestinationConfig } from "./destinations.ts";
import { SIGN_UP_URL } from "./otp-dialog.ts";
// Bundled (not copied) so it is compiled for the same browsers as the app
// (even pdf.js's "legacy" worker uses syntax Safari 15 cannot parse) and
// gets the stream polyfill Safari / iOS need.
import pdfWorkerUrl from "./pdf.worker.ts?worker&url";

declare const __PDE_BUILD__: { version: string; sha: string };

interface AppConfig {
  destination: DestinationConfig;
  defaultDocTypes: DocType[];
  repoUrl: string;
}

const DOC_TYPES: DocType[] = ["passport", "id_card", "payslip", "bank_statement", "generic"];

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, location.href), { credentials: "omit" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Resolves `fallback` if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Offline support is best effort. In-app browsers (Chrome and others on
 * iOS run in a WebView) may not offer service workers, or registration may
 * never settle, so this never waits long and reading never depends on it.
 */
async function registerServiceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    await within(navigator.serviceWorker.register(new URL("./sw.js", location.href), { scope: "./" }), 10_000, null);
    return await within(navigator.serviceWorker.ready.then(() => true), 10_000, false);
  } catch {
    return false;
  }
}

/** Ask the service worker to keep everything this session loaded available offline. */
async function cacheForOffline(urls: string[]): Promise<boolean> {
  const sw = navigator.serviceWorker?.controller ?? (await within(navigator.serviceWorker?.ready ?? Promise.resolve(null), 5_000, null))?.active;
  if (!sw) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent<{ ok: boolean; failed: string[] }>) => {
      if (!e.data.ok) console.warn("not available offline:", e.data.failed);
      resolve(e.data.ok);
    };
    sw.postMessage({ type: "cache-urls", urls }, [channel.port2]);
    setTimeout(() => resolve(false), 30_000);
  });
}

/**
 * A phone can keep running an older build from its offline cache. If the
 * server has a different build, drop this app's service worker and caches
 * and load the current one (once per tab, so an unreachable server or a
 * mid-deploy mismatch can't cause a reload loop).
 */
async function ensureCurrentBuild(): Promise<boolean> {
  let served: string | undefined;
  try {
    const res = await fetch(new URL("./version.json", location.href), { cache: "no-store", credentials: "omit" });
    if (!res.ok) return true;
    served = ((await res.json()) as { sha?: string }).sha;
  } catch {
    return true; // Offline: the cached build is all there is.
  }
  if (!served || served === __PDE_BUILD__.sha) return true;
  const key = `pde-reloaded-for-${served}`;
  try {
    if (sessionStorage.getItem(key)) return true;
    sessionStorage.setItem(key, "1");
  } catch {
    return true;
  }
  console.warn(`running build ${__PDE_BUILD__.sha}, server has ${served}: refreshing`);
  for (const r of (await navigator.serviceWorker?.getRegistrations().catch(() => [])) ?? []) await r.unregister();
  for (const k of await caches.keys().catch(() => [] as string[])) if (k.startsWith("pde-app-")) await caches.delete(k);
  location.reload();
  return false;
}

/** The testnet node a coding session must be allowed to reach (the scanner itself goes through /t3). */
const T3N_NODE_HOST = "cn-api.sg.testnet.t3n.terminal3.io";

/** Shown in the footer, so anyone can see which configuration this deployment runs. */
function modeLabel(d: DestinationConfig): string {
  if (d.type === "dry-run") return "demo mode: nothing is sent";
  if (d.type === "hpke") return "sends to the requester's key";
  return d.target.kind === "own-contract" ? "saves to your own vault" : d.target.kind === "contract" ? "saves to a shared contract" : "saves to your T3N profile";
}

async function boot() {
  if (!(await ensureCurrentBuild())) return;
  const [config, manifest] = await Promise.all([getJson<AppConfig>("./pde.config.json"), getJson<ModelManifest>("./models/manifest.json")]);
  const params = new URLSearchParams(location.search);
  const requested = (params.get("types") ?? "").split(",").filter((t): t is DocType => DOC_TYPES.includes(t as DocType));
  // Every type is offered on the start page; a link's `types=` (or the
  // deployment default) only decides which are marked "Requested".
  const requestedTypes = requested.length ? requested : config.defaultDocTypes;
  const requestId = params.get("req");
  const destination = createDestination(config.destination);
  const base = new URL("./", location.href).href;

  const modelHashes = Object.fromEntries(Object.values(manifest.assets).map((a) => [new URL(a.url, base).pathname, a.sha256]));
  const monitor = new NetworkMonitor({ destinationOrigins: destination.origins(), modelHashes });

  let engines: WebEngines | null = null;
  const extractor: Extractor = {
    async prepare(onProgress, onStage) {
      const swReady = registerServiceWorker();
      const capabilities = await detectCapabilities();
      const worker = new Worker(new URL("./ocr.worker.ts", import.meta.url), { type: "module", name: "ocr" });
      engines = await createWebEngines({
        assetBase: base,
        manifest,
        capabilities,
        ocrWorker: worker,
        pdfWorkerUrl,
        ...(onProgress ? { onAssetProgress: onProgress } : {}),
        ...(onStage ? { onStage } : {}),
        onWorkerNetwork: (url, size) => monitor.record(url, size),
      });
      const sameOrigin = monitor.entries.filter((e) => e.origin === location.origin).map((e) => e.url);
      const tier = engines.capabilities.tier;
      // Reading can start now; offline caching finishes in the background.
      const offlineReady = (async () =>
        (await swReady) &&
        (await cacheForOffline(sameOrigin)) &&
        (await assetsCached(assetsForTier(manifest, tier).map((a) => ({ ...a, url: new URL(a.url, base).href })))))().catch(() => false);
      return { tier, offlineReady };
    },
    async extract(input, docType, onStage) {
      if (!engines) throw new Error("reader not ready");
      return extractDocument(input, engines.engines, { docType, ...(onStage ? { onProgress: onStage } : {}) });
    },
  };

  const handoff = new URL(location.href);
  handoff.searchParams.set("handoff", "1");

  const flow = document.querySelector("pde-flow") as PdeFlow;
  flow.replaceChildren();
  flow.config = {
    docTypes: DOC_TYPES,
    requestedTypes,
    requestId,
    destination,
    extractor,
    monitor,
    build: { version: __PDE_BUILD__.version, sha: __PDE_BUILD__.sha, repoUrl: config.repoUrl },
    modeLabel: modeLabel(config.destination),
    // After sealing, a prompt that lets any fresh AI session check the submission.
    ...(config.destination.type === "t3n" || (config.destination.type === "dry-run" && config.destination.showAssistantPrompt)
      ? { assistantPrompt: { repoUrl: config.repoUrl, nodeHost: T3N_NODE_HOST, signUpUrl: SIGN_UP_URL } }
      : {}),
    // Sealing needs a Terminal 3 account; demo mode doesn't (unless it's simulating that check).
    ...(config.destination.type === "t3n" || (config.destination.type === "dry-run" && config.destination.simulateNoDeveloperAccount)
      ? { signUpUrl: SIGN_UP_URL }
      : {}),
    handoffUrl: handoff.href,
    destinationName: config.destination.type === "t3n" ? "your T3 enclave" : "the requester's secure enclave",
  };
}

boot().catch((err: unknown) => {
  document.body.textContent = `Could not start: ${(err as Error).message}`;
});
