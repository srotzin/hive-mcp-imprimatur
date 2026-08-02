#!/usr/bin/env bash
# smoke.sh: hive-mcp-imprimatur local smoke test
#
# Tests: /health, /.well-known/mcp.json, honest 404, tools/list (4 tools),
#        tools/call imprimatur_info, tools/call gate (uncleared refusal),
#        tools/call verify_clearance (honest limitation text present).
#
# Exits 0 on success, 1 on any failure.

set -uo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

fuser -k "${PORT}/tcp" 2>/dev/null || true
command -v node >/dev/null 2>&1 || { echo "node not found, aborting"; exit 1; }

if [ ! -d "${SCRIPT_DIR}/node_modules" ]; then
  info "Installing dependencies…"
  npm install --omit=dev --no-audit --no-fund --silent
fi

node server.js > /tmp/hive-mcp-imprimatur-smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; exit' INT TERM EXIT

info "Waiting for server to be ready…"
for i in $(seq 1 20); do
  if curl -sf "${BASE}/health" >/dev/null 2>&1; then
    info "Server ready after ${i} attempts"
    break
  fi
  sleep 0.5
done

jsonrpc() {
  local method="$1"
  local params="$2"
  curl -sf -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "${BASE}/mcp"
}

info "Test 1: GET /health"
HEALTH=$(curl -sf "${BASE}/health") || fail "GET /health failed"
echo "$HEALTH" | grep -q '"status":"ok"' && ok "GET /health → status ok" || fail "GET /health unexpected: $HEALTH"

info "Test 2: GET /.well-known/mcp.json"
MCP_JSON=$(curl -sf "${BASE}/.well-known/mcp.json") || fail "GET /.well-known/mcp.json failed"
echo "$MCP_JSON" | grep -q '"endpoint":"/mcp"' && ok "well-known → endpoint present" || fail "well-known → endpoint missing"

info "Test 3: honest 404"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/does-not-exist")
[ "$CODE" = "404" ] && ok "GET /does-not-exist → 404" || fail "GET /does-not-exist → ${CODE} (expected 404)"

info "Test 4: tools/list"
TOOLS_RESP=$(jsonrpc "tools/list" "{}") || fail "tools/list RPC failed"
TOOLS_N=$(echo "$TOOLS_RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['result']['tools']))" 2>/dev/null || echo 0)
[ "$TOOLS_N" -eq 4 ] 2>/dev/null && ok "tools/list → 4 tools" || fail "tools/list → ${TOOLS_N} tools (expected 4)"
for TOOL in imprimatur_info gate verify_clearance get_pubkey; do
  echo "$TOOLS_RESP" | grep -q "\"name\":\"${TOOL}\"" && ok "tools/list → '${TOOL}' present" || fail "tools/list → '${TOOL}' MISSING"
done

info "Test 5: tools/call imprimatur_info (live upstream)"
INFO_RESP=$(jsonrpc "tools/call" '{"name":"imprimatur_info","arguments":{}}') || fail "imprimatur_info call failed"
echo "$INFO_RESP" | grep -q 'pre_clearance_conditions_met' && ok "imprimatur_info → assertion discipline present" || fail "imprimatur_info unexpected: $INFO_RESP"

info "Test 6: tools/call gate with no clearance (uncleared refusal)"
GATE_RESP=$(jsonrpc "tools/call" '{"name":"gate","arguments":{}}') || fail "gate call failed"
echo "$GATE_RESP" | grep -q 'REFUSE' && ok "gate → uncleared call refused" || fail "gate unexpected: $GATE_RESP"

info "Test 7: tools/call verify_clearance states the honest limitation"
VERIFY_RESP=$(jsonrpc "tools/call" '{"name":"verify_clearance","arguments":{"clearance":{}}}') || fail "verify_clearance call failed"
echo "$VERIFY_RESP" | grep -q 'verification_limitation' && ok "verify_clearance → limitation disclosed" || fail "verify_clearance → limitation text missing: $VERIFY_RESP"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Passed: ${GREEN}${PASS}${NC}  Failed: ${RED}${FAIL}${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}SMOKE TEST FAILED${NC}"
  exit 1
fi
echo -e "${GREEN}SMOKE TEST PASSED${NC}"
exit 0
