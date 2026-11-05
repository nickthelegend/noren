#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
node patches/apply-kohaku.mjs
pnpm build:contracts

if curl -fsS --max-time 1 -X POST http://127.0.0.1:8645 -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' >/dev/null 2>&1; then
  echo 'Port 8645 already has an RPC server; stop it before running the spike.' >&2
  exit 1
fi

anvil --silent --fork-url https://rpc.testnet.arc.io --chain-id 5042002 --port 8645 > /private/tmp/noren-anvil-spike.log 2>&1 &
anvil_pid=$!
cleanup() {
  kill "$anvil_pid" 2>/dev/null || true
  wait "$anvil_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS -X POST http://127.0.0.1:8645 -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then
  cat /private/tmp/noren-anvil-spike.log
  exit 1
fi

tsx packages/spike/src/run.ts
