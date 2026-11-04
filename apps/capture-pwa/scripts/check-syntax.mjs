/**
 * Fail the build if any script we ship uses syntax the oldest supported
 * browser (Safari 15, see browser-target.mjs) cannot parse. Safari reports
 * that only as "SyntaxError: Unexpected token" and the page never starts.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

/** ES2022 syntax that Safari 15 lacks (class fields and private methods it has). */
const TOO_NEW = new Set(["StaticBlock"]);

function* walk(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) for (const c of v) yield* walk(c);
    else if (v && typeof v === "object" && typeof v.type === "string") yield* walk(v);
  }
}

const problems = [];
for (const f of await readdir(dist, { recursive: true })) {
  if (!/\.m?js$/.test(f) || f.endsWith("sw.js")) continue;
  const path = join(dist, f);
  const src = await readFile(path, "utf8");
  let ast;
  try {
    // Anything newer than ES2022 fails to parse here.
    ast = parse(src, { ecmaVersion: 2022, sourceType: "module", locations: true });
  } catch (err) {
    problems.push(`${relative(dist, path)}: ${err.message}`);
    continue;
  }
  for (const n of walk(ast)) {
    if (TOO_NEW.has(n.type)) {
      problems.push(`${relative(dist, path)}:${n.loc.start.line}:${n.loc.start.column}: ${n.type}`);
      break;
    }
  }
}
if (problems.length) {
  console.error(`Scripts that Safari 15 cannot parse:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("check-syntax: every shipped script parses in the oldest supported browser");
