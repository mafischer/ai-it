#!/usr/bin/env bash
# AI-IT Monitor — clean real-time view of vllm-mlx and Node server activity.
# Filters disconnect_guard noise and colorizes key events.
#
# Usage:
#   ./service/monitor.sh              # watch vllm-mlx logs only
#   ./service/monitor.sh <node.log>   # also tail a Node server log file

BOLD='\033[1m'
RESET='\033[0m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
DIM='\033[2m'
MAGENTA='\033[0;35m'

VLLM_ERR="$HOME/.vllm-mlx/vllm.err"
VLLM_OUT="$HOME/.vllm-mlx/vllm.out"
SERVER_ERR="$(dirname "$0")/../ai-it-service/server.err"
SERVER_OUT="$(dirname "$0")/../ai-it-service/server.out"
FILES=("$VLLM_ERR" "$VLLM_OUT" "$SERVER_ERR" "$SERVER_OUT")
[[ -n "${1:-}" && -f "$1" ]] && FILES+=("$1")

echo -e "${BOLD}AI-IT Monitor${RESET} — $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "${DIM}────────────────────────────────────────────────────────────────${RESET}"

tail -f "${FILES[@]}" | awk '
/disconnect_guard.*START/                 { print "\033[2m" $0 "\033[0m"; fflush(); next }
/disconnect_guard.*first chunk/           { print "\033[2m" $0 "\033[0m"; fflush(); next }
/disconnect_guard.*CLEANUP/               { print "\033[2m" $0 "\033[0m"; fflush(); next }
/disconnect_guard.*poll/                  { if (++_poll % 10 == 0) { print "\033[2m" $0 "\033[0m"; fflush() }; next }
/\[STATS\].*done:/                        { print "\033[0;32m" $0 "\033[0m"; fflush(); next }
/\[STATS\]/                               { print "\033[2m"    $0 "\033[0m"; fflush(); next }
/\[REQUEST\].*last user message/          { print "\033[2m"    $0 "\033[0m"; fflush(); next }
/\[REQUEST\]/                             { print "\n\033[1m\033[0;36m" $0 "\033[0m"; fflush(); next }
/\[ROUTER\]/                              { print "\033[0;35m" $0 "\033[0m"; fflush(); next }
/\[UTILITY\]/                             { print "\033[2m"    $0 "\033[0m"; fflush(); next }
/ERROR|Error/ && !/error_path/            { print "\033[0;31m" $0 "\033[0m"; fflush(); next }
/WARNING|Warning/                         { print "\033[1;33m" $0 "\033[0m"; fflush(); next }
/startup complete|Uvicorn running/        { print "\033[0;32m" $0 "\033[0m"; fflush(); next }
                                          { print "\033[2m" $0 "\033[0m"; fflush() }
'
