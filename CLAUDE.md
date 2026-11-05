# Private Doc Scanner

An open-source scanner that reads private documents on the user's device and seals the reviewed
details to the user's own T3N vault. Run commands yourself; don't ask the user to open a terminal.

## If the user wants to use it (their documents, their vault)

- Follow the `t3n-private-vault` skill (`.claude/skills/t3n-private-vault`). Scripts are in
  `starter/`; run them from that folder after `npm install` there.
- First connection to Terminal 3, DID, SDK questions: the `t3n-adk-quickstart` skill.
- Documents and their values must never enter the chat. Give the user a scanner link instead.
- Whenever you ask the user to start a new session (after they add their key or allow the T3N host),
  end your message with the full prompt in `starter/prompts/continue.txt`, word for word, so the new
  session can carry on without memory. The scripts also print it with those errors.
- Their key comes from `T3N_API_KEY` in the environment or `starter/.env` (git-ignored). If it's
  missing, copy `starter/.env.example` to `starter/.env` and ask them to paste the key into it in
  their editor; no key yet means signing up at https://terminal3.io/products/agent-developer-kit
  with the email they'll use in the scanner. Never ask for the key in chat, print it, or write it to
  memory.

## If the user is working on the code

- pnpm workspace, Node 22. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`
  (Playwright, Chromium).
- The scanner is `apps/capture-pwa`; the reader is `packages/engines-web`; the vault contract is
  `contracts/doc-intake` (`cargo test`, `cargo build --target wasm32-wasip2 --release`).
- Changing the contract means rebuilding it, copying the `.wasm` to `starter/vault/` and updating the
  SHA-256 and version in `starter/vault/manifest.json` (the app checks that hash before registering).
- The skills live in two places: `.claude/skills` (for this repo) and
  `plugins/private-doc-scanner/skills` (the Claude Code plugin). Edit both; CI fails if they differ.
- Privacy rules are tested end to end (`e2e/privacy.spec.ts`); keep them passing.
