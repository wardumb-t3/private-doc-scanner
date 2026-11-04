import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { BROWSER_TARGET } from "./scripts/browser-target.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

function gitSha(): string {
  // Vercel and most CI hosts build from a checkout without .git history.
  const fromCi = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA;
  if (fromCi) return fromCi;
  try {
    return execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  } catch {
    return "unknown";
  }
}

interface DeployConfig {
  destination: { type: string; baseUrl?: string; endpoint?: string };
}

/**
 * Deployment config: `PDE_CONFIG_FILE` (e.g. one written by `pnpm t3:config`)
 * or the tracked default `public/pde.config.json` (dry-run).
 */
const configFile = process.env.PDE_CONFIG_FILE ?? fileURLToPath(new URL("./public/pde.config.json", import.meta.url));

/** The deployment config: `PDE_CONFIG_JSON` (e.g. a Vercel env var), else the file above. */
function configText(): string {
  return process.env.PDE_CONFIG_JSON?.trim() || readFileSync(configFile, "utf8");
}

/** Origins the deployment may contact besides itself — from the deployment config. */
function destinationOrigins(): string[] {
  const cfg = JSON.parse(configText()) as DeployConfig;
  const url = cfg.destination.baseUrl ?? cfg.destination.endpoint;
  // Relative URLs ("/t3") are a same-origin relay: covered by 'self'.
  return url && /^https?:\/\//.test(url) ? [new URL(url).origin] : [];
}

/**
 * Security headers. The CSP is the enforcement behind the privacy promise:
 * the page can only talk to itself and the configured destination.
 * COOP/COEP enable cross-origin isolation (multi-threaded WASM).
 */
export function securityHeaders(): Record<string, string> {
  const connect = ["'self'", ...destinationOrigins()].join(" ");
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    `connect-src ${connect}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Same `/pde-signout` endpoint as on Vercel / Caddy, for `vite dev` and `vite preview`. */
function signoutEndpoint(): Plugin {
  const mw = (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(): void }, next: () => void) => {
    if (req.url?.split("?")[0] !== "/pde-signout") return next();
    res.statusCode = 204;
    res.setHeader("Set-Cookie", "t3_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/");
    res.setHeader("Cache-Control", "no-store");
    res.end();
  };
  return {
    name: "pde-signout",
    configureServer: (server) => void server.middlewares.use(mw),
    configurePreviewServer: (server) => void server.middlewares.use(mw),
  };
}

/**
 * After build: emit `_headers` (Netlify / Cloudflare Pages format) with the
 * same security headers, `version.json` (the build's commit), and
 * `assets-index.json` — the SHA-256 of every
 * deployed file, so anyone can check a deployment against a source build.
 */
function deployFiles(): Plugin {
  return {
    name: "pde-deploy-files",
    apply: "build",
    closeBundle() {
      const dist = fileURLToPath(new URL("./dist/", import.meta.url));
      // Ship the selected deployment config (the tracked default is dry-run).
      writeFileSync(join(dist, "pde.config.json"), configText());
      // Lets an open page notice it is an older build than the server's.
      writeFileSync(join(dist, "version.json"), JSON.stringify({ sha: BUILD.sha }));
      const lines = ["/*", ...Object.entries(securityHeaders()).map(([k, v]) => `  ${k}: ${v}`)];
      writeFileSync(join(dist, "_headers"), lines.join("\n") + "\n");
      const index: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (!p.endsWith(".map")) index[relative(dist, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
        }
      };
      walk(dist);
      writeFileSync(join(dist, "assets-index.json"), JSON.stringify(index, null, 2));
    },
  };
}

const BUILD = { version: pkg.version, sha: process.env.PDE_BUILD_SHA ?? gitSha() };

export default defineConfig({
  base: "./",
  define: {
    __PDE_BUILD__: JSON.stringify(BUILD),
  },
  server: { headers: securityHeaders() },
  preview: { headers: securityHeaders() },
  worker: { format: "es" },
  build: {
    // Safari 15 is the oldest browser with module workers, which the OCR
    // worker needs. Newer syntax (e.g. class static blocks, Safari 16.4+)
    // is compiled down, and scripts/check-syntax.mjs fails the build if any
    // shipped script still has it.
    target: BROWSER_TARGET,
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    // These packages locate their own .wasm/.mjs files at runtime.
    exclude: ["onnxruntime-web", "@terminal3/t3n-sdk", "tesseract.js"],
  },
  plugins: [deployFiles(), signoutEndpoint()],
});
