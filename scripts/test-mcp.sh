#!/usr/bin/env bash
#
# test-mcp.sh — smoke-test every khipuchat MCP tool over stdio.
#
# Spawns the MCP server exactly as Claude Desktop would (stdio JSON-RPC),
# sends `initialize`, `tools/list`, and one `tools/call` per tool with a
# sample query, then prints each response. Intended for debugging: confirm
# the server starts, lists all tools, and every handler returns valid JSON.
#
# Usage:
#   scripts/test-mcp.sh            # run against the project's khipuchat.db
#   MCP_CMD="khipu mcp" scripts/test-mcp.sh
#   MCP_SECRET=... scripts/test-mcp.sh   # exercise bearer-token auth path
#
# Requires: node + tsx (default), or a global `khipu`. `jq` is optional
# (used for pretty per-tool output; raw JSON is printed when absent).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# How to launch the server. Default mirrors `npm run mcp` (tsx src/mcp.ts) so
# the script works without a global install; override with MCP_CMD="khipu mcp".
MCP_CMD="${MCP_CMD:-node_modules/.bin/tsx src/mcp.ts}"
TIMEOUT_SECS="${TIMEOUT_SECS:-20}"

have_jq() { command -v jq >/dev/null 2>&1; }

# Portable timeout: GNU `timeout` (Linux), `gtimeout` (macOS coreutils), or
# none (macOS default). The stdio server exits on stdin EOF on its own, so the
# no-timeout path still terminates; the timeout only guards against a hung
# handler. Usage: run_server < payload
run_server() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${TIMEOUT_SECS}" ${MCP_CMD}
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${TIMEOUT_SECS}" ${MCP_CMD}
  else
    ${MCP_CMD}
  fi
}

# _meta.authorization is required on every call when MCP_SECRET is set.
auth_meta=""
if [[ -n "${MCP_SECRET:-}" ]]; then
  auth_meta=", \"_meta\": {\"authorization\": \"Bearer ${MCP_SECRET}\"}"
fi

# Each entry: id | label | method | params-json
# ids are used to correlate responses back to the request that produced them.
requests=(
  '1|initialize|initialize|{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-mcp.sh","version":"1.0"}}'
  '2|tools/list|tools/list|{}'
  '3|list_chats|tools/call|{"name":"list_chats","arguments":{"limit":5}}'
  '4|find_chat_by_name|tools/call|{"name":"find_chat_by_name","arguments":{"name":"a"}}'
  '5|list_messages (archive-wide)|tools/call|{"name":"list_messages","arguments":{"limit":5}}'
  '6|search_messages|tools/call|{"name":"search_messages","arguments":{"query":"the","limit":3}}'
  '7|get_chat_summary|tools/call|{"name":"get_chat_summary","arguments":{"chat_id":1}}'
  '8|semantic_find_contacts (needs index)|tools/call|{"name":"semantic_find_contacts","arguments":{"query":"an old friend","limit":3}}'
  '9|semantic_search_messages (needs index)|tools/call|{"name":"semantic_search_messages","arguments":{"query":"dinner plans","limit":3}}'
  '10|get_image|tools/call|{"name":"get_image","arguments":{"message_id":1}}'
)

# Build the newline-delimited JSON-RPC request stream.
payload=""
for r in "${requests[@]}"; do
  IFS='|' read -r id _label method params <<<"$r"
  # Splice auth meta into params objects that carry `arguments` (tools/call).
  if [[ -n "$auth_meta" && "$params" == *'"arguments"'* ]]; then
    params="${params%\}}${auth_meta}}"
  fi
  payload+="{\"jsonrpc\":\"2.0\",\"id\":${id},\"method\":\"${method}\",\"params\":${params}}"$'\n'
done

echo "▶ Launching MCP server: ${MCP_CMD}"
echo "  DB: ${ROOT}/khipuchat.db"
[[ -n "${MCP_SECRET:-}" ]] && echo "  Auth: bearer token enabled (MCP_SECRET set)"
echo

# Feed all requests, close stdin, and capture stdout. The stdio transport
# ends when stdin closes; a timeout guards against a hung handler.
raw="$(printf '%s' "$payload" | { run_server 2>/dev/null || true; })"

if [[ -z "$raw" ]]; then
  echo "✗ No output from MCP server. Is tsx installed (npm install) and khipuchat.db present?" >&2
  exit 1
fi

# Print one labeled block per response line, correlated by JSON-RPC id.
fail=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if have_jq; then
    id="$(printf '%s' "$line" | jq -r '.id // "?"' 2>/dev/null || echo '?')"
  else
    id="$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)"
    id="${id:-?}"
  fi
  label="?"
  for r in "${requests[@]}"; do
    IFS='|' read -r rid rlabel _m _p <<<"$r"
    [[ "$rid" == "$id" ]] && label="$rlabel" && break
  done

  echo "──────────────────────────────────────────────"
  echo "[$id] ${label}"
  if printf '%s' "$line" | { have_jq && jq -e '.error' >/dev/null 2>&1; }; then
    echo "  ⚠ error response:"
    fail=1
  fi
  if have_jq; then
    printf '%s' "$line" | jq '.' 2>/dev/null || printf '%s\n' "$line"
  else
    printf '%s\n' "$line"
  fi
done <<<"$raw"

echo "──────────────────────────────────────────────"
if [[ "$fail" -eq 0 ]]; then
  echo "✓ All tools responded. Review output above for expected data."
else
  echo "⚠ One or more tools returned an error — see blocks marked above."
fi
