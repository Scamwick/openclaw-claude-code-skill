#!/usr/bin/env bash
# start.sh — Start the claude-code-server with proper environment
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.server.pid"
LOG_FILE="${CLAUDE_CODE_LOG:-$HOME/Library/Logs/claude-code-server.log}"

# Ensure PATH includes common locations for node and claude
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
export NODE_ENV="${NODE_ENV:-production}"
export CLAUDE_CODE_PORT="${CLAUDE_CODE_PORT:-18795}"
export CLAUDE_CODE_HOST="${CLAUDE_CODE_HOST:-127.0.0.1}"

cd "$PROJECT_DIR"

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[!] Server already running (PID $OLD_PID)."
        echo "    Stop it first: ./scripts/stop.sh"
        exit 1
    else
        # Stale PID file
        rm -f "$PID_FILE"
    fi
fi

# Ensure the project is built
if [ ! -f "$PROJECT_DIR/dist/server.js" ]; then
    echo "[*] Building project..."
    npm run build
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

echo "[*] Starting claude-code-server..."
echo "    Port: $CLAUDE_CODE_PORT"
echo "    Host: $CLAUDE_CODE_HOST"
echo "    Log:  $LOG_FILE"

# Start in background
nohup node dist/server.js >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait a moment and check
sleep 2
if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[+] Server started (PID $SERVER_PID)."
    echo "    Test: curl -s http://$CLAUDE_CODE_HOST:$CLAUDE_CODE_PORT/backend-api/claude-code/tools"
else
    echo "[!] Server failed to start. Check logs:"
    echo "    tail -20 $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
