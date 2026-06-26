#!/usr/bin/env node
/**
 * hive-mcp-imprimatur — Imprimatur pre-attestation gate MCP Server
 *
 * Every other Hive primitive signs a receipt AFTER the model runs. Imprimatur
 * signs a clearance BEFORE it runs: four compliance pre-conditions are checked
 * and Ed25519-signed at execution time, and an inference that cannot present a
 * valid, unexpired clearance is refused. A flight recorder proves what crashed;
 * a clearance stops the takeoff.
 *
 * Discipline: Imprimatur asserts pre_clearance_conditions_met. It NEVER asserts
 * legality. The enterprise defines policy; Hive enforces it and signs that the
 * enforcement ran and passed.
 *
 * This MCP server is a thin, read-only public shim over the live Imprimatur
 * surface. It exposes the safe operations only:
 *   - imprimatur_info     describe the gate, issuer key, pre-conditions
 *   - gate                enforce: ALLOW a call that presents a valid clearance,
 *                         REFUSE one that cannot (public, no secret)
 *   - verify_clearance    verify a presented clearance's signature/root/expiry
 *   - get_pubkey          the Ed25519 issuer public key for offline verification
 * Issuance (/clear) is ops-gated and intentionally NOT exposed here.
 *
 * Patent Pending. Hive Civilization. Settlement in USDC on Base.
 * Streamable-HTTP, JSON-RPC 2.0, MCP 2024-11-05. Inbound only.
 */
import express from 'express';

const SERVICE      = 'hive-mcp-imprimatur';
const VERSION      = '1.0.0';
const PORT         = process.env.PORT || 3000;
const ENABLE       = (process.env.ENABLE ?? 'true') !== 'false';
const BRAND_GOLD   = '#C08D23';
const IMPR_BASE    = process.env.HIVE_IMPRIMATUR_URL || 'https://hive-passport.onrender.com';
const INFO_PATH    = '/v1/imprimatur/info';
const GATE_PATH    = '/v1/imprimatur/gate';
const PUBKEY_PATH  = '/v1/prov/pubkey';

