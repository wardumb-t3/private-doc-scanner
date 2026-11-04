/**
 * Copy every runtime asset into public/ so the app is fully self-hosted
 * (no CDN at runtime) and write a manifest of SHA-256 digests that the app
 * verifies on load. Run before `vite dev` / `vite build`.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
// Engine deps are declared by @pde/engines-web; resolve them from there.
const req = createRequire(join(here, "..", "..", "..", "packages", "engines-web", "package.json"));
const pkgDir = (name, entry = "package.json") => dirname(req.resolve(`${name}/${entry}`));

async function copy(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

for (const d of ["models", "ort", "pdfjs", "tesseract", "vault"]) await rm(join(pub, d), { recursive: true, force: true });
await rm(join(pub, "assets-index.json"), { force: true });

// 0. The private-vault contract users register under their own DID from the
//    app ("Set up my vault"): the starter kit's pinned file. Its SHA-256 is
//    built into the page (src/vault.ts) and checked before registering.
await copy(join(here, "..", "..", "..", "starter", "vault", "doc-intake.wasm"), join(pub, "vault/doc-intake.wasm"));

// 1. PP-OCRv4 mobile det + rec (Apache-2.0 weights, via @gutenye/ocr-models).
const models = join(pkgDir("@gutenye/ocr-models", "node"), "assets");
await copy(join(models, "ch_PP-OCRv4_det_infer.onnx"), join(pub, "models/ppocr_det.onnx"));
await copy(join(models, "ch_PP-OCRv4_rec_infer.onnx"), join(pub, "models/ppocr_rec.onnx"));
await copy(join(models, "ppocr_keys_v1.txt"), join(pub, "models/ppocr_keys.txt"));

// 2. ONNX Runtime Web: its WASM binaries are emitted by Vite as hashed,
//    same-origin assets (dist/assets/ort-wasm-*.wasm) — nothing to copy.

// 3. pdf.js data (fonts, CMaps, JPX/JBIG2 decoders, ICC profiles).
const pdfjs = pkgDir("pdfjs-dist");
// The pdf.js worker itself is bundled by Vite (src/main.ts imports it with
// `?worker&url`), so it is compiled for the app's browser target too.
for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) await copy(join(pdfjs, d), join(pub, "pdfjs", d));

// 4. Tesseract (low-end tier): worker, LSTM cores, English "best_int" data.
const tjs = pkgDir("tesseract.js");
await copy(join(tjs, "dist/worker.min.js"), join(pub, "tesseract/worker.min.js"));
const tcore = dirname(createRequire(join(tjs, "package.json")).resolve("tesseract.js-core/package.json"));
for (const f of await readdir(tcore)) if (/-lstm\.wasm\.js$/.test(f)) await copy(join(tcore, f), join(pub, "tesseract/core", f));
const engData = join(pkgDir("@tesseract.js-data/eng"), "4.0.0_best_int", "eng.traineddata.gz");
await copy(engData, join(pub, "tesseract/lang/eng.traineddata.gz"));

// Hash-pinned manifest for files the app loads itself.
const assets = {};
for (const [name, file] of [
  ["ppocr_det", "models/ppocr_det.onnx"],
  ["ppocr_rec", "models/ppocr_rec.onnx"],
  ["ppocr_dict", "models/ppocr_keys.txt"],
  ["tesseract_eng", "tesseract/lang/eng.traineddata.gz"],
]) {
  const path = join(pub, file);
  assets[name] = { url: file, sha256: await sha256(path), bytes: (await stat(path)).size };
}
await writeFile(join(pub, "models/manifest.json"), JSON.stringify({ version: "ppocrv4-1", assets }, null, 2));

console.log("prepared models, pdf.js data and tesseract assets");
