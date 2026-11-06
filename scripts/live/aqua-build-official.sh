#!/usr/bin/env bash
# Builds 1inch's official, UNMODIFIED Aqua registry (AquaRouter) from the pinned upstream commit and
# compares its runtime bytecode with the code 1inch deployed at 0x1111113c…a90a on Arc mainnet (5042).
#
#   bash scripts/live/aqua-build-official.sh
#
# Upstream: github.com/1inch/aqua tag v1.0.0, commit 81c26e4619ce21556ab02b3284ee2685de21fb18
# (LicenseRef-Degensoft-Aqua-Source-1.1). The sources and foundry.toml are taken from that commit
# with `git archive` and never edited. Dependencies are the exact versions upstream v1.0.0 pins
# (@1inch/solidity-utils 6.9.7, @openzeppelin/contracts 5.4.0), installed in packages/aqua.
# Output: packages/aqua/aqua-official/build/ (gitignored) and aqua-official/build-check.json.
set -euo pipefail

COMMIT=81c26e4619ce21556ab02b3284ee2685de21fb18
OFFICIAL=0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a
ARC_MAINNET_RPC=${ARC_MAINNET_RPC:-https://arc-rpc.publicnode.com}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PKG="$ROOT/packages/aqua"
DIR="$PKG/aqua-official"
BUILD="$DIR/build"
NM="$PKG/node_modules"

for d in "@1inch/solidity-utils" "@openzeppelin/contracts"; do
  [ -d "$NM/$d" ] || { echo "Setup required: pnpm install (missing $NM/$d)" >&2; exit 1; }
done
want_su=6.9.7; want_oz=5.4.0
got_su=$(node -p "require('$NM/@1inch/solidity-utils/package.json').version")
got_oz=$(node -p "require('$NM/@openzeppelin/contracts/package.json').version")
[ "$got_su" = "$want_su" ] && [ "$got_oz" = "$want_oz" ] || { echo "dependency mismatch: solidity-utils $got_su (want $want_su), OZ $got_oz (want $want_oz)" >&2; exit 1; }

rm -rf "$BUILD" && mkdir -p "$BUILD"
git clone --quiet --filter=blob:none --no-checkout https://github.com/1inch/aqua.git "$BUILD/.upstream"
got=$(git -C "$BUILD/.upstream" rev-parse "$COMMIT^{commit}")
[ "$got" = "$COMMIT" ] || { echo "pinned commit $COMMIT not found" >&2; exit 1; }
git -C "$BUILD/.upstream" archive "$COMMIT" src foundry.toml remappings.txt | tar -x -C "$BUILD"
rm -rf "$BUILD/.upstream"
mkdir -p "$BUILD/node_modules/@1inch" "$BUILD/node_modules/@openzeppelin"
cp -RL "$NM/@1inch/solidity-utils" "$BUILD/node_modules/@1inch/"
cp -RL "$NM/@openzeppelin/contracts" "$BUILD/node_modules/@openzeppelin/"

(cd "$BUILD" && forge build --skip test --skip script --force >/dev/null)
ART="$BUILD/out/AquaRouter.sol/AquaRouter.json"
local_code=$(jq -r .deployedBytecode.object "$ART")
mainnet_code=$(cast code "$OFFICIAL" --rpc-url "$ARC_MAINNET_RPC")
[ "${#mainnet_code}" -gt 2 ] || { echo "no code at $OFFICIAL on Arc mainnet ($ARC_MAINNET_RPC)" >&2; exit 1; }

node - "$local_code" "$mainnet_code" "$DIR/build-check.json" "$COMMIT" <<'EOF'
const [a, b, out, commit] = process.argv.slice(2);
const strip = (h) => h.toLowerCase().replace(/^0x/, "");
const x = strip(a), y = strip(b);
// Solidity CBOR metadata: a2 64 'ipfs' 58 22 <34-byte multihash> 64 'solc' 43 <3-byte version> 0033 (53 bytes).
const meta = (h) => h.lastIndexOf("a264697066735822");
const mx = meta(x), my = meta(y);
const diff = [];
for (let i = 0; i < Math.max(x.length, y.length); i += 2) if (x.slice(i, i + 2) !== y.slice(i, i + 2)) diff.push(i / 2);
const outsideMeta = diff.filter((i) => i < mx / 2);
const res = {
  upstream: `github.com/1inch/aqua@${commit} (tag v1.0.0), contract src/AquaRouter.sol:AquaRouter, unmodified`,
  compiler: "solc 0.8.30, via-IR, optimizer 10,000,000 runs (upstream foundry.toml)",
  comparedWith: "runtime code at 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a on Arc mainnet (5042)",
  runtimeBytes: x.length / 2,
  mainnetRuntimeBytes: y.length / 2,
  differingBytes: diff.length,
  differingBytesOutsideMetadata: outsideMeta.length,
  metadataOffset: mx / 2,
  executableCodeIdentical: x.length === y.length && mx === my && x.slice(0, mx) === y.slice(0, my),
  fullyIdentical: x === y,
  note: "Aqua has no immutables (its constructor only sets the Rescuable owner in storage). The only difference is the 32-byte IPFS hash inside the CBOR metadata, which hashes source paths and file contents of the build environment, not the code.",
  checkedAt: new Date().toISOString(),
};
require("node:fs").writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
console.log(JSON.stringify(res, null, 2));
if (!res.executableCodeIdentical) { console.error("FAIL: the executable code differs from Arc mainnet"); process.exit(1); }
EOF
echo "artifact: $ART"
