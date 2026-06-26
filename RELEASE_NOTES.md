# v1.0.0 — HiveImprimatur MCP Server

First public release of the Imprimatur pre-attestation gate as an MCP server.

**Imprimatur is the control, not the record.** Every other Hive primitive signs a receipt after the model runs. Imprimatur signs a clearance before it runs, and an inference that cannot present a valid, unexpired clearance is refused.

## Tools
- `imprimatur_info` — describe the gate, issuer key, four pre-conditions, two modes.
- `gate` — enforce ALLOW / REFUSE on a presented clearance. Public, no secret.
- `verify_clearance` — verify signature, precond_root, discipline, and expiry.
- `get_pubkey` — Ed25519 issuer public key for offline verification.

## Discipline
Asserts `pre_clearance_conditions_met`. Never asserts legality. The enterprise defines policy; Hive enforces and signs that the enforcement ran and passed.

Streamable-HTTP, JSON-RPC 2.0, MCP 2024-11-05. Patent Pending. Hive Civilization. USDC on Base.
