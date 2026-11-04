/**
 * Set which agent DIDs may call `status` / `evaluate` for any request,
 * without re-registering the contract (writes the contract's `config` map
 * through the tenant control plane).
 *
 *   T3N_API_KEY=0x… pnpm t3:agents -- did:t3n:<agent> [did:t3n:<agent2> …]
 *   T3N_API_KEY=0x… pnpm t3:agents -- --clear
 */
import { baseUrl, didHex, env, networkEnv, onFailure, readDeployment, sdk, signIn } from "./common.ts";

process.on("unhandledRejection", onFailure);
process.on("uncaughtException", onFailure);

const args = process.argv.slice(2).filter((a) => a !== "--");
const clear = args.includes("--clear");
const agents = args.filter((a) => a.startsWith("did:t3n:"));
if (!clear && !agents.length) {
  console.error("usage: pnpm t3:agents -- did:t3n:<agent> […]   |   pnpm t3:agents -- --clear");
  process.exit(2);
}

const e = networkEnv();
const url = baseUrl(e);
const dep = await readDeployment();
const { client, did } = await signIn(env("T3N_API_KEY"), e, url);
if (did !== dep.tenant_did) throw new Error(`signed in as ${did}, but the contract belongs to tenant ${dep.tenant_did}`);
const tenant = new sdk.TenantClient({ t3n: client, baseUrl: url, endpoint: url, tenantDid: did });
await tenant.executeControl("map-entry-set", {
  map_name: tenant.canonicalName("config"),
  key: "agents",
  value: JSON.stringify(clear ? [] : agents.map(didHex)),
});
console.log(clear ? "✓ agent list cleared" : `✓ ${agents.length} agent DID(s) may now read status / evaluate:\n  ${agents.join("\n  ")}`);
