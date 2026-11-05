import type { Submission } from "@pde/core";
import { describe, expect, it, vi } from "vitest";
import { identityProfile, T3nDestination } from "../src/index.ts";

const submission: Submission = {
  schema: "pde.submission/v1",
  request_id: "req_9",
  documents: [
    {
      doc_type: "passport",
      fields: {
        surname: { value: "DE VRIES", source: "mrz", validated: true, validated_by: [], user_edited: false },
        given_names: { value: "SANNE", source: "mrz", validated: true, validated_by: [], user_edited: false },
        issuing_country: { value: "NLD", source: "mrz", validated: true, validated_by: [], user_edited: false },
      },
      checks: [],
    },
  ],
  client: { name: "t", version: "0", engine: "test" },
  created_at: "2025-01-01T00:00:00.000Z",
};

function fakeSdk(
  opts: { handshakeFails?: boolean; unsafe?: boolean; resumed?: boolean; noContract?: boolean; existingMaps?: string[]; tenantMe?: () => Promise<unknown> } = {},
) {
  const calls: Record<string, unknown[]> = {};
  const record = (k: string, v: unknown) => ((calls[k] ??= []).push(v), v);
  class T3nClient {
    authed = false;
    constructor(cfg: unknown) {
      record("config", cfg);
    }
    async handshake() {
      if (opts.handshakeFails) throw new Error("attestation verification failed");
      record("handshake", true);
      if (opts.resumed) this.authed = true;
      return { authenticated: !!opts.resumed, sessionId: { value: "s" }, expiry: 0 };
    }
    getDid() {
      return this.authed ? { value: "did:t3n:abc" } : null;
    }
    isAuthenticated() {
      return this.authed;
    }
    async executeAndDecode(payload: unknown) {
      record("execute", payload);
      return { reference: "t3-ref-1" };
    }
    async submitUserInput(input: unknown) {
      record("profile", input);
      return { txHash: "0xabc" };
    }
  }
  // Mirrors the SDK's own naming: z:<tenant id>:<tail>.
  class TenantClient {
    tenantDid: string;
    constructor(cfg: { tenantDid: string }) {
      this.tenantDid = cfg.tenantDid;
      record("tenantClient", cfg.tenantDid);
    }
    canonicalName(tail: string) {
      return `z:${this.tenantDid.replace(/^did:t3n:/, "")}:${tail}`;
    }
    contracts = {
      register: async (input: { tail: string; version: string; wasm: Uint8Array }) => {
        record("register", { tail: input.tail, version: input.version, bytes: input.wasm.length });
        return { name: this.canonicalName(input.tail), contract_id: 77 };
      },
    };
    tenant = { me: async () => (opts.tenantMe ? opts.tenantMe() : { status: "active" }) };
    maps = {
      create: async (input: { tail: string }) => {
        if (opts.existingMaps?.includes(input.tail)) throw new Error("MapAlreadyExists");
        record("mapCreate", input);
      },
      update: async (tail: string, patch: unknown) => record("mapUpdate", { tail, patch }),
      entrySet: async (tail: string, key: string, value: string) => record("entrySet", { tail, key, value }),
    };
  }
  const sdk = {
    T3nClient,
    TenantClient,
    fetchTrustedManifest: vi.fn(async () => (opts.unsafe ? { unsafe_trust_server: true } : { expected_peer_ids: ["p"], rtmr1_allowlist: [], rtmr3_allowlist: [] })),
    isUnsafeTrustServer: (a: { unsafe_trust_server?: boolean }) => a.unsafe_trust_server === true,
    loadWasmComponent: vi.fn(async () => ({})),
    getContractVersion: vi.fn(async () => {
      if (opts.noContract) throw new Error("contract not found");
      return "1.2.0";
    }),
  };
  return { sdk: sdk as never, calls };
}

const auth = async (client: { authed: boolean }) => {
  client.authed = true;
};

