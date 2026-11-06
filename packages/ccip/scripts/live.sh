#!/usr/bin/env bash
# Runs one forge script against a public testnet under the shared deployer lock.
# Usage: NOREN_ENV_FILE=<gitignored env with NOREN_DEPLOYER_KEY> scripts/live.sh <script> <rpc alias> [forge args]
# The key is only read by the script via vm.envUint("NOREN_DEPLOYER_KEY"); it is never put on a command line.
set -euo pipefail
SCRIPT=$1; RPC=$2; shift 2
: "${NOREN_ENV_FILE:?Setup required: NOREN_ENV_FILE pointing at the gitignored file that defines NOREN_DEPLOYER_KEY}"
LOCK=/private/tmp/noren-arc-deployer.lock
for _ in $(seq 1 120); do
  if mkdir "$LOCK" 2>/dev/null; then break; fi
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOCK" || true; fi
  sleep 5
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
set -a; source "$NOREN_ENV_FILE" >/dev/null 2>&1; set +a
forge script "$SCRIPT" --rpc-url "$RPC" --broadcast --slow "$@" 2>&1 | grep -viE "private|sensitive"
