// Minimal local patch for @kohaku-eth/privacy-pools@0.1.0-alpha.27.
// The upstream PR should expose prepareUnshield({ processooor, data }) and
// route this branch through the existing withdrawThunk without a relayer quote.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Every installed copy: pnpm keeps one per peer-dependency set (spike's, and core's, which the app and e2e load).
const pnpmDir = join(root, 'node_modules/.pnpm');
const bundles = new Set([join(root, 'packages/spike/node_modules/@kohaku-eth/privacy-pools/dist/index.js'),
  ...(existsSync(pnpmDir) ? readdirSync(pnpmDir).filter((d) => d.startsWith('@kohaku-eth+privacy-pools@0.1.0-alpha.27')).map((d) => join(pnpmDir, d, 'node_modules/@kohaku-eth/privacy-pools/dist/index.js')) : [])]);
const marker = '      checkoutWithdrawal\n';
const start = '    getWithdrawalPayloads: async ({\n      asset,\n      amount,\n      recipient\n    }) => {\n      const chainInfo = await getChainInfo();\n      const store = await getChainStore(chainInfo);';
const replacement = '    getWithdrawalPayloads: async ({\n      asset,\n      amount,\n      recipient,\n      checkoutWithdrawal\n    }) => {\n      const chainInfo = await getChainInfo();\n      const store = await getChainStore(chainInfo);\n      if (checkoutWithdrawal) {\n        const poolInfo = store.selectors.poolFromAssetSelector(asset);\n        if (!poolInfo) throw new Error(`No pool found for asset ${asset}`);\n        const context = BigInt(calculateContext(checkoutWithdrawal, poolInfo.scope));\n        const proofResult = unwrapResult(await store.dispatch(withdrawThunk({\n          getNextNote: store.selectors.getNextNote,\n          proverFactory: params.proverFactory,\n          asset, amount: amount ?? 0n, recipient, context\n        })));\n        return [{ withdrawalInfo: { context, scope: poolInfo.scope, withdrawalObject: checkoutWithdrawal }, proofResult, chainId: chainInfo.chainId }];\n      }';
for (const bundle of bundles) {
  if (!existsSync(bundle)) continue;
  const source = readFileSync(bundle, 'utf8');
  if (source.includes(marker)) continue;
  if (!source.includes(start)) throw new Error(`Kohaku bundle changed; checkout patch did not apply (${bundle})`);
  writeFileSync(bundle, source.replace(start, replacement));
}
