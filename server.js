#!/usr/bin/env node
/**
 * hive-mcp-imprimatur: Imprimatur pre-attestation gate MCP Server
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
const VERSION      = '1.1.0';
const PORT         = process.env.PORT || 3000;
const ENABLE       = (process.env.ENABLE ?? 'true') !== 'false';
const BRAND_GOLD   = '#C08D23';
const IMPR_BASE    = process.env.HIVE_IMPRIMATUR_URL || 'https://hive-passport.onrender.com';
const INFO_PATH    = '/v1/imprimatur/info';
const GATE_PATH    = '/v1/imprimatur/gate';
const PUBKEY_PATH  = '/v1/prov/pubkey';

// ─── Environment validation (fail closed) ──────────────────────────────────
function validateEnv() {
  const errors = [];
  try {
    const u = new URL(IMPR_BASE);
    if (!/^https?:$/.test(u.protocol)) errors.push(`HIVE_IMPRIMATUR_URL must be http(s): got "${IMPR_BASE}"`);
  } catch {
    errors.push(`HIVE_IMPRIMATUR_URL is not a valid URL: "${IMPR_BASE}"`);
  }
  const portNum = Number(PORT);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
    errors.push(`PORT must be a valid TCP port: got "${PORT}"`);
  }
  return errors;
}

const ENV_ERRORS = validateEnv();
if (ENV_ERRORS.length > 0) {
  console.error(`[${SERVICE}] FATAL: invalid environment, refusing to start:`);
  for (const e of ENV_ERRORS) console.error(`  - ${e}`);
  process.exit(1);
}

async function callUpstream(path, { method = 'GET', body = null } = {}) {
  const opts = { method, headers: { 'Origin': 'https://thehiveryiq.com' }, signal: AbortSignal.timeout(30_000) };
  if (body != null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try {
    r = await fetch(`${IMPR_BASE}${path}`, opts);
  } catch (err) {
    throw new Error(`upstream ${path} unreachable: ${err?.message || err}`);
  }
  const text = await r.text();
  // Fail closed on every non-2xx. A gate REFUSE is a documented, verified
  // live behavior of this upstream and comes back as HTTP 200 with
  // {decision:"REFUSE", reason, note} in the body, never as a 401/403; on
  // this deployment a 401 is what an unknown/misrouted path returns, so
  // treating 401/403 as an implicit REFUSE silently passed through real
  // upstream errors as if they were valid tool results. There is no
  // legitimate non-2xx REFUSE signal to special-case here.
  if (!r.ok) throw new Error(`upstream ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  if (text === '') throw new Error(`upstream ${path} -> ${r.status}: empty body`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`upstream ${path} -> ${r.status}: non-JSON body`); }
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
    description: 'Enforce the gate on an inference call (free, public, no secret). Present the clearance an inference is carrying and Imprimatur returns ALLOW if it is valid and unexpired, or REFUSE if it is missing, tampered, expired, or does not match. An uncleared call is refused; that refusal is the control. LIMITATION: ALLOW is a live server-side decision, not an offline-checkable proof: a caller cannot independently re-derive or verify an ALLOW without calling this upstream gate; only REFUSE-by-absence (no clearance presented) is trivially and universally true. Pass {clearance} (the signed clearance object the call presents) and optionally {now} (ISO timestamp). Returns {decision, reason, note}.',
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
    description: 'Ask the live Imprimatur gate to evaluate a presented clearance (free, no secret). IMPORTANT LIMITATION: this is NOT an offline/local verification. The ALLOW/REFUSE decision can only be produced by calling the upstream issuer (it holds the current precondition state, revocation status, and expiry clock), so this tool makes a live network call to the same gate endpoint as the `gate` tool and reports its answer. There is no cryptographic proof a caller can check locally that would let them independently confirm ALLOW without trusting this live call; unlike SiGR receipts, an Imprimatur ALLOW is not self-certifying. What IS independently checkable offline is the Ed25519 transport signature Hive Passport attaches to every HTTP response (X-Hive-Prov-Sig headers over pubkey /v1/prov/pubkey); that only proves the response body was not altered in transit, not that the ALLOW decision is externally re-derivable. Pass {clearance}.',
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
    const allowed = data && data.decision === 'ALLOW';
    return { type: 'text', text: JSON.stringify({
      decision: data?.decision,
      reason: data?.reason,
      note: allowed
        ? 'Upstream returned ALLOW for this clearance right now.'
        : 'Upstream returned REFUSE, see reason. An uncleared or invalid call is refused.',
      verification_limitation: 'This result comes from a live call to the upstream Imprimatur gate, not from an offline cryptographic check performed here. ALLOW/REFUSE depends on server-side state (current preconditions, revocation, expiry clock) that a caller cannot independently re-derive from public data alone. Do not treat this tool\'s output as an externally provable, offline-verifiable proof of ALLOW; it is only as trustworthy as the live upstream call that produced it.',
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
  verification_limitation: 'ALLOW decisions are produced live by the upstream issuer and are not externally/offline provable by a caller. Only the upstream Ed25519 transport signature on each HTTP response is offline-checkable, and it proves transport integrity, not that a given ALLOW is independently re-derivable.',
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

// Honest 404: no fabricated success on unknown routes.
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path, service: SERVICE });
});

if (!ENABLE) console.log(`[${SERVICE}] ENABLE=false (dormant, health only)`);

// Only bind a port when this file is run directly (node server.js), not when
// it is imported as a module, for example from the test suite.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  app.listen(PORT, () => console.log(`[${SERVICE}] v${VERSION} listening on :${PORT} -> ${IMPR_BASE}`));
}

export default app;
