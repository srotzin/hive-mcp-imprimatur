// Test suite for hive-mcp-imprimatur upstream fail-closed behavior.
//
// Uses Node's built in test runner and assert module (no new dependency).
// Run with: npm test (invokes `node --test test/`)
//
// The relay must fail closed on every non-2xx upstream response, and must
// never fabricate or pass through a success result the upstream did not
// actually produce. These tests stub the global fetch used by
// callUpstream so no real network call to hive-passport.onrender.com
// happens from this suite.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.HIVE_IMPRIMATUR_URL = process.env.HIVE_IMPRIMATUR_URL || 'https://hive-passport.example.invalid';

let app;
let server;
let baseUrl;
const originalFetch = globalThis.fetch;

before(async () => {
  const mod = await import('../server.js');
  app = mod.default;
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubUpstream(handler) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, opts);
    return handler(String(url), opts);
  };
}

async function jsonRpc(method, params) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

async function callTool(name, args) {
  return jsonRpc('tools/call', { name, arguments: args });
}

// ─── positive path ──────────────────────────────────────────────────────────

test('gate: upstream 2xx JSON ALLOW decision is relayed as the tool result', async () => {
  const decision = { ok: true, decision: 'ALLOW', reason: 'valid_clearance' };
  stubUpstream(async () => new Response(JSON.stringify(decision), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('gate', { clearance: { sig: 'abc' } });
  assert.ok(body.result, 'a valid 2xx JSON response must be relayed as a result');
  const parsed = JSON.parse(body.result.content[0].text);
  assert.deepEqual(parsed, decision);
});

test('gate: upstream 2xx JSON REFUSE decision is relayed as the tool result, not treated as an error', async () => {
  const decision = { ok: true, decision: 'REFUSE', reason: 'no_clearance_presented', note: 'No verifiable clearance was presented.' };
  stubUpstream(async () => new Response(JSON.stringify(decision), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('gate', {});
  assert.ok(body.result, 'a live REFUSE decision is a normal 200 response and must be relayed, not treated as a relay-level error');
  const parsed = JSON.parse(body.result.content[0].text);
  assert.equal(parsed.decision, 'REFUSE');
});

test('get_pubkey: upstream 2xx JSON response is relayed as the tool result', async () => {
  const pubkey = { pubkey: 'deadbeef', issuer_did: 'did:hive:imprimatur', algorithm: 'Ed25519' };
  stubUpstream(async () => new Response(JSON.stringify(pubkey), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.result);
  assert.deepEqual(JSON.parse(body.result.content[0].text), pubkey);
});

test('imprimatur_info: upstream 2xx JSON response is relayed as the tool result', async () => {
  const info = { issuer_did: 'did:hive:imprimatur', preconditions: ['model_approved'] };
  stubUpstream(async () => new Response(JSON.stringify(info), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('imprimatur_info', {});
  assert.ok(body.result);
  assert.deepEqual(JSON.parse(body.result.content[0].text), info);
});

// ─── upstream non-2xx: this is the confirmed defect ────────────────────────

test('DEFECT REGRESSION: gate fails closed on a 400 instead of relaying the error body as a success result', async () => {
  // Before the fix, callUpstream only threw for status >= 500 (and treated
  // 401/403 as an implicit REFUSE), so a 400 from a malformed request was
  // returned as {status, data} and relayed to the MCP caller as a normal
  // tools/call result, not a JSON-RPC error.
  stubUpstream(async () => new Response(JSON.stringify({ error: 'bad request', detail: 'malformed clearance' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('gate', { clearance: { bad: 'shape' } });
  assert.ok(body.error, 'a 400 from the upstream gate must produce a JSON-RPC error, never a fabricated tools/call result');
  assert.equal(body.result, undefined);
  assert.match(body.error.message, /400/);
});

test('DEFECT REGRESSION: gate fails closed on a 401, which this upstream uses for unknown/misrouted paths, not for REFUSE', async () => {
  // Verified live against the real upstream: an unknown path on
  // hive-passport.onrender.com returns 401, while an actual REFUSE
  // decision comes back as 200 with decision:"REFUSE" in the body. The
  // pre-fix code treated any 401/403 as an implicit, harmless REFUSE and
  // let it through unthrown, which would have silently swallowed a real
  // routing or auth failure as if it were a normal decision.
  stubUpstream(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('gate', { clearance: {} });
  assert.ok(body.error, 'a 401 must fail closed, it is not a documented REFUSE signal on this upstream');
  assert.equal(body.result, undefined);
});

test('DEFECT REGRESSION: gate fails closed on a 403', async () => {
  stubUpstream(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('gate', { clearance: {} });
  assert.ok(body.error, 'a 403 must fail closed');
  assert.equal(body.result, undefined);
});

test('DEFECT REGRESSION: gate fails closed on a 422', async () => {
  stubUpstream(async () => new Response(JSON.stringify({ error: 'unprocessable' }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('gate', { clearance: {} });
  assert.ok(body.error, 'a 422 must fail closed');
});

test('verify_clearance: upstream non-2xx fails closed, never reports a decision', async () => {
  stubUpstream(async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('verify_clearance', { clearance: { sig: 'abc' } });
  assert.ok(body.error);
  assert.equal(body.result, undefined);
});

test('get_pubkey: upstream 500 fails closed', async () => {
  stubUpstream(async () => new Response(JSON.stringify({ error: 'internal error' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.error);
});

test('imprimatur_info: upstream 404 fails closed', async () => {
  stubUpstream(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  const { body } = await callTool('imprimatur_info', {});
  assert.ok(body.error);
});

// ─── upstream non-JSON body ─────────────────────────────────────────────────

test('gate: upstream 2xx non-JSON body fails closed instead of wrapping raw text as a decision', async () => {
  stubUpstream(async () => new Response('<html>upstream misconfigured</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  const { body } = await callTool('gate', { clearance: {} });
  assert.ok(body.error, 'a non-JSON 200 body must never be fabricated into a {status, data} success result');
  assert.match(body.error.message, /non-JSON/);
});

test('get_pubkey: upstream 2xx non-JSON body fails closed', async () => {
  stubUpstream(async () => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.error);
  assert.match(body.error.message, /non-JSON/);
});

// ─── upstream empty body ────────────────────────────────────────────────────

test('gate: upstream 2xx empty body fails closed instead of returning an empty decision', async () => {
  stubUpstream(async () => new Response('', { status: 200 }));
  const { body } = await callTool('gate', { clearance: {} });
  assert.ok(body.error, 'an empty 200 body must never be treated as a valid gate decision');
  assert.match(body.error.message, /empty body/);
});

test('verify_clearance: upstream 2xx empty body fails closed', async () => {
  stubUpstream(async () => new Response('', { status: 200 }));
  const { body } = await callTool('verify_clearance', { clearance: { sig: 'x' } });
  assert.ok(body.error);
});

// ─── upstream unreachable / network error ───────────────────────────────────

test('gate: unreachable upstream fails closed with an honest error', async () => {
  stubUpstream(async () => { throw new Error('getaddrinfo ENOTFOUND hive-passport.example.invalid'); });
  const { body } = await callTool('gate', { clearance: {} });
  assert.ok(body.error, 'a network failure must never produce a fabricated decision');
  assert.match(body.error.message, /unreachable/);
});

test('get_pubkey: unreachable upstream fails closed', async () => {
  stubUpstream(async () => { throw new Error('connect ETIMEDOUT'); });
  const { body } = await callTool('get_pubkey', {});
  assert.ok(body.error);
});

test('imprimatur_info: unreachable upstream fails closed', async () => {
  stubUpstream(async () => { throw new Error('network error'); });
  const { body } = await callTool('imprimatur_info', {});
  assert.ok(body.error);
});

// ─── input validation still applies before any upstream call ──────────────

test('verify_clearance: missing clearance is rejected before contacting the upstream', async () => {
  let fetchCalled = false;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, opts);
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  };
  const { body } = await callTool('verify_clearance', {});
  assert.ok(body.error);
  assert.equal(fetchCalled, false, 'invalid input must be rejected before any upstream network call');
});

test('unknown tool name returns a JSON-RPC error, not a fabricated result', async () => {
  const { body } = await callTool('gate_does_not_exist', {});
  assert.ok(body.error);
  assert.equal(body.error.code, -32000);
});

// ─── structural checks ──────────────────────────────────────────────────────

test('GET /health reports service status without contacting the upstream', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'hive-mcp-imprimatur');
});

test('unknown route returns a real 404, not a fabricated 200', async () => {
  const res = await fetch(`${baseUrl}/this-path-does-not-exist`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error, 'not_found');
});

test('user facing text has no em dash or en dash', async () => {
  const paths = ['/health', '/.well-known/mcp.json', '/.well-known/agent.json', '/'];
  for (const path of paths) {
    const res = await fetch(`${baseUrl}${path}`);
    const text = await res.text();
    assert.ok(!text.includes('\u2014'), `${path} must not contain an em dash`);
    assert.ok(!text.includes('\u2013'), `${path} must not contain an en dash`);
  }
});
