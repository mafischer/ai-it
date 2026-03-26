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

# cleanup old logs
rm -f ~/log/omlx.log && touch ~/log/omlx.log
rm ./ai-it-service/server.out && touch ./ai-it-service/server.out
rm ./ai-it-service/server.err && touch ./ai-it-service/server.err

# vllm-mlx is disabled as we are using lm-studio
# restart_service com.aiit.vllm-mlx
restart_service com.aiit.server

echo "  started"

echo ""
echo "Done. Monitor with:"
echo "  tail -f ai-it-service/server.out ai-it-service/server.err ~/log/omlx.log"
