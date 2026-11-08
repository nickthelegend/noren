/** Public, read-only configuration for the one-chain WIF edition. No Arc services are started. */
import { createServer } from 'node:http';

const gateway = process.env.NOREN_WIF_GATEWAY;
const rpcUrl = process.env.NOREN_RH_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const fromBlock = process.env.NOREN_WIF_DEPLOY_BLOCK ?? '0';
const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  if (req.method !== 'GET' || req.url !== '/config') { res.writeHead(404); res.end('{}'); return; }
  res.end(JSON.stringify({ edition: 'wif', chainId: 4663, rpcUrl, gateway: gateway ?? null, fromBlock }));
});
server.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? '127.0.0.1', () => console.log('Noren WIF server ready'));
