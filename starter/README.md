# Starter kit: your T3N vault

Keep your private documents (passport, ID card, payslip, bank statement) in **your own vault on
Terminal 3**, without them ever going through an AI chat. Everything is driven from Claude Code
chat; you never open a terminal.

- **Reading:** documents are read **on your phone**; the capture page is open source.
- **Storing:** after you review the details, only those details are encrypted to the T3 enclave
  and stored in a contract you registered **under your own DID** (`z:<your tid>:doc-intake`).
  Its maps are private: only that contract can read them.
- **Checking:** Claude can check what was stored and evaluate rules (e.g. "net pay ≥ 3000",
  "passport not expired"). It sees results, never values.

## Your path

1. **Get an account.** Sign in on the [claim page](https://www.terminal3.io/claim-page) with
   your email. You get a developer key (shown once), a `did:t3n` and test credits.
2. **Give Claude Code the key, not the chat.** Open Claude Code on the web with this repo. In the
   environment settings (environment menu → **Edit**):
   - **Network secrets / Environment variables:** add `T3N_API_KEY` = your key.
   - **Network access:** allow `cn-api.sg.testnet.t3n.terminal3.io` (Limited, with package
     managers allowed).

   Then start a **new** session; environment changes apply to new sessions only.
3. **Prompt:** "Set me up on T3N and set up my private vault." Claude connects (attested
   handshake), shows your DID, and registers your vault (about 1,100 test credits).
4. **Prompt:** "Store my passport and payslip privately." Claude replies with a link. Open it on
   your phone, scan, review, and at **Seal and send** sign in with the **same email** as your T3N
   account. The screen shows "Saving to the vault of did:t3n:…" (yours).
5. **Prompt:** "done: would I pass net pay ≥ 3000 and passport not expired?" Claude checks
   inside the enclave and tells you the result.

## What's in here

| Path | What it does |
|---|---|
| `scripts/setup-vault.ts` | Verifies `vault/doc-intake.wasm` against its pinned SHA-256, registers it under your DID, creates its private maps. Safe to re-run. |
| `scripts/new-link.ts` | Prints a capture link with a fresh, unguessable request id. No key, no network. |
| `scripts/vault.ts` | `status` / `evaluate` a submission in your vault (no values). |
| `scripts/read-my-data.ts` | **Prints your private values**: reads one entry of your own vault back, to check what was stored. Run it yourself, never in an AI chat. |
| `vault/` | The contract (built from `contracts/doc-intake` in this repo) and its manifest. `setup-vault` also records your vault's contract id in `vault/doc-intake.local.json` (git-ignored), for add-on contracts. |
| `../.claude/skills/t3n-adk-quickstart` | Copy of the official Terminal 3 skill (docs `skills/t3n-adk-quickstart`). |
| `../.claude/skills/t3n-private-vault` | How Claude runs the vault flow without ever seeing your documents. |

## Your key

On your own computer, the key goes in `starter/.env` (copy `.env.example`; the file is git-ignored).
In a cloud session, it goes in the environment's secret settings. Nothing in this repo asks for it in a
chat, prints it or sends it anywhere but T3N; the scanner page never needs it (you sign in there with
email + code).

## Who can see what

| Who | Sees |
|---|---|
| The capture page's host | Encrypted traffic only (through a same-origin relay). You trust it to serve the published code; the page's footer names the build commit to check. |
| Claude / any AI | Which documents and fields arrived, verification status, rule results. |
| You, as the vault's owner | You own the maps, so you can read your own entries with your key. |
| Terminal 3 operators | Only ciphertext; the enclave decrypts. |
| A travel booking contract, **only if you add one** | Your passport details are sent to the booking service you choose, not to the AI agent. See [Next: book a flight](../README.md#next-book-a-flight-with-your-sealed-passport). |

## Running the scripts

Run them from this folder after `npm install` here (it has its own small `package.json`, separate from
the scanner's workspace). The skills that tell Claude Code and Codex how to use them live at the repo
root in `.claude/skills`, with `CLAUDE.md` and `AGENTS.md`.
