/**
 * Set up your private vault, under YOUR DID: register the doc-intake contract
 * as z:<your tid>:doc-intake and create its private maps (`intake`, `config`),
 * readable and writable only by that contract. Safe to run again.
 *
 *   npx tsx scripts/setup-vault.ts
 *
 * Cost on testnet: about 1,000 credits to register + 50 per map, from your account.
 */
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { fail, NODE_URL, onFailure, sdk, signIn } from "./t3n.ts";

process.on("unhandledRejection", onFailure);
process.on("uncaughtException", onFailure);

const manifest = JSON.parse(await readFile(new URL("../vault/manifest.json", import.meta.url), "utf8")) as {
  tail: string;
  version: string;
  file: string;
  sha256: string;
  maps: string[];
};
const wasm = await readFile(new URL(`../vault/${manifest.file}`, import.meta.url));
const digest = createHash("sha256").update(wasm).digest("hex");
if (digest !== manifest.sha256) fail(`vault/${manifest.file} does not match its pinned SHA-256 (${digest}); refusing to register it.`);
console.log(`✓ contract file verified (sha256 ${digest.slice(0, 16)}…)`);

const { did, tenant } = await signIn();
console.log(`✓ attested handshake with ${new URL(NODE_URL).host}, signed in as ${did}`);
const me = (await tenant.tenant.me()) as { status?: string };
console.log(`✓ tenant account ${me.status ?? "ok"}`);

const name = tenant.canonicalName(manifest.tail);
const registered = await sdk.getContractVersion(NODE_URL, name).catch(() => null);
const mapsPresent = async () => {
  for (const tail of manifest.maps) if ((await tenant.maps.getStatus(tail).catch(() => "absent")) === "absent") return false;
  return true;
};

/**
 * T3N returns a contract's numeric id only from register(). Follow-up contracts (e.g. the trip
 * booker) need it to grant themselves read access to `intake`, so it's kept in two places:
 * vault/doc-intake.local.json here (git-ignored: it names the user's DID), and the vault's own
 * private `config` map, where only the vault's owner can read it back (covers vaults set up from
 * the scanner app).
 */
const ID_FILE = new URL("../vault/doc-intake.local.json", import.meta.url);
const ID_KEY = "contract_id";
const writeIdFile = (contractId: number) =>
  writeFile(ID_FILE, JSON.stringify({ name, version: manifest.version, contract_id: contractId }, null, 2) + "\n");

if (registered === manifest.version && (await mapsPresent())) {
  console.log(`✓ already set up: ${name} v${registered} with maps ${manifest.maps.join(", ")}`);
  const haveFile = await access(ID_FILE).then(() => true, () => false);
  if (!haveFile) {
    const stored = await tenant.maps.entryGet("config", ID_KEY).catch(() => null);
    const id = stored ? Number(stored) : NaN;
    if (Number.isInteger(id)) {
      await writeIdFile(id);
      console.log(`✓ recovered the vault's contract id (${id}) into vault/doc-intake.local.json`);
    } else {
      console.log(
        "! this vault's contract id wasn't recorded (it was set up before ids were kept). For add-on contracts, bump" +
          ' "version" in vault/manifest.json and re-run this script: it re-registers the same contract and keeps your data.',
      );
    }
  }
} else {
  const reg = await tenant.contracts.register({ tail: manifest.tail, version: manifest.version, wasm });
  console.log(`✓ registered ${reg.name} v${manifest.version} (contract id ${reg.contract_id})`);
  // Private maps: only this contract may read or write them.
  const acl = { writers: { only: [reg.contract_id] }, readers: { only: [reg.contract_id] } };
  for (const tail of manifest.maps) {
    try {
      await tenant.maps.create({ tail, visibility: "private", ...acl });
      console.log(`✓ created private map ${tenant.canonicalName(tail)}`);
    } catch (err) {
      if (!/already.?exists/i.test(String((err as Error).message))) throw err;
      await tenant.maps.update(tail, acl);
      console.log(`✓ map ${tenant.canonicalName(tail)} exists, granted to contract id ${reg.contract_id}`);
    }
  }
  await writeIdFile(reg.contract_id);
  await tenant.maps.entrySet("config", ID_KEY, String(reg.contract_id)).catch((err: unknown) => {
    console.log(`! couldn't keep the contract id in the vault's config map (${(err as Error).message}); the local file has it`);
  });
  console.log(`✓ recorded the contract id (${reg.contract_id}) in vault/doc-intake.local.json`);
}

console.log(`\nYour private vault is ready: ${name}`);
console.log("Documents you seal from the capture page (signed in with this account's email) are stored there.");
