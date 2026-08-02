# hive-mcp-imprimatur

**Imprimatur: the pre-attestation gate.** A signed clearance bound to an inference *before* it runs. Four compliance pre-conditions are checked and Ed25519-signed at execution time, and an inference that cannot present a valid, unexpired clearance is refused.

> A flight recorder proves what crashed. A clearance stops the takeoff.

Every other Hive primitive signs a receipt **after** the model runs. Imprimatur signs a clearance **before** it runs. It is the control, not the record.

**Discipline:** Imprimatur asserts `pre_clearance_conditions_met`. It never asserts legality. The enterprise defines policy; Hive enforces it and signs that the enforcement ran and passed.

This MCP server is a thin, read-only public shim over the live Imprimatur surface. Issuance (`/clear`) is ops-gated and intentionally not exposed here.

## Tools

| Tool | What it does |
|---|---|
| `imprimatur_info` | Describe the gate: issuer key, four pre-conditions, assertion discipline, two modes. |
| `gate` | Enforce. ALLOW a call presenting a valid clearance; REFUSE one that cannot. Public, no secret. |
| `verify_clearance` | Ask the live gate to evaluate a presented clearance. **Not an offline check**, see limitation below. |
| `get_pubkey` | The Ed25519 issuer public key (verifies transport signatures offline, not ALLOW decisions). |

### Verification limitation (read before you rely on this)

An Imprimatur **ALLOW** decision is produced live, server-side, by the upstream issuer at the moment of the call. It depends on state a caller cannot see or reconstruct independently: the current precondition status, revocation state, and the expiry clock. That means:

- `gate` and `verify_clearance` both make a live network call to the same upstream `/v1/imprimatur/gate` endpoint. Neither tool performs a local, offline cryptographic check that could stand on its own.
- There is no public algorithm a third party can run against a clearance object alone and get a trustworthy ALLOW/REFUSE without asking the live issuer.
- What IS independently, offline verifiable is the Ed25519 **transport** signature Hive Passport attaches to every HTTP response (`X-Hive-Prov-Sig` over `/v1/prov/pubkey`). That only proves the response bytes weren't altered in transit. It does not make the ALLOW decision itself externally provable.
- This is different from SiGR, where the signed envelope is self-certifying and verifiable offline with no callback. Imprimatur's ALLOW is not self-certifying in that sense, and this README and the tool descriptions say so explicitly rather than implying otherwise.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | JSON-RPC 2.0, MCP 2024-11-05, Streamable-HTTP |
| `GET /health` | Liveness |
| `GET /.well-known/mcp.json` | MCP discovery |
| `GET /.well-known/agent.json` | Agent discovery |

Upstream: `https://hive-passport.onrender.com/v1/imprimatur/*`

## Connect

Streamable-HTTP MCP server. Point your client at the deployed `/mcp` endpoint:

```json
{
  "mcpServers": {
    "imprimatur": { "url": "https://hive-mcp-imprimatur.onrender.com/mcp" }
  }
}
```

Run locally:

```bash
npm install
node server.js
# POST http://localhost:3000/mcp
```

## The four pre-conditions

1. `model_approved`: the model is on the approved list (composable with MiR).
2. `inputs_eligible`: the inputs are eligible for this context (composable with RCP).
3. `context_permitted`: the context/purpose is permitted.
4. `boundary_authorized`: the jurisdiction / data boundary is authorized.

All four must pass for a clearance to issue. The gate refuses anything that cannot present one.

---

Patent Pending. Hive Civilization. Settlement in USDC on Base. MIT licensed.
