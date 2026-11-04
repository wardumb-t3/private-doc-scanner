/**
 * Register the doc-intake contract on T3 testnet and create its maps.
 *
 *   T3N_API_KEY=0x… pnpm t3:deploy
 *   T3N_API_KEY=0x… AGENT_DIDS=did:t3n:… pnpm t3:deploy   # agents allowed to read status / evaluate
 *
 * Re-running registers a new version (bump contracts/doc-intake/Cargo.toml)
 * and re-grants both maps to the new contract id.
 */
import { readFile } from "node:fs/promises";
import { baseUrl, didHex, env, networkEnv, sdk, signIn, writeDeployment, onFailure } from "./common.ts";

process.on("unhandledRejection", onFailure);
process.on("uncaughtException", onFailure);

const TAIL = "doc-intake";
const WASM = new URL("../../contracts/doc-intake/target/wasm32-wasip2/release/z_doc_intake.wasm", import.meta.url);
const CARGO = new URL("../../contracts/doc-intake/Cargo.toml", import.meta.url);

const e = networkEnv();
const url = baseUrl(e);
const key = env("T3N_API_KEY");

const version = process.env.CONTRACT_VERSION ?? (await readFile(CARGO, "utf8")).match(/^version\s*=\s*"([^"]+)"/m)![1]!;
let wasm: Buffer;
try {
  wasm = await readFile(WASM);
} catch {
  console.error("Contract not built. Run: (cd contracts/doc-intake && cargo build --target wasm32-wasip2 --release)");
  process.exit(2);
}
if (wasm.length > 1024 * 1024) throw new Error(`contract is ${wasm.length} bytes; tenant limit is 1 MiB`);

console.log(`→ ${e} via ${url}`);
const { client, did } = await signIn(key, e, url);
console.log(`✓ attested handshake, signed in as ${did}`);

const tenant = new sdk.TenantClient({ t3n: client, baseUrl: url, endpoint: url, tenantDid: did });
const me = (await tenant.tenant.me()) as { tenant: string; status: string };
console.log(`✓ tenant ${me.tenant} (${me.status})`);

const reg = await tenant.contracts.register({ tail: TAIL, version, wasm });
console.log(`✓ registered ${reg.name} v${version} as contract id ${reg.contract_id}`);

const acl = { writers: { only: [reg.contract_id] }, readers: { only: [reg.contract_id] } };
for (const tail of ["intake", "config"]) {
  try {
    await tenant.maps.create({ tail, visibility: "private", ...acl });
    console.log(`✓ created map ${tenant.canonicalName(tail)}`);
  } catch (err) {
    if (!/already.?exists/i.test(String((err as Error).message))) throw err;
    await tenant.maps.update(tail, acl);
    console.log(`✓ map ${tenant.canonicalName(tail)} exists — re-granted to contract id ${reg.contract_id}`);
  }
}

const agents = (process.env.AGENT_DIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (agents.length) {
  await tenant.executeControl("map-entry-set", {
    map_name: tenant.canonicalName("config"),
    key: "agents",
    value: JSON.stringify(agents.map(didHex)),
  });
  console.log(`✓ ${agents.length} agent DID(s) may read status / evaluate`);
}

await writeDeployment({
  environment: e,
  base_url: url,
  tenant_did: did,
  contract: reg.name,
  contract_id: reg.contract_id,
  version,
  deployed_at: new Date().toISOString(),
});

console.log(`
Done. Next:
  pnpm t3:smoke                 # round trip against the node
  pnpm t3:config                # prints PDE_CONFIG_JSON for Vercel (relay at /t3)
  pnpm t3:config -- <domain>    # or: config for a VPS / Caddy deployment
`);
