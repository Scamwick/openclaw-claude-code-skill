#!/usr/bin/env bash
# =============================================================================
# integration-test.sh
# End-to-end integration test for claude-code-skill (CLI + server stack)
#
# Usage:
#   ./scripts/integration-test.sh           # Run non-live tests only
#   LIVE_TEST=1 ./scripts/integration-test.sh  # Include tests that call Claude API
#
# Requirements:
#   - claude-code-server and claude-code-skill must be in PATH (npm link)
#   - Port 18795 must be available (or set CLAUDE_CODE_PORT)
# =============================================================================

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

PORT="${CLAUDE_CODE_PORT:-18795}"
HOST="${CLAUDE_CODE_HOST:-127.0.0.1}"
BASE_URL="http://${HOST}:${PORT}"
PREFIX="/backend-api/claude-code"
API_URL="${BASE_URL}${PREFIX}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_SESSION_NAME="integ-test-$$"
SERVER_PID=""
LIVE_TEST="${LIVE_TEST:-0}"

# =============================================================================
# Colors and formatting
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# =============================================================================
# Test counters
# =============================================================================

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL_COUNT=0
FAILED_TESTS=()

# =============================================================================
# Utility functions
# =============================================================================

log_header() {
  echo ""
  echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}"
  echo -e "${CYAN}${BOLD}  $1${RESET}"
  echo -e "${CYAN}${BOLD}══════════════════════════════════════════════════════════════${RESET}"
}

log_section() {
  echo ""
  echo -e "${YELLOW}--- $1 ---${RESET}"
}

# run_test <test_name> <command_to_eval> <expected_pattern_in_output>
#
# Runs a CLI command (or curl), captures stdout+stderr, and checks that
# the output matches the expected grep pattern. Increments PASS or FAIL.
run_test() {
  local name="$1"
  local cmd="$2"
  local pattern="$3"

  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  printf "  %-55s " "$name"

  local output
  output=$(eval "$cmd" 2>&1 | sed $'s/\033\[[0-9;]*m//g') || true

  if echo "$output" | grep -qiE "$pattern"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo -e "[${GREEN}PASS${RESET}]"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_TESTS+=("$name")
    echo -e "[${RED}FAIL${RESET}]"
    echo -e "    ${RED}Expected pattern: ${pattern}${RESET}"
    echo -e "    ${RED}Got output (first 200 chars):${RESET}"
    echo "    $(echo "$output" | head -c 200)"
  fi
}

