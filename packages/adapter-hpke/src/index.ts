import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import type { Destination, DestinationInfo, Submission, SubmitReceipt } from "@pde/core";

/**
 * Generic destination: seal the submission with HPKE (RFC 9180, base mode,
 * DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM) to a recipient
 * public key and POST the ciphertext. Only the holder of the private key —
 * ideally inside an attested TEE — can read it; the web server, CDN and any
 * proxy in between see ciphertext only.
 */
export interface HpkeDestinationOptions {
  /** HTTPS endpoint that receives `{ kid, enc, ct }`. */
  endpoint: string;
  /** Recipient public key: uncompressed P-256 point, base64url. */
  recipientPublicKey: string;
  /** Identifier of the key, echoed to the recipient and shown to the user. */
  keyId: string;
  label?: string;
  /**
   * Verify the key before use — e.g. check a TEE attestation that binds
   * `recipientPublicKey`. Throw to block submission.
   */
  verify?: (publicKey: Uint8Array) => Promise<void>;
  fetch?: typeof fetch;
}

const INFO = new TextEncoder().encode("pde.submission/v1");

export function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hpkeSuite(): CipherSuite {
  return new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
}

export class HpkeDestination implements Destination {
  private readonly opts: HpkeDestinationOptions;
  private readonly publicKey: Uint8Array;
  private ready = false;

  constructor(opts: HpkeDestinationOptions) {
    this.opts = opts;
    this.publicKey = b64uDecode(opts.recipientPublicKey);
  }

  describe(): DestinationInfo {
    return { kind: "key", id: this.opts.keyId, label: this.opts.label ?? new URL(this.opts.endpoint).host };
  }

  origins(): string[] {
    return [new URL(this.opts.endpoint).origin];
  }

  async prepare(): Promise<void> {
    if (this.publicKey.length !== 65 || this.publicKey[0] !== 4) throw new Error("recipient key is not an uncompressed P-256 point");
    await this.opts.verify?.(this.publicKey);
    this.ready = true;
  }

  async submit(submission: Submission): Promise<SubmitReceipt> {
    if (!this.ready) throw new Error("destination not verified");
    const suite = hpkeSuite();
    const recipientPublicKey = await suite.kem.deserializePublicKey(this.publicKey.slice().buffer);
    const sender = await suite.createSenderContext({ recipientPublicKey, info: INFO.slice().buffer });
    const aad = new TextEncoder().encode(this.opts.keyId);
    const ct = await sender.seal(new TextEncoder().encode(JSON.stringify(submission)).buffer, aad.buffer);
    const res = await (this.opts.fetch ?? fetch)(this.opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ kid: this.opts.keyId, enc: b64uEncode(new Uint8Array(sender.enc)), ct: b64uEncode(new Uint8Array(ct)) }),
    });
    if (!res.ok) throw new Error(`recipient answered ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { reference?: string };
    return { reference: body.reference ?? submission.request_id ?? "sent" };
  }
}
