import { readDeployment } from '@noren/core/node';
import { createMerchantServer } from './server.ts';
const rpcUrl = process.env.NOREN_RPC_URL ?? 'https://rpc.testnet.arc.io';
const chainId = Number(process.env.NOREN_CHAIN_ID ?? 5042002);
const deployment = await readDeployment(chainId);
const server = createMerchantServer({ deployment, rpcUrl, merchantKey: process.env.NOREN_MERCHANT_KEY as any, refundToken: process.env.NOREN_REFUND_TOKEN, dataFile: process.env.NOREN_DATA_FILE ?? 'data/invoices.json' });
server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => console.log('Noren merchant server ready'));
