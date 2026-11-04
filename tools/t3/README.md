# T3 testnet scripts

These scripts run from a server or laptop with Node 22. They use the published `@terminal3/t3n-sdk` and your **testnet API key**: the ETH private key from the claim page, with its DID and credits.

- **Key handling:** the key is read from `T3N_API_KEY` (or `AGENT_KEY`) and is never printed or written to disk.
- **Network:** every script verifies the node's TDX attestation against the operator-signed trust manifest before signing in.

| Command | What it does |
|---|---|
| `pnpm contract:test` | Native unit tests for the `doc-intake` contract |
| `pnpm contract:build` | Builds `contracts/doc-intake` to `wasm32-wasip2` (≈ 230 KB; the tenant limit is 1 MiB) |
| `pnpm t3:deploy` | Registers `z:<tenant>:doc-intake` and creates the private `intake` and `config` maps (the ACL grants them to this contract only). Optionally lists agent DIDs that may read status. Writes `tools/t3/out/deployment.json`. |
| `pnpm t3:config -- <domain>` | Writes `deploy/out/pde.config.json` so the app uses `https://<domain>/t3`. By default each signed-in user's data goes to their own vault, `z:<their tid>:doc-intake`; `PDE_FIXED_CONTRACT=1` sends everyone to the contract from `pnpm t3:deploy` instead |
| `pnpm t3:smoke` | Full round trip: synthetic passport and payslip → pipeline → attested, encrypted `ingest` → `status` (checks that no values come back) → `evaluate` |
| `pnpm t3:agents -- did:t3n:<agent> …` | Sets which agent DIDs may call `status` / `evaluate` for any request, without re-registering the contract (`--clear` empties the list) |
| `pnpm t3:agent-status -- <request_id> [--evaluate '<rules>']` | What the agent runs after the user says "done" |

## Environment

| Variable | Default | |
|---|---|---|
| `T3N_API_KEY` | – | Tenant / end-user key (0x… hex) |
| `T3N_ENV` | `testnet` | `testnet` \| `sandbox` (alias of testnet) \| `production` |
| `T3N_BASE_URL` | the SDK's node URL for `T3N_ENV` | Set to `https://<domain>/t3` to test through your relay |
| `AGENT_DIDS` | – | Comma-separated `did:t3n:…` allowed to call `status` / `evaluate` for any request |
| `AGENT_KEY` | – | Key of the agent identity, for `t3:agent-status` |
| `CONTRACT_VERSION` | `version` in `contracts/doc-intake/Cargo.toml` | Bump it to re-register |

## The contract (`contracts/doc-intake`)

| Function | Caller | Returns |
|---|---|---|
| `ingest(pde.submission/v1)` | The end user, signed in themselves (not a delegate) | `{ reference, received_at, enclave_checks }`. Stores the record under `req:<request_id>`; another user cannot overwrite it. |
| `status({ request_id })` | The owner, an agent under the owner's delegation grant, or a listed agent | Which documents and fields arrived, which were verified on the device, which the user edited, and the enclave's check results. **No values.** |
| `evaluate({ request_id, rules })` | Same as `status` | `{ results: { rule: { pass, basis } }, all_pass }`, computed inside the enclave. **No values.** |

**Rules for `evaluate`:**

- `min_net_pay` (`"3000.00"`)
- `min_age`
- `document_not_expired`
- `nationality_in` (`["NLD", …]`)
- `min_closing_balance`
- `require_verified` (when set, self-attested or user-edited inputs fail the rule)

**Checks the enclave re-runs:**

- IBAN mod-97
- gross − deductions = net
- opening + in − out = closing
- date validity
- not expired, against cluster time

**Storage:** the maps' ACL lets only this contract read or write them, so agents only ever get `status` / `evaluate` results. The ACL does **not** bind the maps' owner: the tenant whose key registered the contract can read entries directly (`tenant.maps.entryGet`, see the T3 docs on storage namespaces). That's why the default setup gives every user **their own** vault (`starter/` → `setup-vault`), so the owner is the person whose data it is. With the shared-contract setup below, whoever holds the deploying key can read every submission.

**Built against:** Trinity release `testnet-v1.0.11`, with WIT `host:tenant@2.0.0` and `host:interfaces@2.2.0` (vendored in `contracts/doc-intake/wit/deps`). The ADK docs still mention `host-tenant 1.2.0`, but 2.x is not link-compatible with it. If testnet runs an older release, registration fails with a linking error; re-vendor the WIT from that release.

## Costs

- **Registration:** registering costs about 1,000 test tokens, and each map costs 50.
- **Per call:** the caller pays for each call to `z:` contracts. With wallet sign-in, the end user in your tests is you, so your credits pay.
- **Other users:** a pilot with other people needs either credits for those users, or T3 ops adding the contract to `free_contracts` on testnet.
