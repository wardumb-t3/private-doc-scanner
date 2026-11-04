/**
 * What the agent / business side runs after the user says "done": look up a
 * request by id and get status or a yes/no decision — never the values.
 *
 *   AGENT_KEY=0x… pnpm t3:agent-status -- req_abc123 [--evaluate '{"min_net_pay":"3000.00"}']
 *
 * The agent's DID must be listed at deploy time (AGENT_DIDS=…), or the agent
 * must act under the user's delegation grant.
 */
import { baseUrl, env, networkEnv, readDeployment, sdk, signIn, onFailure } from "./common.ts";

process.on("unhandledRejection", onFailure);
process.on("uncaughtException", onFailure);

const args = process.argv.slice(2).filter((a) => a !== "--");
const requestId = args[0];
if (!requestId) {
  console.error("usage: pnpm t3:agent-status -- <request_id> [--evaluate '<rules json>']");
  process.exit(2);
}
const i = args.indexOf("--evaluate");
const rules = i > 0 ? JSON.parse(args[i + 1] ?? "{}") : null;

const e = networkEnv();
const url = baseUrl(e);
const dep = await readDeployment();
const { client, did } = await signIn(env("AGENT_KEY"), e, url);
const version = await sdk.getContractVersion(url, dep.contract);
const out = await client.executeAndDecode({
  contract_id: dep.contract,
  contract_version: version,
  function_name: rules ? "evaluate" : "status",
  input: rules ? { request_id: requestId, rules } : { request_id: requestId },
});
console.log(`as ${did}:`);
console.log(JSON.stringify(out, null, 2));