async function callUpstream(path, { method = 'GET', body = null } = {}) {
  const opts = { method, headers: { 'Origin': 'https://thehiveryiq.com' }, signal: AbortSignal.timeout(30_000) };
  if (body != null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(`${IMPR_BASE}${path}`, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok && r.status !== 401 && r.status !== 403) {
    // gate REFUSE comes back 200; only treat hard upstream errors as throws
    if (r.status >= 500) throw new Error(`upstream ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  }
  return { status: r.status, data };
}

// ─── Tools ──────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'imprimatur_info',
    description: 'Describe the Imprimatur pre-attestation gate (free). Returns the issuer DID, Ed25519 public key, the four pre-conditions (model_approved, inputs_eligible, context_permitted, boundary_authorized), the assertion discipline (asserts pre_clearance_conditions_met, never legality), and the two modes (gate, passport). No input required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gate',
    description: 'Enforce the gate on an inference call (free, public, no secret). Present the clearance an inference is carrying and Imprimatur returns ALLOW if it is valid and unexpired, or REFUSE if it is missing, tampered, expired, or does not match. An uncleared call is refused — that refusal is the control. Pass {clearance} (the signed clearance object the call presents) and optionally {now} (ISO timestamp). Returns {decision, reason, note}.',
    inputSchema: {
      type: 'object',
      properties: {
        clearance: { type: 'object', description: 'The signed clearance object the inference is presenting. Omit to test the uncleared-call refusal.' },
        now:       { type: 'string', description: 'Optional ISO-8601 timestamp to evaluate expiry against.' },
      },
    },
  },
  {
    name: 'verify_clearance',
    description: 'Verify a presented clearance offline-style (free, no secret). Runs the gate verification path: checks the Ed25519 signature against the published issuer key, re-derives the precond_root, confirms the assertion discipline (pre_clearance_conditions_met, asserts_legal:false), and checks expiry. Returns the gate decision and reason. Pass {clearance}.',
    inputSchema: {
      type: 'object',
      properties: {
        clearance: { type: 'object', description: 'The signed clearance object to verify.' },
      },
      required: ['clearance'],
    },
  },
  {
    name: 'get_pubkey',
    description: 'Get the Imprimatur issuer Ed25519 public key and metadata for offline verification (free). Returns the public key, issuer DID, and algorithm. Anyone can verify a clearance against this key with no shared secret.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function executeTool(name, args) {
  if (name === 'imprimatur_info') {
    const { data } = await callUpstream(INFO_PATH);
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'gate') {
    const body = {};
    if (args.clearance) body.clearance = args.clearance;
    if (args.now) body.now = args.now;
    const { data } = await callUpstream(GATE_PATH, { method: 'POST', body });
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  if (name === 'verify_clearance') {
    if (!args.clearance || typeof args.clearance !== 'object') throw new Error('Provide a "clearance" object to verify.');
    const { data } = await callUpstream(GATE_PATH, { method: 'POST', body: { clearance: args.clearance } });
    const verified = data && data.decision === 'ALLOW';
    return { type: 'text', text: JSON.stringify({
      verified,
      decision: data?.decision,
      reason: data?.reason,
      note: verified
        ? 'Clearance verified — signature, precond_root, discipline, and expiry all pass.'
        : 'Clearance did not verify — see reason. An uncleared or invalid call is refused.',
      assertion: 'pre_clearance_conditions_met',
      does_not_assert: 'legal',
    }, null, 2) };
  }
  if (name === 'get_pubkey') {
    const { data } = await callUpstream(PUBKEY_PATH);
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── HTTP / MCP ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE, version: VERSION, enabled: ENABLE }));

app.get('/', (_req, res) => res.json({
  service: SERVICE,
  version: VERSION,
  description: 'Imprimatur pre-attestation gate MCP server. A signed clearance is bound to an inference BEFORE it runs; an uncleared call is refused. Asserts policy, never legality. Patent Pending. Hive Civilization.',
  endpoints: { mcp: '/mcp', well_known: '/.well-known/mcp.json', health: '/health' },
  upstream: IMPR_BASE,
  preconditions: ['model_approved', 'inputs_eligible', 'context_permitted', 'boundary_authorized'],
  assertion: 'pre_clearance_conditions_met',
  does_not_assert: 'legal',
  settlement: { currency: 'USDC', chain: 'Base' },
  brand_color: BRAND_GOLD,
}));

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVICE, version: VERSION, description: 'Imprimatur pre-attestation gate. A signed clearance before the inference runs; an uncleared call is refused. Ed25519, verifiable offline. Asserts policy, never legality. Patent Pending. Hive Civilization.' },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (!ENABLE) return res.json({ jsonrpc: '2.0', id, error: { code: 503, message: 'service_disabled' } });
        try {
          const out = await executeTool(name, args || {});
          return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
        } catch (err) {
          return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
        }
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: err.message } });
  }
});

app.get('/.well-known/mcp.json', (_req, res) => res.json({
  name: SERVICE,
  version: VERSION,
  protocol: '2024-11-05',
  transport: 'streamable-http',
  endpoint: '/mcp',
  description: 'Imprimatur pre-attestation gate. Enforce a clearance on an inference before it runs, verify it offline, read the issuer key. Ed25519. Asserts policy, never legality. Patent Pending. Hive Civilization.',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
  brand_color: BRAND_GOLD,
}));

app.get('/.well-known/agent.json', (_req, res) => res.json({
  name: SERVICE,
  description: 'Imprimatur pre-attestation gate for the Hive agent economy. A signed clearance is bound to a call before it runs; an uncleared call is refused. Ed25519, verifiable offline.',
  url: `https://${SERVICE}.onrender.com`,
  provider: { organization: 'Hive Civilization', url: 'https://www.thehiveryiq.com', contact: 'steve@thehiveryiq.com' },
  capabilities: ['pre-attestation', 'inference-gating', 'clearance-verification', 'provenance'],
  tools: TOOLS.map(t => t.name),
  brand_color: BRAND_GOLD,
}));

if (!ENABLE) console.log(`[${SERVICE}] ENABLE=false — dormant (health only)`);
app.listen(PORT, () => console.log(`[${SERVICE}] v${VERSION} listening on :${PORT} -> ${IMPR_BASE}`));
