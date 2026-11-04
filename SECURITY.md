# Security

Please report vulnerabilities privately to the maintainers (open a GitHub security advisory on this repository) rather than in a public issue. We are particularly interested in:

- any way document pixels, page text or field values can reach a network destination other than the sealed submission;
- ways to make the UI show "verified" for a value that is wrong;
- bypasses of the attestation check before sealing;
- CSP or service-worker weaknesses in the reference PWA.

See `docs/privacy-model.md` for the threat model and its known limits.
