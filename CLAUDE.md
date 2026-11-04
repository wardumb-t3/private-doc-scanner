# Private Doc Scanner

An open-source scanner that reads private documents on the user's device and seals the reviewed
details to the user's own T3N vault. Run commands yourself; don't ask the user to open a terminal.

## If the user wants to use it (their documents, their vault)

- Follow the `t3n-private-vault` skill (`.claude/skills/t3n-private-vault`). Scripts are in
  `starter/`; run them from that folder after `npm install` there.
- First connection to Terminal 3, DID, SDK questions: the `t3n-adk-quickstart` skill.
- Documents and their values must never enter the chat. Give the user a scanner link instead.
- Their key is in the environment as `T3N_API_KEY`. Never ask for it in chat, print it, or write it
  to a file or to memory.

## If the user is working on the code

- pnpm workspace, Node 22. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:e2e`
  (Playwright, Chromium).
- The scanner is `apps/capture-pwa`; the reader is `packages/engines-web`; the vault contract is
  `contracts/doc-intake` (`cargo test`, `cargo build --target wasm32-wasip2 --release`).
- Changing the contract means rebuilding it, copying the `.wasm` to `starter/vault/` and updating the
  SHA-256 and version in `starter/vault/manifest.json` (the app checks that hash before registering).
- Privacy rules are tested end to end (`e2e/privacy.spec.ts`); keep them passing.
