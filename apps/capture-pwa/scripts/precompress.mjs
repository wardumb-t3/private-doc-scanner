/**
 * Optional (PDE_PRECOMPRESS=1): write .br and .gz next to large static files
 * so a plain file server (Caddy `file_server { precompressed br gzip }`)
 * serves the 26 MB ONNX Runtime WASM as ~6 MB. Vercel compresses on its own,
 * so this is off by default.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

if (process.env.PDE_PRECOMPRESS !== "1") process.exit(0);

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const exts = /\.(wasm|onnx|js|mjs|json|txt|css|html|svg|bcmap|pfb|ttf)$/;
let count = 0;
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (exts.test(e.name) && (await stat(p)).size > 1024) {
      const data = await readFile(p);
      await writeFile(`${p}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }));
      await writeFile(`${p}.gz`, gzipSync(data, { level: 9 }));
      count++;
    }
  }
}
await walk(dist);
console.log(`precompressed ${count} files`);