# run_test_status <test_name> <command> <expected_exit_code>
#
# Like run_test, but checks exit code instead of output pattern.
run_test_status() {
  local name="$1"
  local cmd="$2"
  local expected_code="$3"

  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  printf "  %-55s " "$name"

  local actual_code=0
  eval "$cmd" >/dev/null 2>&1 || actual_code=$?

  if [ "$actual_code" -eq "$expected_code" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo -e "[${GREEN}PASS${RESET}]"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_TESTS+=("$name")
    echo -e "[${RED}FAIL${RESET}]"
    echo -e "    ${RED}Expected exit code: ${expected_code}, got: ${actual_code}${RESET}"
  fi
}

# run_test_json <test_name> <curl_command> <jq_expression_that_should_be_true>
#
# Runs a curl command, pipes to jq, and checks if the jq expression outputs "true".
run_test_json() {
  local name="$1"
  local cmd="$2"
  local jq_expr="$3"

  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  printf "  %-55s " "$name"

  local output
  output=$(eval "$cmd" 2>/dev/null) || true

  local check
  check=$(echo "$output" | jq -r "$jq_expr" 2>/dev/null) || check="false"

  if [ "$check" = "true" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo -e "[${GREEN}PASS${RESET}]"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILED_TESTS+=("$name")
    echo -e "[${RED}FAIL${RESET}]"
    echo -e "    ${RED}jq expression: ${jq_expr}${RESET}"
    echo -e "    ${RED}Raw response (first 200 chars):${RESET}"
    echo "    $(echo "$output" | head -c 200)"
  fi
}

skip_test() {
  local name="$1"
  local reason="$2"

  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  SKIP_COUNT=$((SKIP_COUNT + 1))
  printf "  %-55s " "$name"
  echo -e "[${YELLOW}SKIP${RESET}] $reason"
}

wait_for_server() {
  local max_attempts=30
  local attempt=0
  echo -n "  Waiting for server to be ready"
  while [ $attempt -lt $max_attempts ]; do
    # Poll the /connect endpoint (POST) to see if the server is up
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "${API_URL}/connect" \
      -H "Content-Type: application/json" 2>/dev/null) || true
    if [ "$status" = "200" ]; then
      echo -e " ${GREEN}ready${RESET} (${attempt}s)"
      return 0
    fi
    echo -n "."
    sleep 1
    attempt=$((attempt + 1))
  done
  echo -e " ${RED}TIMEOUT${RESET}"
  return 1
}

# =============================================================================
# Cleanup trap
# =============================================================================

cleanup() {
  log_section "Cleanup"

  # Stop any test sessions that might still exist
  curl -s -X POST "${API_URL}/session/stop" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${TEST_SESSION_NAME}\"}" >/dev/null 2>&1 || true

  curl -s -X POST "${API_URL}/session/stop" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${TEST_SESSION_NAME}-fork\"}" >/dev/null 2>&1 || true

  # Disconnect from the server
  curl -s -X POST "${API_URL}/disconnect" \
    -H "Content-Type: application/json" >/dev/null 2>&1 || true

  # Kill the server process
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "  Stopping server (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    # Wait up to 5s for graceful shutdown
    local waited=0
    while kill -0 "$SERVER_PID" 2>/dev/null && [ $waited -lt 5 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    # Force kill if still running
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "  Force killing server..."
      kill -9 "$SERVER_PID" 2>/dev/null || true
    fi
    echo "  Server stopped."
  fi

  # Remove any temp files created during tests
  rm -f /tmp/integ-test-read-file-$$.txt 2>/dev/null || true
}

trap cleanup EXIT

# =============================================================================
# Preflight checks
# =============================================================================

log_header "Preflight Checks"

# Check for required binaries
echo "  Checking for claude-code-server..."
if ! command -v claude-code-server >/dev/null 2>&1; then
  echo -e "  ${RED}ERROR: claude-code-server not found in PATH${RESET}"
  echo "  Run: cd $PROJECT_ROOT && npm run build && npm link"
  exit 1
fi
echo -e "  ${GREEN}Found:${RESET} $(which claude-code-server)"

echo "  Checking for claude-code-skill..."
if ! command -v claude-code-skill >/dev/null 2>&1; then
  echo -e "  ${RED}ERROR: claude-code-skill not found in PATH${RESET}"
  echo "  Run: cd $PROJECT_ROOT && npm run build && npm link"
  exit 1
fi
echo -e "  ${GREEN}Found:${RESET} $(which claude-code-skill)"

# Check for curl and jq (used in raw API tests)
echo "  Checking for curl..."
if ! command -v curl >/dev/null 2>&1; then
  echo -e "  ${RED}ERROR: curl not found in PATH${RESET}"
  exit 1
fi
echo -e "  ${GREEN}Found:${RESET} $(which curl)"

echo "  Checking for jq..."
if ! command -v jq >/dev/null 2>&1; then
  echo -e "  ${RED}ERROR: jq not found in PATH${RESET}"
  echo "  Install: brew install jq"
  exit 1
fi
echo -e "  ${GREEN}Found:${RESET} $(which jq)"

# Check that the port is available
if curl -s -o /dev/null "http://${HOST}:${PORT}" 2>/dev/null; then
  echo -e "  ${RED}ERROR: Port ${PORT} is already in use${RESET}"
  echo "  Kill the existing server or set CLAUDE_CODE_PORT to a different port"
  exit 1
fi
echo -e "  ${GREEN}Port ${PORT} is available${RESET}"

# =============================================================================
# Start the server
# =============================================================================

log_header "Starting Server"

echo "  Launching claude-code-server on ${HOST}:${PORT}..."
claude-code-server > /tmp/claude-code-server-integ-$$.log 2>&1 &
SERVER_PID=$!
echo "  Server PID: $SERVER_PID"

# Wait for server to respond
if ! wait_for_server; then
  echo -e "  ${RED}Server failed to start. Log output:${RESET}"
  cat /tmp/claude-code-server-integ-$$.log 2>/dev/null || true
  exit 1
fi

# =============================================================================
# Test Suite 1: Raw API endpoint tests (curl)
# =============================================================================

log_header "Test Suite 1: Raw API Endpoints (curl)"

log_section "Connection"

run_test_json \
  "POST /connect returns ok" \
  "curl -s -X POST '${API_URL}/connect' -H 'Content-Type: application/json'" \
  '.ok'

run_test_json \
  "POST /connect returns status=connected" \
  "curl -s -X POST '${API_URL}/connect' -H 'Content-Type: application/json'" \
  '.status == "connected"'

run_test_json \
  "POST /connect returns server info" \
  "curl -s -X POST '${API_URL}/connect' -H 'Content-Type: application/json'" \
  '.server.name == "claude-code-backend"'

run_test_json \
  "POST /connect returns tool count" \
  "curl -s -X POST '${API_URL}/connect' -H 'Content-Type: application/json'" \
  '.tools > 0'

log_section "Tools"

run_test_json \
  "GET /tools returns ok" \
  "curl -s '${API_URL}/tools'" \
  '.ok'

run_test_json \
  "GET /tools lists known tools" \
  "curl -s '${API_URL}/tools'" \
  '(.tools | length) > 0'

run_test_json \
  "GET /tools includes Bash tool" \
  "curl -s '${API_URL}/tools'" \
  '[.tools[] | select(.name == "Bash")] | length > 0'

run_test_json \
  "GET /tools includes Read tool" \
  "curl -s '${API_URL}/tools'" \
  '[.tools[] | select(.name == "Read")] | length > 0'

log_section "Bash execution"

run_test_json \
  "POST /bash executes command" \
  "curl -s -X POST '${API_URL}/bash' -H 'Content-Type: application/json' -d '{\"command\":\"echo integration-test-output\"}'" \
  '.ok'

run_test_json \
  "POST /bash returns stdout" \
  "curl -s -X POST '${API_URL}/bash' -H 'Content-Type: application/json' -d '{\"command\":\"echo integration-test-output\"}'" \
  '.result.stdout | contains("integration-test-output")'

run_test_json \
  "POST /bash missing command returns error" \
  "curl -s -X POST '${API_URL}/bash' -H 'Content-Type: application/json' -d '{}'" \
  '.ok == false'

log_section "File reading"

run_test_json \
  "POST /read returns file content" \
  "curl -s -X POST '${API_URL}/read' -H 'Content-Type: application/json' -d '{\"file_path\":\"${PROJECT_ROOT}/package.json\"}'" \
  '.ok'

run_test_json \
  "POST /read content is valid JSON" \
  "curl -s -X POST '${API_URL}/read' -H 'Content-Type: application/json' -d '{\"file_path\":\"${PROJECT_ROOT}/package.json\"}'" \
  '.result.file.content | contains("claude-code-skill")'

run_test_json \
  "POST /read missing file returns error" \
  "curl -s -X POST '${API_URL}/read' -H 'Content-Type: application/json' -d '{\"file_path\":\"/nonexistent/path/fake.txt\"}'" \
  '.ok == false'

run_test_json \
  "POST /read missing file_path param returns error" \
  "curl -s -X POST '${API_URL}/read' -H 'Content-Type: application/json' -d '{}'" \
  '.ok == false'

log_section "Sessions filesystem scan"

run_test_json \
  "GET /sessions returns ok" \
  "curl -s '${API_URL}/sessions'" \
  '.ok'

run_test_json \
  "GET /sessions returns array" \
  "curl -s '${API_URL}/sessions'" \
  '.sessions | type == "array"'

log_section "Error handling"

run_test_json \
  "Unknown endpoint returns 404" \
  "curl -s '${BASE_URL}${PREFIX}/nonexistent'" \
  '.ok == false'

run_test_json \
  "Wrong method returns 405" \
  "curl -s -X GET '${API_URL}/bash'" \
  '.ok == false'

run_test_json \
  "Missing prefix returns 404" \
  "curl -s '${BASE_URL}/not-the-right-prefix'" \
  '.ok == false'

run_test_json \
  "Malformed JSON returns 400" \
  "curl -s -X POST '${API_URL}/bash' -H 'Content-Type: application/json' -d 'not-json'" \
  '.ok == false'

# =============================================================================
# Test Suite 2: CLI command tests
# =============================================================================

log_header "Test Suite 2: CLI Commands"

log_section "Connection commands"

run_test \
  "claude-code-skill connect" \
  "claude-code-skill connect" \
  "Connected"

run_test \
  "claude-code-skill status (after connect)" \
  "claude-code-skill status" \
  "Connected"

log_section "Tool listing"

run_test \
  "claude-code-skill tools lists tools" \
  "claude-code-skill tools" \
  "Bash"

run_test \
  "claude-code-skill tools shows Read" \
  "claude-code-skill tools" \
  "Read"

run_test \
  "claude-code-skill tools shows Write" \
  "claude-code-skill tools" \
  "Write"

log_section "Bash execution via CLI"

run_test \
  "claude-code-skill bash echoes output" \
  "claude-code-skill bash 'echo hello-from-cli'" \
  "hello-from-cli"

run_test \
  "claude-code-skill bash multi-word command" \
  "claude-code-skill bash 'echo foo bar baz'" \
  "foo bar baz"

run_test \
  "claude-code-skill bash command with spaces" \
  "claude-code-skill bash 'echo abc123-test-value'" \
  "abc123-test-value"

log_section "File reading via CLI"

run_test \
  "claude-code-skill read package.json" \
  "claude-code-skill read '${PROJECT_ROOT}/package.json'" \
  "claude-code-skill"

run_test \
  "claude-code-skill read nonexistent file" \
  "claude-code-skill read '/nonexistent/no-such-file.txt'" \
  "Failed|error|ENOENT"

# =============================================================================
# Test Suite 3: Session lifecycle
# =============================================================================

log_header "Test Suite 3: Session Lifecycle"

log_section "Session creation"

run_test \
  "session-start creates a session" \
  "claude-code-skill session-start '${TEST_SESSION_NAME}' -d /tmp" \
  "started"

run_test \
  "session-start duplicate name fails" \
  "claude-code-skill session-start '${TEST_SESSION_NAME}' -d /tmp" \
  "already exists|Failed"

log_section "Session listing"

run_test \
  "session-list shows the test session" \
  "claude-code-skill session-list" \
  "${TEST_SESSION_NAME}"

log_section "Session status"

run_test \
  "session-status shows active session" \
  "claude-code-skill session-status '${TEST_SESSION_NAME}'" \
  "Ready:.*Yes"

run_test \
  "session-status shows session details" \
  "claude-code-skill session-status '${TEST_SESSION_NAME}'" \
  "Claude ID:"

run_test \
  "session-status shows statistics" \
  "claude-code-skill session-status '${TEST_SESSION_NAME}'" \
  "Turns:"

log_section "Session pause and resume"

run_test \
  "session-pause pauses the session" \
  "claude-code-skill session-pause '${TEST_SESSION_NAME}'" \
  "paused"

run_test \
  "session-status shows not ready after pause" \
  "claude-code-skill session-status '${TEST_SESSION_NAME}'" \
  "Ready:.*No"

run_test \
  "session-resume-paused resumes the session" \
  "claude-code-skill session-resume-paused '${TEST_SESSION_NAME}'" \
  "resumed"

run_test \
  "session-status shows ready after resume" \
  "claude-code-skill session-status '${TEST_SESSION_NAME}'" \
  "Ready:.*Yes"

log_section "Session history"

run_test \
  "session-history returns history" \
  "claude-code-skill session-history '${TEST_SESSION_NAME}'" \
  "history|0 events"

log_section "Session fork"

run_test \
  "session-fork creates a new session" \
  "claude-code-skill session-fork '${TEST_SESSION_NAME}' '${TEST_SESSION_NAME}-fork'" \
  "forked"

run_test \
  "session-list shows forked session" \
  "claude-code-skill session-list" \
  "${TEST_SESSION_NAME}-fork"

# Clean up the fork
run_test \
  "session-stop removes forked session" \
  "claude-code-skill session-stop '${TEST_SESSION_NAME}-fork'" \
  "stopped"

log_section "Session search"

run_test \
  "session-search finds by name" \
  "claude-code-skill session-search 'integ-test'" \
  "${TEST_SESSION_NAME}|Found"

run_test \
  "session-search with no match returns empty" \
  "claude-code-skill session-search 'nonexistent-session-xyz'" \
  "No sessions found|Found 0"

log_section "Session restart"

run_test \
  "session-restart resets the session" \
  "claude-code-skill session-restart '${TEST_SESSION_NAME}'" \
  "restarted"

run_test \
  "session-status after restart shows ready" \
  "claude-code-skill session-status '${TEST_SESSION_NAME}'" \
  "Ready:.*Yes"

log_section "Session stop"

run_test \
  "session-stop removes the session" \
  "claude-code-skill session-stop '${TEST_SESSION_NAME}'" \
  "stopped"

run_test \
  "session-status after stop returns error" \
  "claude-code-skill session-status '${TEST_SESSION_NAME}'" \
  "not found|Failed"

run_test \
  "session-list no longer contains test session" \
  "claude-code-skill session-list" \
  "sessions|Active"

# =============================================================================
# Test Suite 4: Advanced session options
# =============================================================================

log_header "Test Suite 4: Advanced Session Options"

log_section "Session with custom options"

run_test \
  "session-start with --permission-mode" \
  "claude-code-skill session-start 'opts-test-$$' -d /tmp --permission-mode bypassPermissions" \
  "started"

run_test \
  "session-start with --max-turns" \
  "claude-code-skill session-stop 'opts-test-$$' && claude-code-skill session-start 'opts-test-$$' -d /tmp --max-turns 5" \
  "started"

# Clean up
curl -s -X POST "${API_URL}/session/stop" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"opts-test-$$\"}" >/dev/null 2>&1 || true

# =============================================================================
# Test Suite 5: Batch operations
# =============================================================================

log_header "Test Suite 5: Batch Operations"

log_section "Batch read"

run_test_json \
  "POST /batch-read with glob patterns" \
  "curl -s -X POST '${API_URL}/batch-read' -H 'Content-Type: application/json' -d '{\"patterns\":[\"package.json\"],\"basePath\":\"${PROJECT_ROOT}\"}'" \
  '.ok'

run_test_json \
  "POST /batch-read returns files array" \
  "curl -s -X POST '${API_URL}/batch-read' -H 'Content-Type: application/json' -d '{\"patterns\":[\"package.json\"],\"basePath\":\"${PROJECT_ROOT}\"}'" \
  '(.files | length) > 0'

run_test_json \
  "POST /batch-read missing patterns returns error" \
  "curl -s -X POST '${API_URL}/batch-read' -H 'Content-Type: application/json' -d '{}'" \
  '.ok == false'

# =============================================================================
# Test Suite 6: Disconnect
# =============================================================================

log_header "Test Suite 6: Disconnect"

run_test \
  "claude-code-skill disconnect" \
  "claude-code-skill disconnect" \
  "Disconnected"

run_test \
  "tools returns error after disconnect" \
  "claude-code-skill tools" \
  "Not connected|Failed"

# Reconnect so cleanup trap can disconnect cleanly
curl -s -X POST "${API_URL}/connect" -H "Content-Type: application/json" >/dev/null 2>&1 || true

# =============================================================================
# Test Suite 7: CORS and HTTP edge cases
# =============================================================================

log_header "Test Suite 7: HTTP Edge Cases"

log_section "CORS preflight"

CORS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "${API_URL}/connect" 2>/dev/null) || CORS_STATUS="000"

TOTAL_COUNT=$((TOTAL_COUNT + 1))
printf "  %-55s " "OPTIONS preflight returns 204"
if [ "$CORS_STATUS" = "204" ]; then
  PASS_COUNT=$((PASS_COUNT + 1))
  echo -e "[${GREEN}PASS${RESET}]"
else
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_TESTS+=("OPTIONS preflight returns 204")
  echo -e "[${RED}FAIL${RESET}] (got $CORS_STATUS)"
fi

CORS_HEADER=$(curl -s -D - -o /dev/null -X OPTIONS "${API_URL}/connect" 2>/dev/null | grep -i "access-control-allow-origin" | head -1) || CORS_HEADER=""

TOTAL_COUNT=$((TOTAL_COUNT + 1))
printf "  %-55s " "OPTIONS returns CORS headers"
if echo "$CORS_HEADER" | grep -q '\*'; then
  PASS_COUNT=$((PASS_COUNT + 1))
  echo -e "[${GREEN}PASS${RESET}]"
else
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILED_TESTS+=("OPTIONS returns CORS headers")
  echo -e "[${RED}FAIL${RESET}]"
fi

# =============================================================================
# Test Suite 8: Live tests (optional, costs API money)
# =============================================================================

log_header "Test Suite 8: Live Tests (LIVE_TEST=$LIVE_TEST)"

if [ "$LIVE_TEST" = "1" ]; then
  # Reconnect for live tests
  curl -s -X POST "${API_URL}/connect" -H "Content-Type: application/json" >/dev/null 2>&1

  log_section "Live session send"

  # Create a session for live testing
  claude-code-skill session-start "live-test-$$" -d /tmp --max-turns 1 >/dev/null 2>&1

  run_test \
    "session-send with real Claude call" \
    "claude-code-skill session-send 'live-test-$$' 'Reply with exactly: LIVE_TEST_OK'" \
    "LIVE_TEST_OK|ok"

  log_section "Live tool call"

  run_test \
    "call Bash tool via /call endpoint" \
    "claude-code-skill call Bash -a '{\"command\":\"echo live-tool-test\"}'" \
    "live-tool-test|ok"

  # Clean up live test session
  claude-code-skill session-stop "live-test-$$" >/dev/null 2>&1 || true
else
  skip_test "session-send with real Claude call" "Set LIVE_TEST=1 to enable"
  skip_test "call Bash tool via /call endpoint" "Set LIVE_TEST=1 to enable"
fi

# =============================================================================
# Summary
# =============================================================================

log_header "Test Results"

echo ""
echo -e "  ${BOLD}Total:${RESET}   $TOTAL_COUNT"
echo -e "  ${GREEN}Passed:${RESET}  $PASS_COUNT"
echo -e "  ${RED}Failed:${RESET}  $FAIL_COUNT"
echo -e "  ${YELLOW}Skipped:${RESET} $SKIP_COUNT"
echo ""

if [ $FAIL_COUNT -gt 0 ]; then
  echo -e "  ${RED}${BOLD}Failed tests:${RESET}"
  for t in "${FAILED_TESTS[@]}"; do
    echo -e "    ${RED}- $t${RESET}"
  done
  echo ""
  echo -e "  ${RED}${BOLD}INTEGRATION TESTS FAILED${RESET}"
  exit 1
else
  echo -e "  ${GREEN}${BOLD}ALL INTEGRATION TESTS PASSED${RESET}"
  exit 0
fi
