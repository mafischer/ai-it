#!/usr/bin/env bash
set -euo pipefail

LAUNCH_AGENTS=~/Library/LaunchAgents

restart_service() {
    local label="$1"
    local plist="$LAUNCH_AGENTS/${label}.plist"
    echo "Restarting $label..."
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    echo "  started"
}

# vllm-mlx is disabled as we are using lm-studio
# restart_service com.aiit.vllm-mlx
restart_service com.aiit.server

echo "Restarting open-webui..."
docker restart open-webui
echo "  started"

echo ""
echo "Done. Monitor with:"
echo "  tail -f ai-it-service/server.out"