describe("T3 destination", () => {
  it("verifies, authenticates and executes the tenant contract with the submission", async () => {
    const { sdk, calls } = fakeSdk();
    const dest = new T3nDestination({
      baseUrl: "https://node.example",
      environment: "sandbox",
      target: { kind: "contract", contractId: "z:abc:docs", functionName: "ingest" },
      authenticate: auth as never,
      loadSdk: async () => sdk,
    });
    expect(dest.origins()).toEqual(["https://node.example"]);
    expect(new T3nDestination({ baseUrl: "https://app.example/t3/", environment: "testnet", target: { kind: "user-profile" }, authenticate: auth as never }).origins()).toEqual(["https://app.example/t3"]);
    await dest.prepare();
    expect(calls.handshake).toHaveLength(1);
    const receipt = await dest.submit(submission);
    expect(receipt.reference).toBe("t3-ref-1");
    expect(calls.execute![0]).toEqual({ contract_id: "z:abc:docs", contract_version: "1.2.0", function_name: "ingest", input: submission });
  });

  it("maps identity fields to the Level-1 profile", async () => {
    const { sdk, calls } = fakeSdk();
    const dest = new T3nDestination({
      baseUrl: "https://node.example",
      environment: "sandbox",
      target: { kind: "user-profile" },
      authenticate: auth as never,
      loadSdk: async () => sdk,
    });
    await dest.prepare();
    await dest.submit(submission);
    expect(calls.profile![0]).toEqual({ profile: { first_name: "Sanne", last_name: "De Vries", document_issuance_country: "NLD" } });
    expect(identityProfile(submission)).toMatchObject({ last_name: "De Vries" });
  });

  it("uses a session the node resumed at handshake instead of signing in again", async () => {
    const { sdk } = fakeSdk({ resumed: true });
    const authenticate = vi.fn(async () => {
      throw new Error("Must complete handshake before authentication");
    });
    const dest = new T3nDestination({
      baseUrl: "https://node.example",
      environment: "testnet",
      target: { kind: "contract", contractId: "z:abc:docs", functionName: "ingest" },
      authenticate,
      loadSdk: async () => sdk,
    });
    await dest.prepare();
    expect(authenticate).not.toHaveBeenCalled();
    expect(dest.did).toBe("did:t3n:abc");
  });

  it("reports a failed sign-in as SignInError (retryable), not a failed verification", async () => {
    const { sdk } = fakeSdk();
    const dest = new T3nDestination({
      baseUrl: "https://node.example",
      environment: "testnet",
      target: { kind: "contract", contractId: "z:abc:docs", functionName: "ingest" },
      authenticate: async () => {
        throw new Error("RPC Error: OTP code does not match");
      },
      loadSdk: async () => sdk,
    });
    await expect(dest.prepare()).rejects.toMatchObject({ name: "SignInError", message: "RPC Error: OTP code does not match" });
  });

  it("never sends when attestation fails or the trust anchor is unsafe", async () => {
    for (const o of [{ handshakeFails: true }, { unsafe: true }]) {
      const { sdk, calls } = fakeSdk(o);
      const dest = new T3nDestination({
        baseUrl: "https://node.example",
        environment: "sandbox",
        target: { kind: "contract", contractId: "z:abc:docs", functionName: "ingest" },
        authenticate: auth as never,
        loadSdk: async () => sdk,
      });
      await expect(dest.prepare()).rejects.toThrow();
      await expect(dest.submit(submission)).rejects.toThrow("not verified");
      expect(calls.execute).toBeUndefined();
    }
  });
});

