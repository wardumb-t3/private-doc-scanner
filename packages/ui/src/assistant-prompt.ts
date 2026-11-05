import type { DocType } from "@pde/core";
import { DOC_LABELS } from "./labels.ts";

/** What the done page needs to write a prompt that works in a brand-new AI session. */
export interface AssistantPromptContext {
  /** Public repo with the starter scripts, e.g. https://github.com/Terminal-3/private-doc-scanner */
  repoUrl: string;
  /** T3N node host the session must be able to reach. */
  nodeHost: string;
  /** Where to get a Terminal 3 account and API key. */
  signUpUrl: string;
}

/** Checks worth running for each document type (vault `evaluate` rules). */
const DEFAULT_RULES: Partial<Record<DocType, Record<string, unknown>>> = {
  passport: { document_not_expired: true, min_age: 18 },
  id_card: { document_not_expired: true, min_age: 18 },
  payslip: { min_net_pay: "3000.00" },
  bank_statement: { min_closing_balance: "1000.00" },
};

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * A complete, self-contained prompt for checking a sealed submission from
 * any AI coding session, assuming it remembers nothing: what the tool is,
 * where the scripts are, how the key and network must be set up, what
 * never to run, and the exact commands. Contains no values, only the
 * reference and document types.
 */
export function assistantPrompt(requestId: string, docTypes: DocType[], ctx: AssistantPromptContext): string {
  const types = [...new Set(docTypes)];
  const names = list(types.map((t) => DOC_LABELS[t].title.toLowerCase()));
  const rules = Object.assign({}, ...types.map((t) => DEFAULT_RULES[t] ?? {})) as Record<string, unknown>;
  const ruleWords = Object.keys(rules).length ? JSON.stringify(rules) : null;
  const repo = ctx.repoUrl.replace(/\/+$/, "");
  return [
    `I'm using the open-source Private Doc Scanner with Terminal 3 (T3N). I just scanned my ${names} on my phone and sealed the details to my own T3N vault under the reference ${requestId}. Please check the result in my vault. Run the commands yourself; don't ask me to run anything.`,
    "",
    "Ground rules for this whole session:",
    "- My T3N API key is in the environment as T3N_API_KEY, or in starter/.env (git-ignored). Never print it, ask me for it in the chat, or write it anywhere.",
    "- Never run starter/scripts/read-my-data.ts or anything else that shows my stored values. Only use status and evaluate, which return no values.",
    "- Never ask me to paste, upload or describe my documents.",
    "",
    "Steps:",
    `1. If ~/t3n-workspace/private-doc-scanner doesn't exist, clone ${repo} there (a shallow clone is fine). Then run npm install in its starter/ folder.`,
    `2. Check whether T3N_API_KEY is set in the environment or in starter/.env, and tell me only "set" or "not set". If it's not set, stop: tell me to add it as an environment variable or secret (on Claude Code on the web: the environment's settings, then start a new session), or to paste it into starter/.env in my editor. If I have no key, tell me to sign up at ${ctx.signUpUrl} with the same email I used in the scanner.`,
    `3. Check that ${ctx.nodeHost} is reachable. If it isn't, stop and tell me to allow that host in my environment's network settings (then start a new session).`,
    `4. In starter/, run: npx tsx scripts/vault.ts status ${requestId}`,
    ...(ruleWords ? [`5. Then run: npx tsx scripts/vault.ts evaluate ${requestId} '${ruleWords}'`] : []),
    `${ruleWords ? "6" : "5"}. Tell me in plain words which documents and fields arrived, which were verified on the document and which I edited${ruleWords ? ", and whether each check passed" : ""}. Don't show any values.`,
    "",
    `If status says the reference isn't found, tell me I may have used a different email or reference. If it says access is denied, the key in this session belongs to a different Terminal 3 account than the email I sealed with.`,
  ].join("\n");
}
