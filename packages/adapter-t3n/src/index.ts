import { NoDeveloperAccountError, SignInError, type Destination, type DestinationInfo, type Submission, type SubmitReceipt } from "@pde/core";
import type * as T3n from "@terminal3/t3n-sdk";

type Sdk = typeof T3n;

/**
 * Where the reviewed fields go inside T3:
 * - `own-contract`: the signed-in user's own contract, `z:<their tid>:<tail>`
 *   — they registered it under their DID, so the data lands in their own
 *   private maps. The name is resolved after sign-in, so no link or config
 *   needs to know who the user is.
 * - `contract`: a fixed ADK contract (z:<tenant>:<name>), e.g. a business's.
 * - `user-profile`: identity basics go to the user's own Level-1 profile via
 *   `submitUserInput` (fields the contract does not accept come back refused).
 */
export type T3nTarget =
  | { kind: "own-contract"; tail: string; functionName: string }
  | { kind: "contract"; contractId: string; functionName: string; contractVersion?: string }
  | { kind: "user-profile"; mapProfile?: (s: Submission) => Record<string, unknown> };

/** The signed-in user has not registered the contract under their DID yet. */
export class VaultNotSetUpError extends Error {
  constructor(contractId: string, options?: ErrorOptions) {
    super(`there is no ${contractId} under your T3N account yet — set up your private vault first`, options);
    this.name = "VaultNotSetUpError";
  }
}

export interface T3nDestinationOptions {
  /** Node base URL, e.g. https://node.sandbox.t3n.example */
  baseUrl: string;
  /** Network whose operator-signed trust manifest pins the expected enclave measurements. */
  environment: "sandbox" | "testnet" | "production";
  target: T3nTarget;
  /**
   * Authenticate the end user on the (already attested and encrypted)
   * session — e.g. email OTP via `sdk.createEmailOtpAuthInput`. Return the
   * DID `client.authenticate` gives back, so the signed-in account is known
   * even when the client doesn't report it afterwards.
   */
  authenticate: (client: T3n.T3nClient, sdk: Sdk) => Promise<void | { value: string }>;
  /**
   * Guest-to-host handlers for the client, e.g. `{ EthSign: sdk.metamask_sign(address) }`
   * for wallet sign-in. Called once, before the client is created.
   */
  handlers?: (sdk: Sdk) => Promise<T3n.GuestToHostHandlers> | T3n.GuestToHostHandlers;
  /** Override for tests; defaults to `import("@terminal3/t3n-sdk")`. */
  loadSdk?: () => Promise<Sdk>;
  /**
   * For an `own-contract` target: the contract to register when the user has
   * no vault yet, and the private maps it uses. `load` must verify the file
   * (e.g. against a SHA-256 built into the page).
   */
  vault?: { maps: string[]; load: () => Promise<{ wasm: Uint8Array; version: string }> };
  /**
   * After sign-in, require a Terminal 3 developer account (an admitted,
   * active tenant, as created by the Agent Developer Kit sign-up). An email
   * that has only ever signed in here isn't one, so it can't hold a vault.
   */
  requireDeveloperAccount?: boolean;
}

/**
 * T3 destination built only on the published `@terminal3/t3n-sdk` — no T3
 * code changes. `handshake()` verifies the node's Intel TDX attestation
 * against an operator-signed trust manifest before trusting its ML-KEM key;
 * every RPC after that (including this submission) is encrypted to the
 * enclave. If verification fails, `prepare()` throws and nothing is sent.
 */
export class T3nDestination implements Destination {
  private readonly opts: T3nDestinationOptions;
  private client: T3n.T3nClient | null = null;
  private sdk: Sdk | null = null;
  /** DID from sign-in (or from a resumed session's handshake). */
  private signedInDid: string | null = null;

  constructor(opts: T3nDestinationOptions) {
    this.opts = opts;
  }

  describe(): DestinationInfo {
    const own = this.opts.target.kind === "own-contract";
    const did = this.did;
    return {
      kind: "T3 node",
      id: new URL(this.opts.baseUrl).host,
      label: own ? "Your own private vault on T3, inside the secure enclave" : "T3 secure enclave",
      // Shown once signed in, so the user can see whose vault this is.
      ...(did ? { account: did } : {}),
    };
  }

