// Checks every CCTP chain in sdk/chains.ts against the live testnets and writes fixtures/chains-verified.json.
// Usage: pnpm --filter @noren/cctp exec tsx scripts/verify-chains.ts
import { writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, pad, type Address } from "viem";
import { ARC, CCTP_CHAINS } from "../sdk/chains";
import { fetchFeeBps } from "../sdk/iris";

const tm = parseAbi(["function localMinter() view returns (address)", "function remoteTokenMessengers(uint32) view returns (bytes32)"]);
const mt = parseAbi(["function localDomain() view returns (uint32)"]);
const minter = parseAbi(["function getLocalToken(uint32, bytes32) view returns (address)"]);

const rows = [];
let failed = 0;
for (const c of Object.values(CCTP_CHAINS)) {
  const pub = createPublicClient({ transport: http(c.rpcUrl, { timeout: 20_000 }) });
  try {
    const [chainId, tmCode, mtCode, domain, localMinter] = await Promise.all([
      pub.getChainId(), pub.getCode({ address: c.tokenMessenger }), pub.getCode({ address: c.messageTransmitter }),
      pub.readContract({ address: c.messageTransmitter, abi: mt, functionName: "localDomain" }),
      pub.readContract({ address: c.tokenMessenger, abi: tm, functionName: "localMinter" }),
    ]);
    const isArc = c.key === "arc-testnet";
    const remote = isArc ? null : await pub.readContract({ address: c.tokenMessenger, abi: tm, functionName: "remoteTokenMessengers", args: [ARC.domain] });
    const usdc: Address = isArc ? c.usdc : await pub.readContract({ address: localMinter, abi: minter, functionName: "getLocalToken", args: [ARC.domain, pad(ARC.usdc, { size: 32 })] });
    const feeBps = isArc ? null : await fetchFeeBps(c.domain, ARC.domain, 1000);
    const ok = chainId === c.chainId && (tmCode?.length ?? 0) > 2 && (mtCode?.length ?? 0) > 2 && domain === c.domain
      && usdc.toLowerCase() === c.usdc.toLowerCase() && (isArc || remote === pad(c.tokenMessenger, { size: 32 }).toLowerCase());
    if (!ok) failed++;
    rows.push({ key: c.key, chainId, domain, usdc, linkedToArc: isArc ? "hub" : remote, fastFeeBpsToArc: feeBps, ok });
    console.log(`${ok ? "OK  " : "FAIL"} ${c.name.padEnd(24)} chain ${chainId} domain ${domain} USDC ${usdc}${feeBps === null ? "" : ` fast fee ${feeBps} bps`}`);
  } catch (e) {
    failed++;
    rows.push({ key: c.key, ok: false, error: (e as Error).message.split("\n")[0] });
    console.log(`FAIL ${c.name}: ${(e as Error).message.split("\n")[0]}`);
  }
}
writeFileSync(new URL("../fixtures/chains-verified.json", import.meta.url), `${JSON.stringify({ checkedAt: new Date().toISOString(), tokenMessengerV2: ARC.tokenMessenger, messageTransmitterV2: ARC.messageTransmitter, rows }, null, 2)}\n`);
process.exit(failed ? 1 : 0);
