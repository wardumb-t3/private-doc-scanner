import { describe, expect, it } from "vitest";
import { assistantPrompt } from "../src/assistant-prompt.ts";

const ctx = {
  repoUrl: "https://github.com/Terminal-3/private-doc-scanner",
  nodeHost: "cn-api.sg.testnet.t3n.terminal3.io",
  signUpUrl: "https://terminal3.io/products/agent-developer-kit",
};

describe("the done page's prompt for a fresh AI session", () => {
  const text = assistantPrompt("vault_abc123", ["passport", "payslip"], ctx);

  it("says what was sealed and under which reference", () => {
    expect(text).toContain("I just scanned my passport and payslip");
    expect(text).toContain("reference vault_abc123");
  });

  it("gives everything a session with no memory needs", () => {
    expect(text).toContain("clone https://github.com/Terminal-3/private-doc-scanner");
    expect(text).toContain("npm install in its starter/ folder");
    expect(text).toContain('"set" or "not set"');
    expect(text).toContain("https://terminal3.io/products/agent-developer-kit");
    expect(text).toContain("cn-api.sg.testnet.t3n.terminal3.io is reachable");
    expect(text).toContain("npx tsx scripts/vault.ts status vault_abc123");
  });

  it("picks checks that fit the documents", () => {
    expect(text).toContain(`npx tsx scripts/vault.ts evaluate vault_abc123 '{"document_not_expired":true,"min_age":18,"min_net_pay":"3000.00"}'`);
  });

  it("forbids showing values or handling the key", () => {
    expect(text).toContain("Never run starter/scripts/read-my-data.ts");
    expect(text).toContain("Never print it");
    expect(text).toContain("Don't show any values.");
  });

  it("skips the evaluate step when no check applies", () => {
    const generic = assistantPrompt("vault_x", ["generic"], ctx);
    expect(generic).not.toContain("scripts/vault.ts evaluate");
    expect(generic).toContain("5. Tell me in plain words");
  });
});
