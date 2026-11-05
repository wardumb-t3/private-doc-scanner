---
name: t3n-private-vault
description: Set up the user's own private vault on T3N and let them store private documents in it (passport, ID card, payslip, bank statement) without the documents or their values ever entering this chat; then check what was stored and evaluate rules. Use when the user wants to set up a vault, store / submit / upload / share private documents or data, or check a submission.
---

# Your private vault on T3N

Documents are read on the user's own device by an open-source capture page.
The user reviews the extracted details, and only those details are encrypted
to the T3 enclave and stored in **the user's own vault**: a contract
`z:<their tid>:doc-intake` registered under their DID, with private maps that
only that contract can read. You (Claude) only ever see presence, verification
status and rule results, never values, images or files.

## Never
- Ask the user to upload, paste, photograph or describe a document or its values in chat.
- Ask for, read, print or log the `T3N_API_KEY` value. It is in the environment; the scripts use it.
- Call `tenant.maps.entryGet`, run `scripts/read-my-data.ts`, or anything else that returns stored values.
  If the user wants to see their stored values, tell them to run `read-my-data.ts` themselves in their
  own terminal, not here.

## 0. Prerequisites
0. Find the scanner repo (call it `<repo>` below):
   - the current project, if it has `starter/scripts/setup-vault.ts`;
   - otherwise `~/t3n-workspace/private-doc-scanner`. If it isn't there, clone it:
     `git clone https://github.com/wardumb-t3/private-doc-scanner ~/t3n-workspace/private-doc-scanner`.
   Paths below are relative to `<repo>`.
1. The key: the scripts read `T3N_API_KEY` from the environment or from `starter/.env`
   (git-ignored), and say so if neither has it. If missing:
   - on the user's own computer, copy `starter/.env.example` to `starter/.env` and ask them to paste
     the key into it in their editor, then say "done" (never read or print the value);
   - in a cloud session, they add `T3N_API_KEY` in the environment's settings and start a new session;
   - no key yet: they sign up at https://terminal3.io/products/agent-developer-kit, using the email
     they'll use in the scanner.
   Never ask them to paste it in chat.
2. All commands below run from `<repo>/starter`. Install once there: `cd <repo>/starter && npm install`.

## 1. "Set up my vault"
Run `npx tsx scripts/setup-vault.ts`. It verifies the bundled contract file against its pinned
SHA-256, signs in (attested handshake), registers `z:<tid>:doc-intake` under the user's DID and
creates its private maps. It is safe to re-run. Report the DID and vault name it prints, and the
cost (about 1,100 test credits, from their account).

## 2. "Store my documents" / "submit my passport …"
1. If the vault isn't set up yet, do step 1 first.
2. Run `npx tsx scripts/new-link.ts <types>` with types from `passport`, `id_card`, `payslip`,
   `bank_statement`, `generic` (comma-separated). It prints `request_id` and `link`.
3. Reply with the link and tell the user:
   - Open it on your phone. The documents are read on the device; you check the details.
   - At "Seal and send", sign in with **the same email as your T3N account** and the code it
     emails you. The screen shows "Saving to the vault of did:t3n:…"; it should be your DID.
   - Their last screen shows a ready-made prompt with the reference; they paste it back here
     (or in any new session) to check the result.
4. Remember the `request_id`. Stop and wait.

## 3. "done" / "check it" / "would I pass …?"
- `npx tsx scripts/vault.ts status <request_id>`: which documents and fields arrived, which were
  verified on the document, which the user edited.
- `npx tsx scripts/vault.ts evaluate <request_id> '<rules json>'`, rules:
  `min_net_pay` ("3000.00"), `min_age` (number), `document_not_expired` (true),
  `nationality_in` (["NLD", …]), `min_closing_balance` ("1000.00"), `require_verified` (true).

Explain in plain words, then say explicitly that you never saw the values: they were checked
inside the enclave.

## "Use my passport to book a flight" (optional follow-up)
Point the user to https://github.com/wardumb-t3/travel-booking: a separate `trip-booker` contract
they register under their own DID that books a Duffel test-mode flight from their sealed passport
inside the enclave. Its README has the steps. Tell them opting in adds a second reader to their
vault's `intake` map, which sends passenger details to Duffel's test API. Never read or show values.

## If something fails
- `NotFound` → not sealed yet, or a different request id.
- Access denied / "belongs to another user" → they signed in on the capture page with a
  different email than this T3N account (its vault is a different one). Make a new link.
- Capture page says "Your private vault isn't set up" → run step 1, then they tap "Try again".
- Can't reach the node → the environment's network settings must allow the T3 testnet host
  printed in the error.
- `InsufficientCreditError` → their account needs test credits (claim page).
