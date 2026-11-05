/**
 * Sign in to T3N testnet as the developer. The key comes from the
 * environment (T3N_API_KEY) only; it is never printed or written to disk.
 */
import { readFileSync } from "node:fs";
import * as sdk from "@terminal3/t3n-sdk";

export { sdk };

export const ENV = "testnet" as const;
export const SIGN_UP_URL = "https://terminal3.io/products/agent-developer-kit";
export const NODE_URL = (process.env.T3N_BASE_URL ?? sdk.NODE_URLS[ENV]).replace(/\/+$/, "");

/** starter/.env (git-ignored), for running on your own computer. */
const ENV_FILE = new URL("../.env", import.meta.url);

export function apiKey(): string {
  if (!process.env.T3N_API_KEY) {
    try {
      process.loadEnvFile(ENV_FILE);
    } catch {
      // No .env: the key may come from the environment settings instead.
    }
  }
  const key = process.env.T3N_API_KEY?.trim();
  if (!key) {
    fail(
      "No T3N API key found. Get one by signing up at " + SIGN_UP_URL + " (it's shown once), then either " +
        "put it in starter/.env as T3N_API_KEY=… (on your own computer; copy starter/.env.example) or add " +
        "T3N_API_KEY in your cloud environment's secret settings. Never paste the key into the chat." +
        resumeHint(),
    );
  }
  return key;
}

/** Attested handshake (TDX quote vs the operator-signed manifest), then sign in with the key. */
export async function signIn() {
  const key = apiKey();
  const trustAnchor = await sdk.fetchTrustedManifest(ENV, { baseUrl: NODE_URL });
  const address = sdk.eth_get_address(key);
  const client = new sdk.T3nClient({
    baseUrl: NODE_URL,
    trustAnchor,
    wasmComponent: await sdk.loadWasmComponent(),
    handlers: { EthSign: sdk.metamask_sign(address, undefined, key) },
  });
  await client.handshake();
  const did = (await client.authenticate(sdk.createEthAuthInput(address))).value;
  const tenant = new sdk.TenantClient({ t3n: client, baseUrl: NODE_URL, endpoint: NODE_URL, tenantDid: did });
  return { client, did, tenant };
}

/**
 * For errors the user fixes in their environment's settings and then a new session: the prompt
 * that session needs, since it starts with no memory of this one.
 */
function resumeHint(): string {
  try {
    const prompt = readFileSync(new URL("../prompts/continue.txt", import.meta.url), "utf8").trim();
    return `\n\nAfter fixing this, if you start a new session, paste this prompt into it:\n\n${prompt}\n`;
  } catch {
    return "";
  }
}

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Show the SDK's message (never a stack with environment details). */
export function onFailure(err: unknown): never {
  const msg = (err as Error)?.message ?? String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|403/i.test(msg)) {
    fail(`could not reach ${NODE_URL} (${msg}). Allow that host in the environment's network settings.${resumeHint()}`);
  }
  if (/insufficient.?credit/i.test(msg)) fail(`not enough test credits on this account (${msg}). Top up on the claim page.`);
  fail(msg);
}
