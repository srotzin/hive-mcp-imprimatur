# hive-mcp-imprimatur

**Imprimatur — the pre-attestation gate.** A signed clearance bound to an inference *before* it runs. Four compliance pre-conditions are checked and Ed25519-signed at execution time, and an inference that cannot present a valid, unexpired clearance is refused.

> A flight recorder proves what crashed. A clearance stops the takeoff.

Every other Hive primitive signs a receipt **after** the model runs. Imprimatur signs a clearance **before** it runs. It is the control, not the record.

**Discipline:** Imprimatur asserts `pre_clearance_conditions_met`. It never asserts legality. The enterprise defines policy; Hive enforces it and signs that the enforcement ran and passed.

This MCP server is a thin, read-only public shim over the live Imprimatur surface. Issuance (`/clear`) is ops-gated and intentionally not exposed here.

## Tools

| Tool | What it does |
|---|---|
| `imprimatur_info` | Describe the gate: issuer key, four pre-conditions, assertion discipline, two modes. |
| `gate` | Enforce. ALLOW a call presenting a valid clearance; REFUSE one that cannot. Public, no secret. |
| `verify_clearance` | Verify a presented clearance: signature, precond_root, discipline, expiry. |
| `get_pubkey` | The Ed25519 issuer public key for offline verification. |

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

1. `model_approved` — the model is on the approved list (composable with MiR).
2. `inputs_eligible` — the inputs are eligible for this context (composable with RCP).
3. `context_permitted` — the context/purpose is permitted.
4. `boundary_authorized` — the jurisdiction / data boundary is authorized.

All four must pass for a clearance to issue. The gate refuses anything that cannot present one.

---

Patent Pending. Hive Civilization. Settlement in USDC on Base. MIT licensed.
