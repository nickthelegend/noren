import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entrypointAbi, localFork } from '@noren/core';
import { readDeployment } from '@noren/core/node';
import { createPostman } from './postman.ts';
const key = process.env.NOREN_POSTMAN_KEY as Hex | undefined;
if (!key) throw new Error('Setup required: NOREN_POSTMAN_KEY missing');
const rpcUrl = process.env.NOREN_RPC_URL ?? 'https://rpc.testnet.arc.io';
const deployment = await readDeployment(Number(process.env.NOREN_CHAIN_ID ?? 5042002));
const wallet: any = createWalletClient({ chain: localFork(rpcUrl), account: privateKeyToAccount(key), transport: http(rpcUrl) });
const port = Number(process.env.NOREN_POSTMAN_PORT ?? 8788);
const treeUrl = process.env.NOREN_TREE_URL ?? `http://127.0.0.1:${port}/asp/tree?v=1`;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl) && !process.env.NOREN_TREE_URL) throw new Error('Setup required: NOREN_TREE_URL must be publicly reachable on Arc testnet');
const batchMs = process.env.NOREN_POSTMAN_BATCH_MS ? Number(process.env.NOREN_POSTMAN_BATCH_MS) : undefined;
const postman = createPostman({ deployment, rpcUrl, treeUrl, batchMs, sendRoot: (root, cid) => wallet.writeContract({ address: deployment.entrypoint, abi: entrypointAbi, functionName: 'updateRoot', args: [root, cid] }) });
// NOREN_POSTMAN_HOST=0.0.0.0 inside a container (the hosted demo routes it through a reverse proxy); default loopback.
postman.serve(port, process.env.NOREN_POSTMAN_HOST ?? '127.0.0.1');
setInterval(() => postman.tick().catch((e) => console.error('ASP tick:', e.message)), Number(process.env.NOREN_POSTMAN_TICK_MS ?? 1000));
console.log('Noren ASP postman ready');
