# Using it with T3 (no Trinity changes needed)

`@pde/adapter-t3n` uses only the published `@terminal3/t3n-sdk`:

1. `fetchTrustedManifest(env)` fetches the operator-signed trust anchor. It is verified against a key pinned in the SDK.
2. `new T3nClient({ trustAnchor, … }).handshake()` checks the Intel TDX attestation, then establishes an ML-KEM session. Every RPC after this is encrypted to the enclave.
3. `authenticate(…)` signs the user in. The PWA uses email OTP; you can pass your own flow.
4. The submission is sent to one of two targets:
   - **`contract` (recommended):** `executeAndDecode({ contract_id, function_name, input: <pde.submission/v1> })` against **your own ADK tenant contract** (`z:<tenant>:<name>`). You write and deploy that contract as usual with the ADK; the payload schema is below.
   - **`user-profile`:** `submitUserInput({ profile })` with the passport/ID basics mapped to Level-1 profile fields (`first_name`, `last_name`, `document_issuance_country`). Fields the user contract does not accept are refused.

## Configure a deployment

The receiving contract is in this repo: `contracts/doc-intake` (`ingest` / `status` / `evaluate`). Deploy it with your testnet API key (`pnpm t3:deploy`) and generate the app config for your domain (`pnpm t3:config -- capture.example.com`). See [tools/t3/README.md](../tools/t3/README.md) for the scripts and [deploy/README.md](../deploy/README.md) for hosting.

The generated `pde.config.json` looks like this:

```json
{
  "destination": {
    "type": "t3n",
    "baseUrl": "https://capture.example.com/t3",
    "environment": "testnet",
    "target": { "kind": "contract", "contractId": "z:<tenant-id>:doc-intake", "functionName": "ingest" },
    "signIn": ["wallet", "email"]
  }
}
```

- `baseUrl` is the **same-origin relay** on your server (`/t3` → the T3 node). T3 nodes only accept browser calls from allow-listed origins, and the relay avoids that without weakening the encryption.
- `signIn: "wallet"` signs T3's login challenge in a browser wallet. You get the same DID and credits as your API key, and the key never touches the page.

## The request link (how the chat hands off)

The agent or business sends the user a link:

```
https://capture.<business>.com/?req=<request-id>&types=passport,payslip
```

- `req` is an id you generate: 8 to 128 characters of `[A-Za-z0-9_-]`. Make it unguessable, e.g. `req_<random>`. It contains no data. `doc-intake` stores the submission under it; only the user who submitted it can write to it.
- `types` lists the documents to collect: `passport`, `id_card`, `payslip`, `bank_statement` or `generic`.
- When the user says "done" in the chat, the agent calls `status({ request_id })` to see which fields arrived and were verified, or `evaluate({ request_id, rules })` for yes/no decisions such as "net pay ≥ 3000" or "over 18". Both return no values. See `pnpm t3:agent-status`.

## Payload your contract receives (`pde.submission/v1`)

```json
{
  "schema": "pde.submission/v1",
  "request_id": "req_123",
  "documents": [
    {
      "doc_type": "passport",
      "fields": {
        "document_number": { "value": "SPECI2021", "source": "mrz", "validated": true, "validated_by": ["mrz.check_digits"], "user_edited": false },
        "surname": { "value": "DE VRIES", "source": "mrz", "validated": true, "validated_by": ["mrz.viz_match.surname"], "user_edited": false }
      },
      "checks": [{ "id": "mrz.check_digits", "ok": true }]
    }
  ],
  "client": { "name": "private-doc-scanner", "version": "0.1.0", "engine": "web" },
  "created_at": "2025-04-01T00:00:00.000Z"
}
```

Recommended contract behaviour:

- Re-run the deterministic checks: MRZ check digits (needs the document number, date of birth and expiry), IBAN mod-97, and payslip/statement arithmetic.
- Treat `validated: false` or `user_edited: true` as self-attested.
- Keep the 2 MiB JSON input limit in mind. A submission is a few KB.

## Field keys per document type

| Type | Keys |
|---|---|
| `passport`, `id_card` | `document_number`, `surname`, `given_names`, `nationality`, `date_of_birth`, `sex`, `date_of_expiry`, `issuing_country`, `personal_number` |
| `payslip` | `employer_name`, `employee_name`, `employee_id`, `pay_period` (`start/end`), `pay_date`, `gross_pay`, `total_deductions`, `net_pay` |
| `bank_statement` | `account_holder`, `iban`, `account_number`, `statement_period`, `opening_balance`, `total_credits`, `total_debits`, `closing_balance` |
| `generic` | `Label: value` pairs found on the page (always reviewed) |

Formats:

- Dates are ISO `YYYY-MM-DD`.
- Amounts are decimal strings with 2 places (`"4000.00"`).
- `sex` is `male`, `female` or `nonspecified`.
