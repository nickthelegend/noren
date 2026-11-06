// Probe which signature/account EIPs Robinhood Chain actually supports.
//   pnpm --filter @noren/tsuke probe            (needs the fork on 8720 for the fork half)
// Read-only against mainnet: eth_call / eth_estimateGas only, nothing is broadcast to mainnet.
// The EIP-7702 authorisation is signed by a throwaway key generated in memory for this run.
import {
  createPublicClient,
  createWalletClient,
  http,
  hashDomain,
  keccak256,
  toHex,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const MAINNET_RPC = process.env.ROBINHOOD_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
const FORK_RPC = process.env.TSUKE_RPC ?? 'http://127.0.0.1:8720';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA: Address = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
const WETH: Address = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const ARBSYS: Address = '0x0000000000000000000000000000000000000064';
// Anvil dev account #9: published key, used on the local fork only.
const FORK_KEY: Hex = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';

const transport = (url: string) => http(url, { fetchOptions: { headers: { 'user-agent': 'curl/8.7.1' } }, retryCount: 5 });
const chain = (id: number, url: string) =>
  ({ id, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } }) as const;
const mainnet = createPublicClient({ chain: chain(4663, MAINNET_RPC), transport: transport(MAINNET_RPC) });

const erc20 = parseAbi([
  'function name() view returns (string)',
  'function nonces(address) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function PERMIT_TYPEHASH() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
]);

async function probePermit(token: Address) {
  const name = await mainnet.readContract({ address: token, abi: erc20, functionName: 'name' });
  const separator = await mainnet.readContract({ address: token, abi: erc20, functionName: 'DOMAIN_SEPARATOR' });
  const typehash = await mainnet
    .readContract({ address: token, abi: erc20, functionName: 'PERMIT_TYPEHASH' })
    .catch(() => null);
  const eip712 = await mainnet
    .readContract({ address: token, abi: erc20, functionName: 'eip712Domain' })
    .then((d) => ({ name: d[1], version: d[2] }))
    .catch(() => null);
  let version: string | null = eip712?.version ?? null;
  if (!version) {
    for (const v of ['1', '2', '3']) {
      const h = hashDomain({
        domain: { name, version: v, chainId: 4663, verifyingContract: token },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
        },
      });
      if (h === separator) version = v;
    }
  }
  const expectedTypehash = keccak256(toHex('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
  return {
    token,
    name,
    domainSeparator: separator,
    domainVersion: version,
    permitTypehash: typehash,
    standardTypehash: typehash === null ? 'not exposed' : typehash === expectedTypehash,
    eip712Domain: eip712 ?? 'not implemented',
  };
}

async function probe7702Mainnet() {
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const wallet = createWalletClient({ account: throwaway, chain: chain(4663, MAINNET_RPC), transport: transport(MAINNET_RPC) });
  const authorization = await wallet.signAuthorization({ contractAddress: WETH, chainId: 4663, nonce: 0 });
  try {
    const gas = await mainnet.estimateGas({
      account: throwaway.address,
      to: throwaway.address,
      data: '0x',
      authorizationList: [authorization],
    } as never);
    return { supported: true, estimateGas: gas.toString(), note: 'eth_estimateGas accepted a type-4 (EIP-7702) transaction' };
  } catch (e) {
    const msg = (e as Error).message.split('\n').slice(0, 3).join(' ');
    return { supported: false, error: msg };
  }
}

async function probe7702Fork() {
  const fork = createPublicClient({ chain: chain(4663, FORK_RPC), transport: transport(FORK_RPC) });
  try {
    if ((await fork.getChainId()) !== 4663) return { ran: false, reason: 'fork is not chain 4663' };
  } catch {
    return { ran: false, reason: `Setup required: start the fork (sh scripts/fork.sh) on ${FORK_RPC}` };
  }
  const account = privateKeyToAccount(FORK_KEY);
  const wallet = createWalletClient({ account, chain: chain(4663, FORK_RPC), transport: transport(FORK_RPC) });
  const snapshot = await fork.request({ method: 'evm_snapshot' as never });
  try {
    const authorization = await wallet.signAuthorization({ contractAddress: WETH, executor: 'self' });
    const hash = await wallet.sendTransaction({ to: account.address, data: '0x', authorizationList: [authorization] } as never);
    const receipt = await fork.waitForTransactionReceipt({ hash });
    const code = await fork.getCode({ address: account.address });
    return {
      ran: true,
      txType: receipt.type,
      status: receipt.status,
      delegatedCode: code,
      delegationIndicatorOk: code?.toLowerCase() === `0xef0100${WETH.slice(2).toLowerCase()}`,
      note: 'Anvil executes 7702 on the fork; this shows the local EVM, not the live sequencer',
    };
  } finally {
    await fork.request({ method: 'evm_revert' as never, params: [snapshot] as never });
  }
}

async function main() {
  const arbos = await mainnet
    .readContract({ address: ARBSYS, abi: parseAbi(['function arbOSVersion() view returns (uint256)']), functionName: 'arbOSVersion' })
    .catch(() => null);
  const result = {
    probedAt: new Date().toISOString(),
    mainnetRpc: MAINNET_RPC,
    chainId: await mainnet.getChainId(),
    block: (await mainnet.getBlockNumber()).toString(),
    arbOSVersionRaw: arbos?.toString() ?? 'ArbSys not available',
    eip2612: { usdg: await probePermit(USDG), nvda: await probePermit(NVDA) },
    eip7702: { mainnetEstimate: await probe7702Mainnet(), fork: await probe7702Fork() },
    eip8141: 'Not available on Robinhood Chain: frame transactions exist only on an EF devnet, so Tsuke does not use them.',
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