  /** DID of the signed-in session (after `prepare`). */
  get did(): string | null {
    return this.client?.getDid()?.value ?? this.signedInDid;
  }

  /** Where this destination sends traffic: the node, or a same-origin relay path to it. */
  origins(): string[] {
    return [this.opts.baseUrl.replace(/\/+$/, "")];
  }

  /** The authenticated client (after `prepare`), for follow-up calls such as `status`. */
  get session(): T3n.T3nClient | null {
    return this.client;
  }

  /**
   * `z:<tid>:<tail>` for the signed-in user, built by the SDK itself (the
   * same rule it uses when the user registers the contract).
   */
  ownContractId(tail: string): string {
    const client = this.client;
    const sdk = this.sdk;
    const did = this.did;
    if (!client || !sdk || !did) throw new Error("not signed in to T3");
    return new sdk.TenantClient({ t3n: client, baseUrl: this.opts.baseUrl, tenantDid: did }).canonicalName(tail);
  }

  /** Own-vault target only: is the contract missing under the signed-in DID? */
  async needsSetup(): Promise<boolean> {
    const target = this.opts.target;
    if (target.kind !== "own-contract") return false;
    const sdk = this.sdk;
    if (!sdk) throw new Error("destination not verified");
    const version = await sdk.getContractVersion(this.opts.baseUrl, this.ownContractId(target.tail)).catch(() => null);
    return !version;
  }

  /**
   * Set up the signed-in user's own vault: register the contract under their
   * DID, then create its private maps (readable and writable only by that
   * contract). Uses the user's own session, so the user's own credits.
   */
  async setUp(onStep?: (step: string) => void): Promise<void> {
    const target = this.opts.target;
    const vault = this.opts.vault;
    const client = this.client;
    const sdk = this.sdk;
    const did = this.did;
    if (target.kind !== "own-contract" || !vault) throw new Error("this destination has nothing to set up");
    if (!client || !sdk || !did) throw new Error("not signed in to T3");
    onStep?.("checking the vault contract");
    const { wasm, version } = await vault.load();
    const tenant = new sdk.TenantClient({ t3n: client, baseUrl: this.opts.baseUrl, tenantDid: did });
    onStep?.("registering your vault");
    const reg = await tenant.contracts.register({ tail: target.tail, version, wasm });
    const acl = { writers: { only: [reg.contract_id] }, readers: { only: [reg.contract_id] } };
    for (const tail of vault.maps) {
      onStep?.(`creating private storage (${tail})`);
      try {
        await tenant.maps.create({ tail, visibility: "private", ...acl });
      } catch (err) {
        // Left over from an earlier attempt: grant it to the new contract id.
        if (!/already.?exists/i.test(String((err as Error).message))) throw err;
        await tenant.maps.update(tail, acl);
      }
    }
    // T3N returns the numeric id only from register(). Keep it in the vault's own private config
    // map, so the owner can read it back later (the starter's setup-vault does) for add-on contracts
    // that need to be granted read access. Not fatal: the vault works without it.
    if (vault.maps.includes("config")) {
      onStep?.("recording your vault's id");
      await tenant.maps.entrySet("config", "contract_id", String(reg.contract_id)).catch((err: unknown) => {
        console.warn("[t3] couldn't record the vault's contract id:", (err as Error).message);
      });
    }
  }

