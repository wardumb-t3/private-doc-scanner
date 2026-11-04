/**
 * Shared helpers for the T3 testnet scripts. Keys come from the environment
 * only and are never printed or written to disk.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as sdk from "@terminal3/t3n-sdk";

export type Env = "testnet" | "sandbox" | "production";

export interface Deployment {
  environment: Env;
  base_url: string;
  tenant_did: string;
  contract: string;
  contract_id: number;
  version: string;
  deployed_at: string;
}

export const DEPLOYMENT_FILE = new URL("./out/deployment.json", import.meta.url);

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing ${name}. See tools/t3/README.md.`);
    process.exit(2);
  }
  return v;
}

export function networkEnv(): Env {
  const e = (process.env.T3N_ENV ?? "testnet") as Env;
  if (!["testnet", "sandbox", "production"].includes(e)) throw new Error(`bad T3N_ENV ${e}`);
  return e;
}

/** Node URL, or your relay (e.g. https://capture.example.com/t3) to test it end to end. */
export function baseUrl(e: Env): string {
  return (process.env.T3N_BASE_URL ?? sdk.NODE_URLS[e]).replace(/\/+$/, "");
}

/**
 * Handshake (verifies the node's TDX attestation against the operator-signed
 * manifest) and sign in with an ETH key — the same identity as your API key.
 */
export async function signIn(privateKey: string, e: Env, url: string) {
  const trustAnchor = await sdk.fetchTrustedManifest(e, { baseUrl: url });
  const address = sdk.eth_get_address(privateKey);
  const client = new sdk.T3nClient({
    baseUrl: url,
    trustAnchor,
    wasmComponent: await sdk.loadWasmComponent(),
    handlers: { EthSign: sdk.metamask_sign(address, undefined, privateKey) },
  });
  await client.handshake();
  const did = await client.authenticate(sdk.createEthAuthInput(address));
  return { client, did: did.value, address };
}

export async function readDeployment(): Promise<Deployment> {
  try {
    return JSON.parse(await readFile(DEPLOYMENT_FILE, "utf8")) as Deployment;
  } catch {
    console.error("No tools/t3/out/deployment.json — run `pnpm t3:deploy` first.");
    process.exit(2);
  }
}

export async function writeDeployment(d: Deployment) {
  await mkdir(new URL("./out/", import.meta.url), { recursive: true });
  await writeFile(DEPLOYMENT_FILE, JSON.stringify(d, null, 2) + "\n");
}

/** did:t3n:<hex> → hex, the form tenant-context returns. */
export function didHex(did: string): string {
  return did.replace(/^did:t3n:/, "").toLowerCase();
}

export { sdk };

/** Print a one-line error (the SDK is minified; its stack traces are noise) and exit. */
export function onFailure(err: unknown): never {
  const e = err as { name?: string; message?: string; code?: string; cause?: { message?: string } };
  const cause = e.cause?.message ? ` (cause: ${e.cause.message})` : "";
  console.error(`\n✗ ${e.name ?? "Error"}${e.code ? ` [${e.code}]` : ""}: ${e.message ?? String(err)}${cause}`);
  process.exit(1);
}
