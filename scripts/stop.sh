#!/usr/bin/env bash
# stop.sh — Gracefully stop the claude-code-server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.server.pid"
PORT="${CLAUDE_CODE_PORT:-18795}"

stop_by_pid_file() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "[*] Sending SIGTERM to PID $PID..."
            kill -TERM "$PID"

            # Wait up to 10 seconds for graceful shutdown
            for i in $(seq 1 10); do
                if ! kill -0 "$PID" 2>/dev/null; then
                    echo "[+] Server stopped gracefully."
                    rm -f "$PID_FILE"
                    return 0
                fi
                sleep 1
            done

            # Force kill if still running
            echo "[!] Server did not stop gracefully. Sending SIGKILL..."
            kill -9 "$PID" 2>/dev/null || true
            rm -f "$PID_FILE"
            echo "[+] Server force-killed."
            return 0
        else
            echo "[*] PID $PID not running (stale PID file)."
            rm -f "$PID_FILE"
            return 1
        fi
    fi
    return 1
}

stop_by_port() {
    # Find process listening on the server port
    local PIDS
    PIDS=$(lsof -ti ":$PORT" 2>/dev/null || true)

    if [ -n "$PIDS" ]; then
        echo "[*] Found process(es) on port $PORT: $PIDS"
        echo "[*] Sending SIGTERM..."
        echo "$PIDS" | xargs kill -TERM 2>/dev/null || true

        sleep 3
        # Check if any are still alive
        local REMAINING
        REMAINING=$(lsof -ti ":$PORT" 2>/dev/null || true)
        if [ -n "$REMAINING" ]; then
            echo "[!] Force-killing remaining processes: $REMAINING"
            echo "$REMAINING" | xargs kill -9 2>/dev/null || true
        fi
        echo "[+] Server stopped."
        rm -f "$PID_FILE"
        return 0
    fi
    return 1
}

echo "=== Stopping claude-code-server ==="

# Try PID file first, fall back to port scan
if stop_by_pid_file; then
    exit 0
fi

if stop_by_port; then
    exit 0
fi

echo "[*] No running claude-code-server found."