  /** Throws NoDeveloperAccountError unless the signed-in DID is an active Terminal 3 developer account. */
  private async checkDeveloperAccount(): Promise<void> {
    const client = this.client;
    const sdk = this.sdk;
    const did = this.did;
    if (!client || !sdk || !did) throw new SignInError("not signed in to T3");
    let me: { status?: string } | null;
    try {
      me = (await new sdk.TenantClient({ t3n: client, baseUrl: this.opts.baseUrl, tenantDid: did }).tenant.me()) as { status?: string } | null;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/not.?found|not.?admitted|unknown tenant|not a tenant|no tenant|not registered/i.test(msg)) {
        this.client = null;
        throw new NoDeveloperAccountError("none", { cause: err });
      }
      // Any other failure says nothing about the account: don't block on it.
      console.warn("[t3] couldn't check the developer account:", msg);
      return;
    }
    if (!me) {
      this.client = null;
      throw new NoDeveloperAccountError("none");
    }
    if (me.status && me.status !== "active") {
      this.client = null;
      throw new NoDeveloperAccountError(me.status);
    }
  }

  async prepare(): Promise<void> {
    const sdk = (this.sdk ??= await (this.opts.loadSdk ?? (() => import("@terminal3/t3n-sdk")))());
    // Signed by the network operator, verified against a key pinned in the SDK.
    const trustAnchor = await sdk.fetchTrustedManifest(this.opts.environment, { baseUrl: this.opts.baseUrl });
    if (sdk.isUnsafeTrustServer(trustAnchor)) throw new Error("refusing an unverified trust anchor");
    const handlers = await this.opts.handlers?.(sdk);
    const client = new sdk.T3nClient({
      baseUrl: this.opts.baseUrl,
      trustAnchor,
      wasmComponent: await sdk.loadWasmComponent(),
      ...(handlers ? { handlers } : {}),
    });
    // Verifies the TDX quote + measurements before any key is trusted.
    const hs = await client.handshake();
    // A browser that still holds a t3_session cookie resumes that signed-in
    // session at handshake; the SDK then refuses a second sign-in ("Must
    // complete handshake before authentication"). Use the resumed session.
    this.signedInDid = hs.did?.value ?? null;
    try {
      if (!hs.authenticated && !client.isAuthenticated()) {
        const did = await this.opts.authenticate(client, sdk);
        if (did?.value) this.signedInDid = did.value;
      }
    } catch (err) {
      throw new SignInError((err as Error).message ?? String(err), { cause: err });
    }
    if (!client.isAuthenticated()) throw new SignInError("not signed in to T3");
    this.client = client;
    if (this.opts.requireDeveloperAccount) await this.checkDeveloperAccount();
  }

  async submit(submission: Submission): Promise<SubmitReceipt> {
    const client = this.client;
    const sdk = this.sdk;
    if (!client || !sdk) throw new Error("destination not verified");
    const target = this.opts.target;

    if (target.kind === "contract" || target.kind === "own-contract") {
      const contractId = target.kind === "contract" ? target.contractId : this.ownContractId(target.tail);
      let version: string;
      try {
        version = (target.kind === "contract" ? target.contractVersion : undefined) ?? (await sdk.getContractVersion(this.opts.baseUrl, contractId));
      } catch (err) {
        if (target.kind === "own-contract") throw new VaultNotSetUpError(contractId, { cause: err });
        throw err;
      }
      const out = await client.executeAndDecode<{ reference?: string; tx_hash?: string }>({
        contract_id: contractId,
        contract_version: version,
        function_name: target.functionName,
        input: submission,
      });
      return { reference: out?.reference ?? out?.tx_hash ?? submission.request_id ?? "sent" };
    }

    const profile = (target.mapProfile ?? identityProfile)(submission);
    const res = await client.submitUserInput({ profile });
    if (res.refusedFields?.length) throw new Error(`T3 refused: ${res.refusedFields.join(", ")}`);
    return { reference: submission.request_id ?? res.txHash ?? "sent" };
  }
}

/** Default Level-1 mapping: names and issuing country from a passport / ID card. */
export function identityProfile(s: Submission): Record<string, unknown> {
  const doc = s.documents.find((d) => d.doc_type === "passport" || d.doc_type === "id_card");
  if (!doc) throw new Error("user-profile target needs a passport or ID card; use a contract target for other documents");
  const v = (k: string) => doc.fields[k]?.value;
  const title = (x?: string) => x?.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return {
    ...(v("given_names") ? { first_name: title(v("given_names")) } : {}),
    ...(v("surname") ? { last_name: title(v("surname")) } : {}),
    ...(v("issuing_country") ? { document_issuance_country: v("issuing_country") } : {}),
  };
}
