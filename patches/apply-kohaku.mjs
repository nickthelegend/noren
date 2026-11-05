// Minimal local patch for @kohaku-eth/privacy-pools@0.1.0-alpha.27.
// The upstream PR should expose prepareUnshield({ processooor, data }) and
// route this branch through the existing withdrawThunk without a relayer quote.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'packages/spike/node_modules/@kohaku-eth/privacy-pools/dist/index.js');
const source = readFileSync(bundle, 'utf8');
const marker = '      checkoutWithdrawal\n';
if (source.includes(marker)) process.exit(0);
const start = '    getWithdrawalPayloads: async ({\n      asset,\n      amount,\n      recipient\n    }) => {\n      const chainInfo = await getChainInfo();\n      const store = await getChainStore(chainInfo);';
const replacement = '    getWithdrawalPayloads: async ({\n      asset,\n      amount,\n      recipient,\n      checkoutWithdrawal\n    }) => {\n      const chainInfo = await getChainInfo();\n      const store = await getChainStore(chainInfo);\n      if (checkoutWithdrawal) {\n        const poolInfo = store.selectors.poolFromAssetSelector(asset);\n        if (!poolInfo) throw new Error(`No pool found for asset ${asset}`);\n        const context = BigInt(calculateContext(checkoutWithdrawal, poolInfo.scope));\n        const proofResult = unwrapResult(await store.dispatch(withdrawThunk({\n          getNextNote: store.selectors.getNextNote,\n          proverFactory: params.proverFactory,\n          asset, amount: amount ?? 0n, recipient, context\n        })));\n        return [{ withdrawalInfo: { context, scope: poolInfo.scope, withdrawalObject: checkoutWithdrawal }, proofResult, chainId: chainInfo.chainId }];\n      }';
if (!source.includes(start)) throw new Error('Kohaku bundle changed; checkout patch did not apply');
writeFileSync(bundle, source.replace(start, replacement));
