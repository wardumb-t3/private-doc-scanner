# Privacy model

**Goal:** a person can turn a sensitive document (passport, ID card, payslip, bank statement) into structured fields for a T3 transaction **without the document, or the fields in plain text, reaching any AI assistant, the business, Terminal 3 staff or servers, or the website host.**

## What happens where

| Step | Where it runs | What it sees |
|---|---|---|
| Choose / photograph the document | The user's browser (file picker / camera) | The file, in memory only. Never uploaded. |
| Quality check, PDF text layer, OCR, MRZ, mapping, checks | The user's browser: main thread + an OCR Web Worker | Page pixels and text, in memory only. |
| Review | The user's browser | Fields plus crops of where each was read. |
| Seal | The user's browser (`@pde/adapter-t3n` → `@terminal3/t3n-sdk`) | Reviewed field values, encrypted to the attested enclave. |
| Receive | The T3 node's TEE (Intel TDX), after attestation | The reviewed fields — decrypted only inside the enclave. |
| The chat (Claude, ChatGPT, …) | The AI provider's cloud | A link with a request id going out. The user saying "done" coming back. **No values.** |

## What leaves the device

1. **App code and reading models.** These are downloaded from the site that hosts the app (same origin), never from a CDN. Model files are pinned by SHA-256 hash (Subresource Integrity on fetch, re-checked when read from the cache). `assets-index.json` lists the hash of every deployed file.
2. **The encrypted submission (`pde.submission/v1`).** It holds the reviewed values plus, for each value, how it was obtained (`source`, `validated`, `validated_by`, `user_edited`) and the check ids with pass/fail. It contains no images, no page text, no file name and no check messages. See `packages/core/src/payload.ts` and its test.

That is all. The **"What left this device"** panel shows the browser's own Resource Timing record of every request. This includes requests made by the OCR worker, which are relayed to the page. Requests the CSP blocked also show up there. If anything went to an unexpected origin, the flow **refuses to submit**.

## Enforcement, not just promises

- **CSP:** `connect-src 'self' <destination>` (generated from `pde.config.json`), `script-src 'self' 'wasm-unsafe-eval'`, `frame-ancestors 'none'`, `form-action 'none'` and more. The browser blocks any other network target.
- **Attestation before sending.** `T3nClient.handshake()` verifies the node's Intel TDX quote and its RTMR measurements against an operator-signed trust manifest *before* trusting the node's ML-KEM key. If verification fails, `prepare()` throws and the Send button stays disabled. There is no "send anyway" path, and an `unsafe_trust_server` anchor is refused.
- **Memory hygiene:**
  - Decoded page pixels are zeroed after OCR. The worker zeroes its copies too.
  - Preview images are wiped after submit or on retake.
  - The file bytes are dropped after reading.
  - Nothing is written to IndexedDB or localStorage. The Cache API holds only app code and models.
- **No analytics, no telemetry, no third-party scripts.**

## Honest limits

- **The client is not trusted by the recipient.** A user (or malware on their device) can edit values. The submission therefore says how each value was obtained. Values with `validated: true` and `user_edited: false` come from deterministic checks: MRZ check digits, the IBAN checksum, payslip and statement arithmetic, or a cross-check against the printed page. Treat everything else as self-attested. For high assurance, the recipient contract should also re-run the deterministic checks.
- **Same-origin hosting matters.** Whoever serves the app could serve different code. That is why the code is open source, why `assets-index.json` and the build commit are shown, and why a reproducible build is the next step (see the roadmap in the README).
- **Accuracy is not perfect.** Every field not vouched for by a check is highlighted for the user to confirm. See `bench/` for measured accuracy.
- **Inside the enclave.** Plain text exists only inside the attested T3 enclave. What the recipient contract does with it is governed by T3's own controls (consent, delegation), not by this project.
