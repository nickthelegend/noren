#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node patches/apply-kohaku.mjs
exec pnpm exec tsx scripts/dev-all.ts
