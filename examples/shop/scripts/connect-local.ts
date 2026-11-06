// Local development only: creates the "Aubelle" store on a LOCAL Noren server and writes its keys to .env.
// It does what a merchant does in Noren Merchant > Developers: sign in with Ethereum (SIWE), create a store, keep the
// secret key. The owner is a published Anvil dev account, so this refuses any non-loopback Noren server.
//   pnpm connect:local            (reads NOREN_SERVER from .env, default http://127.0.0.1:8790)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const server = (process.env.NOREN_SERVER ?? 'http://127.0.0.1:8790').replace(/\/$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(server)) throw new Error(`connect-local only talks to a local Noren server, not ${server}`);
if (process.env.NOREN_SECRET_KEY && !process.argv.includes('--force')) { console.log('Already connected: .env has NOREN_SECRET_KEY (pass --force to create a new store).'); process.exit(0); }

// Anvil's published dev account #9: fine on a local fork, worthless anywhere else.
const owner = privateKeyToAccount('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6');
const domain = process.env.NOREN_SIWE_DOMAIN ?? 'localhost:5190';
const chainId = Number(process.env.NOREN_CHAIN_ID ?? 5042002);

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(server + path, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${body.error ?? `HTTP ${res.status}`}`);
  return body;
}

const { nonce } = await call('/auth/nonce');
const message = createSiweMessage({ domain, address: owner.address, statement: 'Sign in to Noren Merchant', uri: `http://${domain}`, version: '1', chainId, nonce, issuedAt: new Date() });
const { session } = await call('/auth/siwe', { method: 'POST', body: JSON.stringify({ message, signature: await owner.signMessage({ message }) }) });
const { store, secretKey } = await call('/stores', { method: 'POST', headers: { authorization: `Bearer ${session}` }, body: JSON.stringify({ name: 'Aubelle', payout: owner.address }) });

const keep = existsSync(envFile) ? readFileSync(envFile, 'utf8').split('\n').filter(l => l.trim() && !/^(NOREN_SERVER|NOREN_MERCHANT|NOREN_SECRET_KEY)=/.test(l)) : [];
writeFileSync(envFile, [`NOREN_SERVER=${server}`, `NOREN_MERCHANT=${store.merchant}`, `NOREN_SECRET_KEY=${secretKey}`, ...keep].join('\n') + '\n', { mode: 0o600 });
console.log(`Created store "${store.name}" (${store.id}), merchant ${store.merchant}, payout ${store.payout}, registered in tx ${store.registerTx}.`);
console.log('Wrote NOREN_SERVER, NOREN_MERCHANT and NOREN_SECRET_KEY to examples/shop/.env (the key is not printed). Restart the shop.');
