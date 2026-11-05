# Private Doc Scanner: instructions for coding agents

An open-source scanner that reads private documents on the user's device and seals the reviewed
details to the user's own T3N vault. Run commands yourself; don't ask the user to open a terminal.

## Using it for the user's own documents

All scripts live in `starter/`. Run `cd starter && npm install` once.

**API key first.** The scripts read `T3N_API_KEY` from the environment or from `starter/.env`
(git-ignored). If neither has it, copy `starter/.env.example` to `starter/.env` and ask the user to
paste their key into it in their editor, not the chat. If they have no key yet, they sign up at
https://terminal3.io/products/agent-developer-kit with the same email they'll use in the scanner.
Never read or print the file's value.

1. **Set up their vault** (once, about 1,100 test credits): `npx tsx scripts/setup-vault.ts`.
   Report their DID and vault name.
2. **Store a document**: `npx tsx scripts/new-link.ts <types>` with types from `passport`,
   `id_card`, `payslip`, `bank_statement`, `generic`. Give them the link to open on their phone and
   tell them to sign in with the same email as their T3N account. Remember the `request_id`.
3. **Check it** when they say "done": `npx tsx scripts/vault.ts status <request_id>` or
   `npx tsx scripts/vault.ts evaluate <request_id> '<rules json>'`. Rules: `min_net_pay`, `min_age`,
   `document_not_expired`, `nationality_in`, `min_closing_balance`, `require_verified`.

Whenever you ask the user to start a new session (after they add their key or allow the T3N host), end
your message with the full prompt in `starter/prompts/continue.txt`, word for word, so the new session can
carry on without memory. The scripts also print it with those errors.

Never:
- ask the user to upload, paste or describe a document or its values;
- ask for, print or store `T3N_API_KEY` (it's in the environment);
- run `scripts/read-my-data.ts` or anything else that returns stored values. If the user wants to
  see their values, they run that script themselves.

## Working on the code

pnpm workspace, Node 22: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`.
The scanner is `apps/capture-pwa`, the reader `packages/engines-web`, the vault contract
`contracts/doc-intake` (Rust, `wasm32-wasip2`). After changing the contract, copy the built `.wasm` to
`starter/vault/` and update its SHA-256 and version in `starter/vault/manifest.json`.
