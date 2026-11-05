import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { expect, test, type Page } from "@playwright/test";
import { choose, passportFile, payslipFile } from "./fixtures.ts";

const flow = (page: Page) => page.locator("pde-flow");
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

async function expectPrivacyChrome(page: Page) {
  await expect(flow(page).getByText("Your document never leaves this device.")).toBeVisible();
  await expect(flow(page).getByText("On this device", { exact: true })).toBeVisible();
}

async function readPayslip(page: Page) {
  const { truth, file } = await payslipFile(21);
  await expect(flow(page).getByTestId("offline-ready")).toBeVisible();
  await flow(page).getByTestId("file-input").setInputFiles(file);
  await expect(flow(page).getByTestId("review-continue")).toBeEnabled();
  return truth;
}

test("privacy label and on-device chip are shown on every step; More › expands", async ({ page }) => {
  await page.goto("./?types=payslip");
  await choose(page, "payslip");
  await expectPrivacyChrome(page);
  await flow(page).getByRole("button", { name: "More ›" }).click();
  await expect(flow(page).getByText("only those are sealed directly to")).toBeVisible();
  await expect(flow(page).getByText("No AI or Terminal 3 can see it in plain text.")).toBeVisible();

  await readPayslip(page);
  await expectPrivacyChrome(page);
  await flow(page).getByTestId("review-continue").click();
  await expect(flow(page).getByTestId("collected-payslip")).toBeVisible();
  await flow(page).getByTestId("to-seal").click();
  await expectPrivacyChrome(page);
  await flow(page).getByTestId("seal").click();
  await expect(flow(page).getByTestId("done")).toBeVisible();
  await expectPrivacyChrome(page);
});

test("'What left this device' lists every request the page made", async ({ page }) => {
  const seen = new Set<string>();
  page.context().on("request", (r) => {
    if (r.serviceWorker() || /^(blob|data):/.test(r.url()) || r.url().endsWith("/sw.js")) return;
    seen.add(r.url());
  });
  await page.goto("./?types=payslip");
  await choose(page, "payslip");
  await readPayslip(page);
  await page.waitForTimeout(500);
  const listed = new Set(
    await flow(page).locator("pde-network-panel").evaluate((el) =>
      ((el as unknown as { entries: { url: string }[] }).entries ?? []).map((e) => e.url),
    ),
  );
  const missing = [...seen].filter((u) => !listed.has(u));
  expect(missing).toEqual([]);
});

test("reading works in airplane mode once the reader is ready", async ({ page, context }) => {
  const { truth, file } = passportFile(3);
  await page.goto("./?types=passport");
  await choose(page, "passport");
  await expect(flow(page).getByTestId("offline-ready")).toBeVisible();
  await context.setOffline(true);
  await flow(page).getByTestId("file-input").setInputFiles(file);
  await expect(flow(page).locator("[data-field=document_number] input")).toHaveValue(truth.document_number);
  await expect(flow(page).locator("[data-field=document_number]")).toContainText("Check digits on the document match");
  await context.setOffline(false);
});

