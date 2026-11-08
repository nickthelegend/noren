if (process.env.NOREN_EDITION === 'wif') {
  await import('./wif.ts');
} else {
const { readDeployment } = await import('@noren/core/node');
const { createMerchantServer } = await import('./server.ts');
const rpcUrl = process.env.NOREN_RPC_URL ?? 'https://rpc.testnet.arc.io';
const chainId = Number(process.env.NOREN_CHAIN_ID ?? 5042002);
const deployment = await readDeployment(chainId);
const server = createMerchantServer({ deployment, rpcUrl, merchantKey: process.env.NOREN_MERCHANT_KEY as any, merchantToken: process.env.NOREN_MERCHANT_TOKEN, refundToken: process.env.NOREN_REFUND_TOKEN, dataFile: process.env.NOREN_DATA_FILE ?? 'data/invoices.json' });
server.listen(Number(process.env.PORT ?? 8787), '127.0.0.1', () => console.log('Noren merchant server ready'));
}