describe("T3 destination: the signed-in user's own vault", () => {
  const own = (sdk: never) =>
    new T3nDestination({
      baseUrl: "https://node.example",
      environment: "testnet",
      target: { kind: "own-contract", tail: "doc-intake", functionName: "ingest" },
      authenticate: auth as never,
      loadSdk: async () => sdk,
    });

  it("seals to z:<signed-in tid>:doc-intake, named by the SDK", async () => {
    const { sdk, calls } = fakeSdk();
    const dest = own(sdk);
    expect(dest.describe().account).toBeUndefined();
    await dest.prepare();
    expect(dest.describe().account).toBe("did:t3n:abc");
    await dest.submit(submission);
    expect(calls.tenantClient).toEqual(["did:t3n:abc"]);
    expect(calls.execute).toEqual([{ contract_id: "z:abc:doc-intake", contract_version: "1.2.0", function_name: "ingest", input: submission }]);
  });

  it("says the vault is not set up (and sends nothing) when the user has no such contract", async () => {
    const { sdk, calls } = fakeSdk({ noContract: true });
    const dest = own(sdk);
    await dest.prepare();
    await expect(dest.submit(submission)).rejects.toMatchObject({ name: "VaultNotSetUpError", message: expect.stringContaining("z:abc:doc-intake") });
    expect(calls.execute).toBeUndefined();
  });

  const withVault = (sdk: never) =>
    new T3nDestination({
      baseUrl: "https://node.example",
      environment: "testnet",
      target: { kind: "own-contract", tail: "doc-intake", functionName: "ingest" },
      vault: { maps: ["intake", "config"], load: async () => ({ wasm: new Uint8Array(1234), version: "0.1.0" }) },
      authenticate: auth as never,
      loadSdk: async () => sdk,
    });

  it("reports a missing vault, then sets it up under the signed-in DID with private maps", async () => {
    const { sdk, calls } = fakeSdk({ noContract: true });
    const dest = withVault(sdk);
    await dest.prepare();
    expect(await dest.needsSetup()).toBe(true);
    const steps: string[] = [];
    await dest.setUp((s) => steps.push(s));
    expect(calls.register).toEqual([{ tail: "doc-intake", version: "0.1.0", bytes: 1234 }]);
    const acl = { writers: { only: [77] }, readers: { only: [77] } };
    expect(calls.mapCreate).toEqual([
      { tail: "intake", visibility: "private", ...acl },
      { tail: "config", visibility: "private", ...acl },
    ]);
    expect(steps).toContain("registering your vault");
    // The id is kept in the vault's own config map, so the owner can read it back for add-on contracts.
    expect(calls.entrySet).toEqual([{ tail: "config", key: "contract_id", value: "77" }]);
  });

  it("re-grants a map left over from an earlier attempt to the new contract", async () => {
    const { sdk, calls } = fakeSdk({ noContract: true, existingMaps: ["intake"] });
    const dest = withVault(sdk);
    await dest.prepare();
    await dest.setUp();
    expect(calls.mapUpdate).toEqual([{ tail: "intake", patch: { writers: { only: [77] }, readers: { only: [77] } } }]);
    expect(calls.mapCreate).toHaveLength(1);
  });

  it("needs no setup when the vault exists, or for a fixed contract", async () => {
    const { sdk } = fakeSdk();
    const dest = withVault(sdk);
    await dest.prepare();
    expect(await dest.needsSetup()).toBe(false);
    const fixed = new T3nDestination({
      baseUrl: "https://node.example",
      environment: "testnet",
      target: { kind: "contract", contractId: "z:abc:docs", functionName: "ingest" },
      authenticate: auth as never,
      loadSdk: async () => fakeSdk({ noContract: true }).sdk,
    });
    await fixed.prepare();
    expect(await fixed.needsSetup()).toBe(false);
  });

  it("shows the full DID, so the user can check exactly which account it is", async () => {
    const { sdk } = fakeSdk();
    const d = own(sdk);
    await d.prepare();
    expect(d.describe().account).toBe("did:t3n:abc");
  });
});

describe("T3 destination: knowing who signed in", () => {
  it("uses the DID sign-in returns when the client doesn't report one (as after an email sign-in)", async () => {
    const { sdk, calls } = fakeSdk();
    // A client whose getDid() stays empty after authenticating.
    const Base = (sdk as { T3nClient: new (c: unknown) => { getDid(): unknown } }).T3nClient;
    (sdk as { T3nClient: unknown }).T3nClient = class extends Base {
      override getDid() {
        return null;
      }
    };
    const dest = new T3nDestination({
      baseUrl: "https://node.example",
      environment: "testnet",
      target: { kind: "own-contract", tail: "doc-intake", functionName: "ingest" },
      authenticate: (async (client: { authed: boolean }) => {
        client.authed = true;
        return { value: "did:t3n:fromsignin" };
      }) as never,
      loadSdk: async () => sdk,
    });
    await dest.prepare();
    expect(dest.describe().account).toBe("did:t3n:fromsignin");
    await dest.submit(submission);
    expect((calls.execute as { contract_id: string }[])[0]!.contract_id).toBe("z:fromsignin:doc-intake");
  });
});

describe("T3 destination: a Terminal 3 developer account is required for a vault", () => {
  const dest = (tenantMe: () => Promise<unknown>) =>
    new T3nDestination({
      baseUrl: "https://node.example",
      environment: "testnet",
      target: { kind: "own-contract", tail: "doc-intake", functionName: "ingest" },
      requireDeveloperAccount: true,
      authenticate: auth as never,
      loadSdk: async () => fakeSdk({ tenantMe }).sdk,
    });

  it("refuses an email that isn't a developer account, before anything is set up or sent", async () => {
    const d = dest(async () => {
      throw new Error("tenant not found");
    });
    await expect(d.prepare()).rejects.toMatchObject({ name: "NoDeveloperAccountError", status: "none" });
    await expect(d.submit(submission)).rejects.toThrow("destination not verified");
  });

  it("refuses an account that isn't active yet", async () => {
    await expect(dest(async () => ({ status: "pending" })).prepare()).rejects.toMatchObject({ name: "NoDeveloperAccountError", status: "pending" });
  });

  it("accepts an active developer account", async () => {
    await expect(dest(async () => ({ status: "active", tenant: "abc" })).prepare()).resolves.toBeUndefined();
  });

  it("doesn't block on an unrelated failure of the check", async () => {
    await expect(
      dest(async () => {
        throw new Error("network timeout");
      }).prepare(),
    ).resolves.toBeUndefined();
  });
});
