import type { Submission } from "@pde/core";
import { describe, expect, it } from "vitest";
import { b64uDecode, b64uEncode, HpkeDestination, hpkeSuite } from "../src/index.ts";

const submission: Submission = {
  schema: "pde.submission/v1",
  request_id: "req_1",
  documents: [{ doc_type: "payslip", fields: { net_pay: { value: "4000.00", source: "text_layer", validated: true, validated_by: ["x"], user_edited: false } }, checks: [] }],
  client: { name: "t", version: "0", engine: "test" },
  created_at: "2025-01-01T00:00:00.000Z",
};

describe("HPKE destination", () => {
  it("seals so that only the private key holder can read it", async () => {
    const suite = hpkeSuite();
    const kp = await suite.kem.generateKeyPair();
    const pub = b64uEncode(new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)));
    let posted: { kid: string; enc: string; ct: string } | null = null;
    const dest = new HpkeDestination({
      endpoint: "https://recipient.example/ingest",
      recipientPublicKey: pub,
      keyId: "k1",
      fetch: (async (_url: string, init: RequestInit) => {
        posted = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ reference: "ref-1" }), { status: 200 });
      }) as typeof fetch,
    });
    await dest.prepare();
    const receipt = await dest.submit(submission);
    expect(receipt.reference).toBe("ref-1");
    expect(JSON.stringify(posted)).not.toContain("4000.00");

    const recipient = await suite.createRecipientContext({
      recipientKey: kp.privateKey,
      enc: b64uDecode(posted!.enc).buffer,
      info: new TextEncoder().encode("pde.submission/v1").buffer,
    });
    const pt = await recipient.open(b64uDecode(posted!.ct).buffer, new TextEncoder().encode("k1").buffer);
    expect(JSON.parse(new TextDecoder().decode(pt))).toEqual(submission);
  });

  it("refuses to send when key verification fails", async () => {
    const suite = hpkeSuite();
    const kp = await suite.kem.generateKeyPair();
    const dest = new HpkeDestination({
      endpoint: "https://recipient.example/ingest",
      recipientPublicKey: b64uEncode(new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey))),
      keyId: "k1",
      verify: async () => {
        throw new Error("attestation mismatch");
      },
    });
    await expect(dest.prepare()).rejects.toThrow("attestation mismatch");
    await expect(dest.submit(submission)).rejects.toThrow("not verified");
  });
});
