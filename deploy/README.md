# Hosting

| | Hostinger VPS (Caddy) | Vercel |
|---|---|---|
| Use it for | The app plus the `/t3` relay, with full control of headers and logs | The app plus the `/t3` relay via a rewrite. **No domain needed** (`*.vercel.app`). |
| Talks to T3 | Yes, through the same-origin relay | Yes, through the same-origin rewrite (not yet tested against the live node) |
| HTTPS | Automatic (Caddy / Let's Encrypt) | Automatic |
| Plan | Any VPS with 1 GB of RAM or more | Pro, because Hobby is for non-commercial use only |

## Why a relay

The capture app runs `@terminal3/t3n-sdk` **in the user's browser**, so values are encrypted on the device. T3 nodes only answer browser calls from allow-listed origins. The latest release, `testnet-v1.0.11`, refuses `cors_allow_any_origin` on real-TEE nodes.

The relay makes the node same-origin with the app:

```
browser ── https://capture.example.com/        static app (Caddy)
        └─ https://capture.example.com/t3/*  ──▶ https://cn-api.sg.testnet.t3n.terminal3.io/*
```

It is a **blind** relay:

- **It only sees ciphertext.** The SDK verifies the node's TDX attestation and sets up an ML-KEM session with the enclave. Every payload is encrypted before it leaves the browser.
- **It strips identifying headers.** `Origin` and `Referer` are removed; the referer would otherwise carry the request link.
- **It keeps no logs.** Caddy's logs are discarded.
- **What T3 sees:** the node gets the user's IP via `X-Forwarded-For`, so its per-IP rate limits stay per user. All relay traffic arrives from the VPS's IP.

## VPS (Hostinger, Ubuntu 22.04/24.04)

1. **DNS:** create an `A` record for `capture.example.com` pointing at the VPS IP (hPanel → Domains → DNS Zone, or wherever your DNS lives).
2. **Firewall:** in hPanel → VPS → Security → Firewall, allow TCP **22, 80 and 443**. Hostinger's firewall drops everything else, and Caddy needs port 80 to get its certificate.
3. **Setup, once, as root:**
   ```sh
   git clone https://github.com/Terminal-3/private-doc-scanner.git /tmp/pds
   CAPTURE_DOMAIN=capture.example.com bash /tmp/pds/deploy/vps/setup.sh
   ```
   This installs Caddy and Node 22 + pnpm, creates a `pde` user with a checkout, enables `ufw` and prepares `/var/www/pde`.
4. **Publish the app, as `pde`:**
   ```sh
   sudo -iu pde
   cd ~/private-doc-scanner
   bash deploy/vps/deploy-app.sh
   ```
   This builds with a config that seals each signed-in user's data to their own vault through `https://capture.example.com/t3`, rsyncs to `/var/www/pde`, renders `/etc/caddy/Caddyfile` with `deploy/render-caddyfile.mjs`, and reloads Caddy. No API key is involved: users set up their own vault from the app.
5. **Check it:**
   ```sh
   curl -sI https://capture.example.com/ | grep -i cross-origin       # COOP / COEP present
   curl -s  https://capture.example.com/t3/status | head -c 200        # relay reaches the node
   ```
   Then open `https://capture.example.com/` on a phone, scan a document, and sign in with email + code at the seal step.

To update later, run `bash deploy/vps/deploy-app.sh` again; it pulls, rebuilds and reloads.

Notes:

- **Caddyfile source:** it is generated from the build's `dist/_headers`, so the CSP, COOP and COEP headers come from one place, `apps/capture-pwa/vite.config.ts`.
- **Compression:** WASM and ONNX are compressed on the fly. The 26 MB WebGPU runtime goes out as about 6 MB, and assets are cached immutably. Caddy 2.10's `file_server { precompressed }` answers `206` without a range request, which breaks module scripts, so the generated config doesn't use it.
- **Behind Cloudflare:** turn off Rocket Loader, HTML rewriting and email obfuscation, and bypass the cache for `sw.js`.

## Vercel (no domain needed)

Vercel can host the app **and** the relay. The `vercel.json` in `apps/capture-pwa` rewrites `/t3/*` to the testnet node, so the browser only ever talks to `https://<project>.vercel.app`. The app config uses a relative `"baseUrl": "/t3"`, so the same config works on preview URLs, `*.vercel.app` and custom domains.

1. Generate the app config:
   ```sh
   pnpm install
   pnpm t3:config            # no domain → prints PDE_CONFIG_JSON=…
   ```
   By default this sends each signed-in user's data to **their own vault**, `z:<their tid>:doc-intake`, which they register under their own DID with the starter kit (`starter/`, driven from Claude Code chat). It needs no key and no deployment of ours.

   For the older shared setup, where everyone's data goes to one contract you deploy, run `read -s T3N_API_KEY && export T3N_API_KEY && pnpm contract:build && pnpm t3:deploy`, then `PDE_FIXED_CONTRACT=1 pnpm t3:config`. Whoever holds that deploying key can read all submissions (see `tools/t3/README.md` → Storage).
2. Vercel → New Project → import `Terminal-3/private-doc-scanner` (or your fork):
   - **Root Directory:** `apps/capture-pwa`. Keep "Include files outside the root directory" on.
   - **Environment variables** (Production and Preview):
     - `ENABLE_EXPERIMENTAL_COREPACK=1`
     - `PDE_CONFIG_JSON` = the single-line JSON printed by `pnpm t3:config`
3. Deploy, then test:
   - **Through the relay:** `T3N_BASE_URL=https://<project>.vercel.app/t3 pnpm t3:smoke`
   - **In a browser:** `https://<project>.vercel.app/?req=req_mytest_0001&types=passport,payslip`

Without `PDE_CONFIG_JSON`, the build uses the tracked dry-run config: nothing is sent, which suits demos.

**Vercel caveats:**

- **Plan:** Hobby is for non-commercial use only; use Pro for business pilots.
- **Visibility:** the relay is a Vercel external rewrite. Vercel forwards the encrypted traffic and sees only ciphertext, just like the Caddy relay.
- **Headers:** Vercel cannot strip request headers the way Caddy does. `Referrer-Policy: no-referrer` stops browsers sending a Referer, but `Origin` still reaches the node (it doesn't affect anything).
- **Not yet confirmed:** the Vercel relay has not been tested against the live node.

**Fallback without a domain:** a VPS can use a free hostname such as `<VPS-IP-with-dashes>.sslip.io` (for example `203-0-113-7.sslip.io`, which resolves to that IP). Caddy gets a real certificate for it, so the VPS steps above work unchanged with `CAPTURE_DOMAIN=203-0-113-7.sslip.io`.
