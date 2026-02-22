#!/usr/bin/env bash
# install-launchd.sh — Install and load the claude-code-server LaunchAgent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.codyshort.claude-code-server.plist"
PLIST_SRC="$SCRIPT_DIR/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "=== claude-code-server LaunchAgent Installer ==="
echo ""

# 1. Ensure the project is built
if [ ! -f "$PROJECT_DIR/dist/server.js" ]; then
    echo "[*] Building project (dist/server.js not found)..."
    cd "$PROJECT_DIR"
    npm run build
    echo "[+] Build complete."
else
    echo "[+] dist/server.js found."
fi

# 2. Ensure LaunchAgents directory exists
if [ ! -d "$AGENTS_DIR" ]; then
    echo "[*] Creating $AGENTS_DIR..."
    mkdir -p "$AGENTS_DIR"
fi

# 3. Unload existing agent if already loaded
if launchctl list 2>/dev/null | grep -q "com.codyshort.claude-code-server"; then
    echo "[*] Unloading existing LaunchAgent..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# 4. Copy plist to LaunchAgents
echo "[*] Copying plist to $PLIST_DST..."
cp "$PLIST_SRC" "$PLIST_DST"

# 5. Ensure log directory exists
mkdir -p "$HOME/Library/Logs"

# 6. Load the agent
echo "[*] Loading LaunchAgent..."
launchctl load "$PLIST_DST"

# 7. Verify
sleep 2
if launchctl list 2>/dev/null | grep -q "com.codyshort.claude-code-server"; then
    echo ""
    echo "[+] LaunchAgent installed and running."
    echo "    Service: com.codyshort.claude-code-server"
    echo "    Server:  http://127.0.0.1:18795"
    echo "    Logs:    ~/Library/Logs/claude-code-server.log"
    echo ""
    echo "    Test:  curl -s http://127.0.0.1:18795/backend-api/claude-code/tools"
    echo "    Stop:  launchctl unload ~/Library/LaunchAgents/$PLIST_NAME"
else
    echo ""
    echo "[!] LaunchAgent loaded but may not be running yet."
    echo "    Check logs: tail -f ~/Library/Logs/claude-code-server.log"
fi
