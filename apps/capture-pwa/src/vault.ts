import manifest from "../../../starter/vault/manifest.json";

/** The private maps the vault contract uses (created by "Set up my vault"). */
export const VAULT_MAPS: string[] = manifest.maps;

/**
 * Load the vault contract served next to this page and check it against the
 * SHA-256 built into the page (the starter kit's pinned manifest), so a
 * swapped file on the host can't be registered under the user's DID.
 */
export async function loadVaultContract(): Promise<{ wasm: Uint8Array; version: string }> {
  const res = await fetch(new URL(`./vault/${manifest.file}`, location.href), { credentials: "omit" });
  if (!res.ok) throw new Error(`could not load the vault contract (${res.status})`);
  const wasm = new Uint8Array(await res.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", wasm));
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== manifest.sha256) throw new Error("the vault contract file does not match its published SHA-256; not registering it");
  return { wasm, version: manifest.version };
}
