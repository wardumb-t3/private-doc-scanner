# Contributing

Thanks for helping keep sensitive documents out of AI context windows.

## Setup

```sh
pnpm install
pnpm test          # unit + integration (real OCR models, synthetic documents)
pnpm typecheck
pnpm lint
pnpm build         # builds the capture PWA into apps/capture-pwa/dist
pnpm test:e2e      # Playwright against the production build
pnpm bench         # accuracy on synthetic documents → bench/out/report.md
```

## Ground rules

1. **No document data leaves the device.** Any change that adds a network request, a dependency loaded from a CDN, analytics, or persistence of document pixels or text will be rejected. The e2e tests assert this.
2. **"Validated" must mean something.** A field may only be marked validated by a deterministic check: a check digit, a checksum, arithmetic, or two independent readings agreeing. `pnpm bench` fails if any validated field is wrong.
3. **Don't guess.** When a value is ambiguous (for example `03/04/2025` with no other dates on the page), return `null` or flag the field for review rather than picking an answer.
4. **No real documents in the repo.** Tests and benchmarks use `bench/synth.ts`. Please don't attach real IDs to issues either.
5. **Licences:** permissive only (Apache-2.0, MIT, BSD). No AGPL or GPL code, and no model weights with non-commercial terms.

## Layout

- `packages/validators`: check digits, IBAN, amounts, dates, arithmetic, MRZ
- `packages/core`: pipeline, schemas, review logic, the submission payload
- `packages/engines-web`: pdf.js, PP-OCR / Tesseract engines, browser and Node platforms
- `packages/ui`: Lit web components (`<pde-flow>` and friends)
- `packages/adapter-t3n`, `packages/adapter-hpke`: where sealed data goes
- `apps/capture-pwa`: reference deployment
- `bench`: synthetic documents and the accuracy benchmark
