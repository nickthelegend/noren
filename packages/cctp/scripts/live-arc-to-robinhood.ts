// Live Arc Testnet -> Robinhood Chain Testnet USDC transfer with Circle CCTP V2.
//   burn      depositForBurn on Arc (under the shared-deployer lock, pending nonce)
//   attest    Circle Iris sandbox attestation
//   mint      MessageTransmitterV2.receiveMessage on Robinhood, as soon as the wallet has Robinhood ETH
// Re-running resumes from fixtures/live-arc-to-robinhood.json (it never burns twice).
// Usage: tsx scripts/live-arc-to-robinhood.ts [amountUsdc=1]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex } from "viem";
import { attestFromArc, burnFromArc, mintFromArc } from "../sdk/outbound";
import { ARC, CCTP_CHAINS, txUrl } from "../sdk/chains";
import { json, loadKey, walletFor, withArcLock } from "./lib";

const OUT = new URL("../fixtures/live-arc-to-robinhood.json", import.meta.url);
const RH = CCTP_CHAINS["robinhood-testnet"];
type Rec = Record<string, unknown> & { burnTxHash?: Hex; nonce?: Hex; message?: Hex; attestation?: Hex; minted?: string; mintTxHash?: Hex };
const rec: Rec = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const save = () => writeFileSync(OUT, `${json(rec)}\n`);
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

const pk = loadKey();
const arcWallet = walletFor("arc-testnet", pk);
const me = arcWallet.account!.address;

if (!rec.burnTxHash) {
  const amount = process.argv[2] ?? "1";
  const arcPub = createPublicClient({ transport: http(ARC.rpcUrl) });
  const burn = await withArcLock(async () => {
    const nonce = await arcPub.getTransactionCount({ address: me, blockTag: "pending" });
    return burnFromArc({ toChain: "robinhood-testnet", amount, recipient: me, walletClient: arcWallet, nonce, onStatus: (s) => log(`status ${json(s)}`) });
  });
  Object.assign(rec, {
    network: "PUBLIC TESTNETS: Arc Testnet (5042002, CCTP domain 26) -> Robinhood Chain Testnet (46630, domain 35)",
    route: "Circle CCTP V2 depositForBurn, destinationCaller 0 (any wallet completes it on Robinhood)",
    sender: me, ...burn, burnedAt: new Date().toISOString(),
  });
  save();
  log(`burn ${burn.burnUrl}`);
}

if (!rec.attestation) {
  const a = await attestFromArc("robinhood-testnet", rec.burnTxHash!, { onStatus: (s) => log(`status ${json(s)}`) });
  Object.assign(rec, { ...a, irisUrl: `https://iris-api-sandbox.circle.com/v2/messages/${ARC.domain}?transactionHash=${rec.burnTxHash}`, attestedAt: new Date().toISOString() });
  save();
  log(`attested nonce ${a.nonce}, ${a.minted} USDC6 to mint, finality ${a.finalityThresholdExecuted}`);
}

if (!rec.mintTxHash) {
  const rhPub = createPublicClient({ transport: http(RH.rpcUrl) });
  const gas = await rhPub.getBalance({ address: me });
  if (gas === 0n) {
    rec.mint = "PENDING: needs Robinhood Chain Testnet ETH at the recipient for receiveMessage gas";
    save();
    log("mint pending: no Robinhood testnet ETH yet");
    process.exit(2);
  }
  const m = await mintFromArc("robinhood-testnet", { nonce: rec.nonce!, message: rec.message!, attestation: rec.attestation!, minted: BigInt(rec.minted!) }, walletFor("robinhood-testnet", pk), (s) => log(`status ${json(s)}`));
  Object.assign(rec, m, { mint: "done", mintedAt: new Date().toISOString() });
  save();
  log(`minted ${txUrl("robinhood-testnet", m.mintTxHash)}`);
}
