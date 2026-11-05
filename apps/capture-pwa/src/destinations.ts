import { HpkeDestination, hpkeSuite } from "@pde/adapter-hpke";
import { NoDeveloperAccountError, type Destination, type Submission } from "@pde/core";
import type { T3nTarget } from "@pde/adapter-t3n";
import { askEmail, askOtpCode, chooseSignIn, type SignInMethod } from "./otp-dialog.ts";
import { loadVaultContract, VAULT_MAPS } from "./vault.ts";

export type DestinationConfig =
  /**
   * Demo / tests, nothing is sent. `simulateVaultSetup`: show the "Set up my
   * vault" step once. `simulateNoDeveloperAccount`: the first sign-in isn't a
   * developer account (as for an email that never signed up).
   */
  | { type: "dry-run"; simulateVaultSetup?: boolean; simulateNoDeveloperAccount?: boolean; showAssistantPrompt?: boolean }
  | { type: "hpke"; endpoint: string; recipientPublicKey: string; keyId: string; label?: string }
  | {
      type: "t3n";
      /** The node URL, or a same-origin relay path such as https://capture.example.com/t3 */
      baseUrl: string;
      environment: "sandbox" | "testnet" | "production";
      target: T3nTarget;
      /** Sign-in options offered to the user (default: email only). */
      signIn?: SignInMethod[];
    };

/**
 * Demo destination: seals the submission with HPKE to a throw-away key and
 * sends nothing. Lets business owners try the flow end to end.
 */
class DryRunDestination implements Destination {
  private vaultMissing: boolean;
  private noAccount: boolean;
  constructor(cfg: { simulateVaultSetup?: boolean; simulateNoDeveloperAccount?: boolean }) {
    this.vaultMissing = cfg.simulateVaultSetup === true;
    this.noAccount = cfg.simulateNoDeveloperAccount === true;
  }
  async needsSetup() {
    return this.vaultMissing;
  }
  async setUp(onStep?: (step: string) => void) {
    onStep?.("registering your vault (demo)");
    this.vaultMissing = false;
  }
  describe() {
    return { kind: "a throw-away key (demo)", id: "", label: "Demo mode: the sealed data is discarded on this device and nothing is sent." };
  }
  origins() {
    return [];
  }
  async prepare() {
    if (this.noAccount) {
      this.noAccount = false;
      throw new NoDeveloperAccountError("none");
    }
  }
  async submit(submission: Submission) {
    const suite = hpkeSuite();
    const kp = await suite.kem.generateKeyPair();
    const sender = await suite.createSenderContext({ recipientPublicKey: kp.publicKey });
    await sender.seal(new TextEncoder().encode(JSON.stringify(submission)).buffer);
    return { reference: `dry-run-${crypto.randomUUID().slice(0, 8)}` };
  }
}

/** Defers loading the T3 SDK (and its WASM) until the user reaches "Seal and send". */
class LazyT3nDestination implements Destination {
  private readonly cfg: Extract<DestinationConfig, { type: "t3n" }>;
  private inner: Destination | null = null;
  constructor(cfg: Extract<DestinationConfig, { type: "t3n" }>) {
    this.cfg = cfg;
  }
  describe() {
    if (this.inner) return this.inner.describe();
    const own = this.cfg.target.kind === "own-contract";
    return { kind: "T3 node", id: new URL(this.cfg.baseUrl).host, label: own ? "Your own private vault on T3, inside the secure enclave" : "T3 secure enclave" };
  }
  origins() {
    return [this.cfg.baseUrl.replace(/\/+$/, "")];
  }
  private pending: Promise<void> | null = null;

  /** One handshake + sign-in at a time: the SDK's WASM session is shared. */
  prepare(): Promise<void> {
    this.pending ??= this.doPrepare().finally(() => (this.pending = null));
    return this.pending;
  }

  private async doPrepare() {
    this.inner = null;
    await clearT3Session();
    const { T3nDestination } = await import("@pde/adapter-t3n");
    // The node's attestation is verified (handshake) before the user is asked
    // to sign in; the wallet signer is resolved lazily during authenticate.
    let address: string | null = null;
    const dest = new T3nDestination({
      baseUrl: this.cfg.baseUrl,
      environment: this.cfg.environment,
      target: this.cfg.target,
      vault: { maps: VAULT_MAPS, load: loadVaultContract },
      // A vault needs a real Terminal 3 developer account, not just an email that signed in here.
      requireDeveloperAccount: this.cfg.target.kind === "own-contract",
      handlers: (sdk) => ({
        EthSign: ((...args: unknown[]) => {
          if (!address) throw new Error("wallet not connected");
          return (sdk.metamask_sign(address) as (...a: unknown[]) => unknown)(...args);
        }) as never,
      }),
      authenticate: async (client, sdk) => {
        const method = await chooseSignIn(this.cfg.signIn ?? ["email"], hasWallet());
        if (method === "wallet") {
          // Same identity (and credits) as your ETH key / API key; the key
          // stays in the wallet and never touches this page.
          address = await walletAddress();
          return client.authenticate(sdk.createEthAuthInput(address));
        }
        const email = await askEmail();
        return client.authenticate(sdk.createEmailOtpAuthInput({ email, getOtpCode: askOtpCode }));
      },
    });
    await dest.prepare();
    this.inner = dest;
  }
  submit(s: Submission) {
    if (!this.inner) throw new Error("destination not verified");
    return this.inner.submit(s);
  }
  async needsSetup() {
    return (await this.inner?.needsSetup?.()) ?? false;
  }
  setUp(onStep?: (step: string) => void) {
    if (!this.inner?.setUp) throw new Error("destination not verified");
    return this.inner.setUp(onStep);
  }
}

export function createDestination(cfg: DestinationConfig): Destination {
  // A relative baseUrl ("/t3") means "the relay on whatever origin serves this
  // page" — one config works on Vercel previews, *.vercel.app and custom domains.
  if (cfg.type === "t3n") cfg = { ...cfg, baseUrl: new URL(cfg.baseUrl, location.href).href.replace(/\/+$/, "") };
  switch (cfg.type) {
    case "dry-run":
      return new DryRunDestination(cfg);
    case "hpke":
      return new HpkeDestination(cfg);
    case "t3n":
      return new LazyT3nDestination(cfg);
  }
}

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function hasWallet(): boolean {
  return typeof (globalThis as { ethereum?: unknown }).ethereum === "object";
}

async function walletAddress(): Promise<string> {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error("no browser wallet found");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const first = accounts[0];
  if (!first) throw new Error("the wallet did not share an account");
  return first.toLowerCase();
}

/**
 * Expire the T3 session cookie (HttpOnly, so only the server can) before a
 * seal. Every submission then needs a fresh sign-in: nobody can silently
 * submit under the previous user's account on a shared device, and the SDK
 * is never handed a half-resumed session. Served by the host
 * (`api/pde-signout.js` on Vercel, the Caddyfile, the Vite dev server); if a
 * host lacks it, the adapter still copes with a resumed session.
 */
async function clearT3Session(): Promise<void> {
  try {
    await fetch(new URL("./pde-signout", location.href), { method: "POST", credentials: "include", cache: "no-store" });
  } catch {
    // Offline or not provided by this host: fine.
  }
}
