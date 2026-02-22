#!/usr/bin/env bash
# uninstall-launchd.sh — Unload and remove the claude-code-server LaunchAgent
set -euo pipefail

PLIST_NAME="com.codyshort.claude-code-server.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "=== claude-code-server LaunchAgent Uninstaller ==="
echo ""

# 1. Unload the agent if loaded
if launchctl list 2>/dev/null | grep -q "com.codyshort.claude-code-server"; then
    echo "[*] Unloading LaunchAgent..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    echo "[+] LaunchAgent unloaded."
else
    echo "[*] LaunchAgent not currently loaded."
fi

# 2. Remove the plist file
if [ -f "$PLIST_DST" ]; then
    echo "[*] Removing $PLIST_DST..."
    rm "$PLIST_DST"
    echo "[+] Plist removed."
else
    echo "[*] Plist file not found at $PLIST_DST (already removed)."
fi

echo ""
echo "[+] claude-code-server LaunchAgent uninstalled."
echo "    Note: Log file remains at ~/Library/Logs/claude-code-server.log"
