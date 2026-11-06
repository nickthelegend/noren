// Live USDC transfer OUT of Arc Testnet with Circle CCTP V2 (the reverse of Noren's inbound rail).
//   burn      depositForBurn on Arc (under the shared-deployer lock, pending nonce)
//   attest    Circle Iris sandbox attestation
//   mint      MessageTransmitterV2.receiveMessage on the destination, as soon as the wallet has gas there
// Re-running resumes from fixtures/live-arc-to-<chain>.json (it never burns twice).
// Usage: tsx scripts/live-arc-out.ts [toChain=robinhood-testnet] [amountUsdc=1]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { attestFromArc, burnFromArc, mintFromArc } from "../sdk/outbound";
import { ARC, CCTP_CHAINS, txUrl, type SourceChainKey } from "../sdk/chains";
import { json, loadKey, walletFor, withArcLock } from "./lib";

const TO = (process.argv[2] ?? "robinhood-testnet") as SourceChainKey;
const DST = CCTP_CHAINS[TO];
if (!DST || TO === ("arc-testnet" as SourceChainKey)) throw new Error(`unknown destination ${TO}`);
const OUT = new URL(`../fixtures/live-arc-to-${TO === "robinhood-testnet" ? "robinhood" : TO}.json`, import.meta.url);
type Rec = Record<string, unknown> & { burnTxHash?: Hex; nonce?: Hex; message?: Hex; attestation?: Hex; minted?: string; mintTxHash?: Hex };
const rec: Rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const save = () => writeFileSync(OUT, `${json(rec)}\n`);
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const pk = loadKey();
const arcWallet = walletFor("arc-testnet", pk);
const me = arcWallet.account!.address;

if (!rec.burnTxHash) {
  const amount = process.argv[3] ?? "1";
  const arcPub = createPublicClient({ transport: http(ARC.rpcUrl) });
  const burn = await withArcLock(async () => {
    const nonce = await arcPub.getTransactionCount({ address: me, blockTag: "pending" });
    return burnFromArc({ toChain: TO, amount, recipient: me, walletClient: arcWallet, nonce, onStatus: (s) => log(`status ${json(s)}`) });
  });
  Object.assign(rec, {
    network: `PUBLIC TESTNETS: Arc Testnet (5042002, CCTP domain 26) -> ${DST.name} (${DST.chainId}, domain ${DST.domain})`,
    route: "Circle CCTP V2 depositForBurn, destinationCaller 0 (any wallet completes it on the destination)",
    sender: me, ...burn, burnedAt: new Date().toISOString(),
  });
  save();
  log(`burn ${burn.burnUrl}`);
}

if (!rec.attestation) {
  const a = await attestFromArc(TO, rec.burnTxHash!, { onStatus: (s) => log(`status ${json(s)}`) });
  Object.assign(rec, { ...a, irisUrl: `https://iris-api-sandbox.circle.com/v2/messages/${ARC.domain}?transactionHash=${rec.burnTxHash}`, attestedAt: new Date().toISOString() });
  save();
  log(`attested nonce ${a.nonce}, ${a.minted} USDC6 to mint, finality ${a.finalityThresholdExecuted}`);
}

if (!rec.mintTxHash) {
  const dstPub = createPublicClient({ transport: http(DST.rpcUrl) });
  const gas = await dstPub.getBalance({ address: me });
  if (gas === 0n) {
    rec.mint = `PENDING: needs ${DST.gas} on ${DST.name} at the recipient for receiveMessage gas`;
    save();
    log(`mint pending: no ${DST.gas} on ${DST.name} yet`);
    process.exit(2);
  }
  const m = await mintFromArc(TO, { nonce: rec.nonce!, message: rec.message!, attestation: rec.attestation!, minted: BigInt(rec.minted!) }, walletFor(TO, pk), (s) => log(`status ${json(s)}`));
  Object.assign(rec, m, { mint: "done", mintedAt: new Date().toISOString() });
  save();
  log(`minted ${txUrl(TO, m.mintTxHash)}`);
}
