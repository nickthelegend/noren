#!/bin/sh
# Imports Noren's Arc contracts into an Arc Studio app (compile, test, deploy, console)
# and records the shareable Studio URL in arc-studio/studio.json.
#
#   sh arc-studio/import.sh            # first run creates the Studio app; later runs continue it
#   sh arc-studio/import.sh --stage    # only build the upload bundle in arc-studio/.stage (no Studio call)
#
# Arc Studio cannot clone a private GitHub repo, so the contracts are sent with --file
# as flattened, unmodified sources. Nothing secret is uploaded (.env files are never staged).
set -eu
cd "$(dirname "$0")/.."
SESSION="${ARC_STUDIO_SESSION:-noren}"
STAGE=arc-studio/.stage

if [ "${1:-}" != "--stage" ] && ! arc-studio whoami >/dev/null 2>&1; then
  cat >&2 <<'MSG'
BLOCKED: Arc Studio is not logged in on this Mac.
Nick, in a normal Terminal (not inside an agent sandbox):
  1. arc-studio login --paste
     (approve in the browser, paste the token at the prompt; it is stored in ~/.arc-studio/credentials.json, mode 0600)
  2. arc-studio whoami        # must exit 0
  3. sh arc-studio/import.sh  # from the Noren repo root
MSG
  exit 2
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/noren" "$STAGE/ref"
(cd packages/contracts && forge build --skip 'test/**' >/dev/null 2>&1) || { echo 'forge build failed: run pnpm build:contracts to see why' >&2; exit 1; }

flatten() { # <foundry project dir> <source path inside it>
  (cd "$1" && forge flatten "$2" -o "$OLDPWD/$STAGE/noren/$(basename "$2")" >/dev/null)
  echo "staged $(basename "$2")"
}
for f in \
  node_modules/poseidon-solidity/PoseidonT3.sol \
  node_modules/poseidon-solidity/PoseidonT4.sol \
  lib/privacy-pools-core/src/contracts/verifiers/WithdrawalVerifier.sol \
  lib/privacy-pools-core/src/contracts/verifiers/CommitmentVerifier.sol \
  lib/privacy-pools-core/src/contracts/Entrypoint.sol \
  node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol \
  lib/privacy-pools-core/src/contracts/implementations/PrivacyPoolComplex.sol \
  src/NorenCheckout.sol \
  src/NorenQuoter.sol; do
  flatten packages/contracts "$f"
done
# Contracts from the cre-pricing and cre-bridge branches, once merged.
if [ -f packages/contracts/src/NorenRateOracle.sol ]; then flatten packages/contracts src/NorenRateOracle.sol; else echo "skip NorenRateOracle (not on this branch yet)"; fi
if [ -f packages/arc-credit/foundry.toml ] && [ -f packages/arc-credit/src/NorenCreditLine.sol ]; then flatten packages/arc-credit src/NorenCreditLine.sol; else echo "skip NorenCreditLine (not on this branch yet)"; fi

node arc-studio/reorder.mjs "$STAGE"/noren/*.sol

# Compile the bundle on its own, as Studio's Foundry sandbox will, and compare bytecode with the repo build.
SIM="$STAGE/sim"
mkdir -p "$SIM/contracts"
cp -R "$STAGE/noren" "$SIM/contracts/"
printf "[profile.default]\nsrc = 'contracts'\nout = 'out'\nsolc_version = '0.8.28'\noptimizer = true\noptimizer_runs = 10000\nbytecode_hash = 'none'\ncbor_metadata = false\n" > "$SIM/foundry.toml"
(cd "$SIM" && forge build >/dev/null 2>&1) || { echo 'Bundle does not compile standalone; run: cd arc-studio/.stage/sim && forge build' >&2; exit 1; }
node arc-studio/compare.mjs "$SIM/out" packages/contracts/out
cp docs/ARCHITECTURE.md docs/ARC.md packages/contracts/test/NorenCheckout.t.sol scripts/deploy-arc.ts "$STAGE/ref/"
echo "upload: $(ls "$STAGE/noren" | wc -l | tr -d ' ') contracts + $(ls "$STAGE/ref" | wc -l | tr -d ' ') reference files, $(cat "$STAGE"/noren/* "$STAGE"/ref/* | wc -c | tr -d ' ') bytes"
[ "${1:-}" = "--stage" ] && exit 0

# Turns that compile, test and deploy take 5-20 min; --timeout bounds a wedged turn.
status=0
arc-studio run --session "$SESSION" --prompt-file arc-studio/prompt.md \
  --file "$STAGE/noren:contracts/noren" --file "$STAGE/ref" \
  --output json --timeout 45 > "$STAGE/result.json" 2> "$STAGE/run.stderr.log" || status=$?
node arc-studio/record.mjs "$STAGE/result.json"
echo "arc-studio exit $status (0 completed, 3 needs input, 4 budget, 1 error); full result: $STAGE/result.json"
exit "$status"