test("submission is blocked when the T3 node's attestation cannot be verified", async ({ page }) => {
  let executed = false;
  await page.route("**/pde.config.json", (route) =>
    route.fulfill({
      json: {
        destination: {
          type: "t3n",
          baseUrl: "http://localhost:4173",
          environment: "sandbox",
          target: { kind: "contract", contractId: "z:test:docs", functionName: "ingest" },
        },
        defaultDocTypes: ["payslip"],
        repoUrl: "https://example.invalid/repo",
      },
    }),
  );
  // A manifest with a forged signature: the SDK must reject it.
  await page.route("**/api/trust-manifest**", (route) =>
    route.fulfill({
      json: { cluster: "testnet", version: 99, peer_ids: ["x"], rtmr3_allowlist: [], rtmr1_allowlist: [], signed_at: "2025-01-01T00:00:00Z", signature: "00".repeat(64) },
    }),
  );
  await page.route("**/api/rpc**", (route) => {
    executed = true;
    return route.abort();
  });
  // A leftover T3 session from an earlier sign-in (what broke re-sign-in in real browsers).
  await page.context().addCookies([{ name: "t3_session", value: "stale", url: "http://localhost:4173/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  await page.goto("./?types=payslip");
  await choose(page, "payslip");
  await readPayslip(page);
  await flow(page).getByTestId("review-continue").click();
  await flow(page).getByTestId("to-seal").click();
  await expect(flow(page).getByText("couldn't verify the T3 node, so nothing will be sent")).toBeVisible();
  // The app expired the old session before the handshake, so the next sign-in starts fresh.
  expect((await page.context().cookies()).some((c) => c.name === "t3_session")).toBe(false);
  await expect(flow(page).getByTestId("seal")).toBeDisabled();
  // Rejected by the SDK's signature check on the operator-signed manifest.
  await expect(flow(page).locator("pde-seal-confirm").getByRole("alert")).toContainText("failed signature verification");
  expect(executed).toBe(false);
});

/**
 * Point the app at an HPKE test recipient; `open()` decrypts what was sent.
 * Lets a test check the exact submission without any T3 node.
 */
async function hpkeRecipient(page: Page, opts: { failFirst?: boolean } = {}) {
  const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
  const kp = await suite.kem.generateKeyPair();
  const pub = b64u(new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)));
  const sent = { raw: "", body: null as { kid: string; enc: string; ct: string } | null, attempts: 0 };
  await page.route("**/pde.config.json", (route) =>
    route.fulfill({
      json: {
        destination: { type: "hpke", endpoint: "http://localhost:4173/ingest", recipientPublicKey: pub, keyId: "test-key-1" },
        defaultDocTypes: ["payslip"],
        repoUrl: "https://example.invalid/repo",
      },
    }),
  );
  await page.route("**/ingest", async (route) => {
    sent.attempts++;
    if (opts.failFirst && sent.attempts === 1) return route.fulfill({ status: 503, body: "busy" });
    sent.raw = route.request().postData() ?? "";
    sent.body = JSON.parse(sent.raw);
    await route.fulfill({ json: { reference: "ref-42" } });
  });
  return {
    sent,
    async open() {
      const recipient = await suite.createRecipientContext({
        recipientKey: kp.privateKey,
        enc: new Uint8Array(Buffer.from(sent.body!.enc, "base64url")).buffer,
        info: new TextEncoder().encode("pde.submission/v1").buffer,
      });
      const pt = await recipient.open(new Uint8Array(Buffer.from(sent.body!.ct, "base64url")).buffer, new TextEncoder().encode("test-key-1").buffer);
      return JSON.parse(new TextDecoder().decode(pt));
    },
  };
}

test("HPKE destination: the recipient decrypts exactly the reviewed fields; the wire carries ciphertext only", async ({ page }) => {
  const hpke = await hpkeRecipient(page);
  await page.goto("./?req=req_hpke&types=payslip");
  await choose(page, "payslip");
  const truth = await readPayslip(page);
  await flow(page).getByTestId("review-continue").click();
  await expect(flow(page).getByTestId("collected-payslip")).toBeVisible();
  await flow(page).getByTestId("to-seal").click();
  await flow(page).getByTestId("seal").click();
  await expect(flow(page).getByTestId("done")).toBeVisible();

  expect(hpke.sent.raw).not.toContain(truth.net_pay);
  expect(hpke.sent.raw).not.toContain(truth.employee_name);
  const submission = await hpke.open();
  // Opened from the requester's link: no reference shown to pass on.
  await expect(flow(page).getByTestId("reference")).toHaveCount(0);
  expect(submission.request_id).toBe("req_hpke");
  expect(submission.documents[0].fields.net_pay.value).toBe(truth.net_pay);
  expect(submission.documents[0].fields.net_pay.validated).toBe(true);
  // Shown as DD-MM-YYYY on screen, but always sent as ISO.
  expect(submission.documents[0].fields.pay_date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(JSON.stringify(submission)).not.toMatch(/bbox|previews|payslip\.pdf/);
});

test("the footer says which mode this deployment runs in", async ({ page }) => {
  await page.goto("./");
  await expect(flow(page).getByTestId("mode")).toHaveText("demo mode: nothing is sent");
});

test("opened without ?req=: a reference is generated, sent as the request id and shown to pass on", async ({ page }) => {
  const hpke = await hpkeRecipient(page);
  await page.goto("./");
  await choose(page, "payslip");
  await readPayslip(page);
  await flow(page).getByTestId("review-continue").click();
  await flow(page).getByTestId("to-seal").click();
  await flow(page).getByTestId("seal").click();
  const reference = flow(page).getByTestId("reference");
  await expect(reference).toContainText("Reference this in your chat so the AI can reference your documents. They would not be able to see it.");
  const shown = (await reference.locator("code").textContent())!.trim();
  // Readable, no 0/O or 1/I/L, and valid for the contract (8–128 of [A-Za-z0-9_-]).
  expect(shown).toMatch(/^pde-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  expect((await hpke.open()).request_id).toBe(shown);
});

test("a failed send can be retried from the seal screen", async ({ page }) => {
  const hpke = await hpkeRecipient(page, { failFirst: true });
  await page.goto("./?req=req_retry_01&types=payslip");
  await choose(page, "payslip");
  await readPayslip(page);
  await flow(page).getByTestId("review-continue").click();
  await flow(page).getByTestId("to-seal").click();
  await flow(page).getByTestId("seal").click();
  await expect(flow(page).locator("pde-seal-confirm").getByRole("alert")).toContainText("Sending failed");
  await flow(page).getByTestId("retry").click();
  await expect(flow(page).getByTestId("done")).toBeVisible();
  expect(hpke.sent.attempts).toBe(2);
  expect((await hpke.open()).request_id).toBe("req_retry_01");
});

test("no vault yet: the seal screen offers 'Set up my vault', then sealing works", async ({ page }) => {
  await page.route("**/pde.config.json", (route) =>
    route.fulfill({ json: { destination: { type: "dry-run", simulateVaultSetup: true }, defaultDocTypes: ["payslip"], repoUrl: "https://example.invalid/repo" } }),
  );
  await page.goto("./?req=req_vault_setup&types=payslip");
  await choose(page, "payslip");
  await readPayslip(page);
  await flow(page).getByTestId("review-continue").click();
  await flow(page).getByTestId("to-seal").click();
  await expect(flow(page).getByTestId("vault-setup")).toContainText("This account doesn't have a private data vault yet. Complete a one-time setup (uses about 1,100 credits) here.");
  await expect(flow(page).getByTestId("seal")).toBeDisabled();
  await flow(page).getByTestId("setup-vault").click();
  await expect(flow(page).getByTestId("vault-setup")).toHaveCount(0);
  await flow(page).getByTestId("seal").click();
  await expect(flow(page).getByTestId("done")).toBeVisible();
});

test("the vault contract served to the app matches its pinned SHA-256", async ({ request }) => {
  const manifest = JSON.parse(readFileSync(new URL("../starter/vault/manifest.json", import.meta.url), "utf8"));
  const res = await request.get(`./vault/${manifest.file}`);
  expect(res.ok()).toBe(true);
  expect(createHash("sha256").update(await res.body()).digest("hex")).toBe(manifest.sha256);
});

test("without a Terminal 3 account: blocked at sealing with a sign-up link, then Try again", async ({ page }) => {
  await page.route("**/pde.config.json", (route) =>
    route.fulfill({ json: { destination: { type: "dry-run", simulateNoDeveloperAccount: true }, defaultDocTypes: ["payslip"], repoUrl: "https://example.invalid/repo" } }),
  );
  await page.goto("./?req=req_no_account&types=payslip");
  await choose(page, "payslip");
  await readPayslip(page);
  await flow(page).getByTestId("review-continue").click();
  await flow(page).getByTestId("to-seal").click();
  const needed = flow(page).getByTestId("account-needed");
  await expect(needed).toContainText("Sign up for a Terminal 3 account first.");
  await expect(needed.getByTestId("sign-up")).toHaveAttribute("href", "https://terminal3.io/products/agent-developer-kit");
  await expect(flow(page).locator("pde-seal-confirm").getByRole("alert")).toContainText("isn't linked to a Terminal 3 account yet");
  await expect(flow(page).getByTestId("seal")).toBeDisabled();
  // After signing up, Try again signs in afresh and sealing works.
  await flow(page).getByTestId("retry").click();
  await expect(needed).toHaveCount(0);
  await flow(page).getByTestId("seal").click();
  await expect(flow(page).getByTestId("done")).toBeVisible();
});

test("the done page hands back a prompt any fresh AI session can use to check the submission", async ({ page }) => {
  await page.route("**/pde.config.json", (route) =>
    route.fulfill({ json: { destination: { type: "dry-run", showAssistantPrompt: true }, defaultDocTypes: ["payslip"], repoUrl: "https://github.com/Terminal-3/private-doc-scanner" } }),
  );
  await page.goto("./?req=req_prompt_01&types=payslip");
  await choose(page, "payslip");
  const truth = await readPayslip(page);
  await flow(page).getByTestId("review-continue").click();
  await flow(page).getByTestId("to-seal").click();
  await flow(page).getByTestId("seal").click();
  const prompt = flow(page).getByTestId("ai-prompt");
  await expect(prompt).toContainText("I just scanned my payslip");
  await expect(prompt).toContainText("npx tsx scripts/vault.ts status req_prompt_01");
  await expect(prompt).toContainText("clone https://github.com/Terminal-3/private-doc-scanner");
  // The prompt carries the reference and document types, never the values.
  for (const value of [truth.net_pay, truth.employee_name, truth.employer_name]) await expect(prompt).not.toContainText(value);
});
